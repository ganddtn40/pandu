use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use pandu_core::model::Session;
use pandu_core::replay::{FileChangeType, ReplaySnapshot, SnapshotKind};
use serde_json::json;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::error::{DaemonError, Result};
use crate::guards::GuardService;
use crate::live::LiveBus;
use crate::store::{NewFileChange, NewSnapshot, Store};

const MAX_STORED_FILES: usize = 500;
const MAX_FILE_DIFF_CHARS: usize = 300_000;
const MAX_PATCH_CHARS: usize = 2_000_000;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// A snapshot capture is a shadow commit of the working tree.
///
/// The user's index, HEAD, branch, and reflog are never touched: every git
/// command runs with a throwaway `GIT_INDEX_FILE` and snapshot commits are
/// unreferenced. A capture failure is logged and otherwise ignored, because
/// recording must never change proxy behaviour.
pub struct GitSnapshotService {
    store: Arc<Store>,
    live: Arc<LiveBus>,
    guards: Option<Arc<GuardService>>,
    workspace_path: Option<PathBuf>,
    snapshots_directory: PathBuf,
    queue: Mutex<()>,
    pending_steps: StdMutex<HashMap<String, String>>,
}

struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone)]
struct DiffEntry {
    path: String,
    old_path: Option<String>,
    change_type: FileChangeType,
    additions: u64,
    deletions: u64,
}

impl GitSnapshotService {
    pub fn new(
        store: Arc<Store>,
        live: Arc<LiveBus>,
        workspace_path: Option<PathBuf>,
        snapshots_directory: PathBuf,
        guards: Option<Arc<GuardService>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            live,
            guards,
            workspace_path,
            snapshots_directory,
            queue: Mutex::new(()),
            pending_steps: StdMutex::new(HashMap::new()),
        })
    }

    pub fn workspace_path(&self) -> Option<&Path> {
        self.workspace_path.as_deref()
    }

    /// Capture the tree before the first step. Cheap when a baseline already
    /// exists, because the service checks the stored snapshot list first.
    pub async fn ensure_baseline(&self, session: &Session) -> Result<()> {
        let _queue = self.queue.lock().await;
        if !self.store.list_snapshots(&session.id)?.is_empty() {
            return Ok(());
        }
        self.capture_base(session).await
    }

    /// Record that a step started. The previous step's snapshot is captured
    /// lazily so the tree is read after its tool side effects landed.
    pub fn note_step_started(self: &Arc<Self>, session_id: &str, step_id: &str) {
        // Remember the new step synchronously. If the first request is still
        // checking for a baseline, a later step must not be overwritten by it.
        let previous = {
            let mut pending = match self.pending_steps.lock() {
                Ok(pending) => pending,
                Err(_) => return,
            };
            pending.insert(session_id.to_string(), step_id.to_string())
        };

        let service = self.clone();
        let session = session_id.to_string();
        match previous {
            Some(previous_step) => {
                tokio::spawn(async move {
                    if let Err(error) = service
                        .capture_pending(&session, &previous_step, "step")
                        .await
                    {
                        tracing::warn!(
                            %error,
                            session_id = session,
                            "could not capture a git snapshot"
                        );
                    }
                });
            }
            None => {
                tokio::spawn(async move {
                    if let Err(error) = service.ensure_baseline_for(&session).await {
                        tracing::warn!(
                            %error,
                            session_id = session,
                            "could not capture a git snapshot"
                        );
                    }
                });
            }
        }
    }

    /// Capture the final pending step when a session ends.
    pub fn note_session_ended(self: &Arc<Self>, session_id: &str) {
        let pending = {
            let mut pending = match self.pending_steps.lock() {
                Ok(pending) => pending,
                Err(_) => return,
            };
            pending.remove(session_id)
        };
        let Some(step_id) = pending else {
            return;
        };

        let service = self.clone();
        let session = session_id.to_string();
        tokio::spawn(async move {
            if let Err(error) = service
                .capture_pending(&session, &step_id, "session end")
                .await
            {
                tracing::warn!(%error, session_id = session, "could not capture the final snapshot");
            }
        });
    }

    /// Wait for the previous step's snapshot before the next request begins.
    pub async fn settle_pending_step(&self, session_id: &str) -> Result<()> {
        let pending = {
            let mut pending = match self.pending_steps.lock() {
                Ok(pending) => pending,
                Err(_) => {
                    return Err(DaemonError::other(
                        "snapshot pending-step lock was poisoned",
                    ));
                }
            };
            pending.remove(session_id)
        };
        let Some(step_id) = pending else {
            return Ok(());
        };
        self.capture_pending(session_id, &step_id, "step").await
    }

    /// Capture every session that still has a pending step. Used at shutdown.
    pub async fn flush_all(&self) {
        let sessions: Vec<String> = match self.pending_steps.lock() {
            Ok(pending) => pending.keys().cloned().collect(),
            Err(_) => return,
        };
        for session_id in sessions {
            if let Err(error) = self.settle_pending_step(&session_id).await {
                tracing::warn!(%error, session_id, "could not flush a pending snapshot");
            }
        }
    }

    async fn ensure_baseline_for(&self, session_id: &str) -> Result<()> {
        let Some(session) = self.store.get_session(session_id)? else {
            return Ok(());
        };
        let _queue = self.queue.lock().await;
        if !self.store.list_snapshots(session_id)?.is_empty() {
            return Ok(());
        }
        self.capture_base(&session).await
    }

    async fn capture_pending(&self, session_id: &str, step_id: &str, label: &str) -> Result<()> {
        let Some(session) = self.store.get_session(session_id)? else {
            return Ok(());
        };
        let _queue = self.queue.lock().await;
        self.capture_after(&session, step_id, label).await
    }

    async fn capture_base(&self, session: &Session) -> Result<()> {
        let Some(workspace) = self.resolve_workspace(session).await else {
            return Ok(());
        };

        let head = self.resolve_head(&workspace).await?;
        let commit_sha = self
            .create_working_tree_commit(
                &workspace,
                head.as_deref(),
                &format!("pandu: baseline {}", session.id),
            )
            .await?;
        let branch = self
            .current_branch(&workspace)
            .await?
            .or_else(|| session.git_branch.clone());

        let snapshot = self.store.insert_snapshot(NewSnapshot {
            session_id: session.id.clone(),
            step_id: None,
            kind: SnapshotKind::Before,
            commit_sha: Some(commit_sha),
            parent_commit_sha: head.clone(),
            branch: branch.clone(),
            worktree_path: Some(workspace.display().to_string()),
            patch: None,
            files_changed: 0,
            insertions: 0,
            deletions: 0,
            created_at: None,
            file_changes: Vec::new(),
        })?;
        if let Err(error) =
            self.store
                .update_session_git(&session.id, branch.as_deref(), head.as_deref())
        {
            tracing::warn!(%error, session_id = session.id, "could not record session git state");
        }
        self.notify(snapshot);
        Ok(())
    }

    async fn capture_after(&self, session: &Session, step_id: &str, label: &str) -> Result<()> {
        let Some(workspace) = self.resolve_workspace(session).await else {
            return Ok(());
        };

        let mut snapshots = self.store.list_snapshots(&session.id)?;
        if snapshots.is_empty() {
            self.capture_base(session).await?;
            snapshots = self.store.list_snapshots(&session.id)?;
        }
        let Some(previous) = snapshots.last() else {
            return Ok(());
        };
        let Some(previous_commit) = previous.commit_sha.clone() else {
            return Ok(());
        };

        if !self.commit_exists(&workspace, &previous_commit).await? {
            tracing::debug!(
                session_id = session.id,
                commit = previous_commit,
                "previous snapshot commit is missing; recapturing the baseline"
            );
            self.capture_base(session).await?;
            return Ok(());
        }

        let commit_sha = self
            .create_working_tree_commit(
                &workspace,
                Some(&previous_commit),
                &format!("pandu: {label} {step_id} in {}", session.id),
            )
            .await?;
        let diff = self
            .diff_snapshots(&workspace, &previous_commit, &commit_sha)
            .await?;
        let branch = self
            .current_branch(&workspace)
            .await?
            .or_else(|| session.git_branch.clone());
        let valid_step_id = self
            .store
            .get_step(step_id)?
            .filter(|step| step.session_id == session.id)
            .map(|step| step.id);

        let snapshot = self.store.insert_snapshot(NewSnapshot {
            session_id: session.id.clone(),
            step_id: valid_step_id,
            kind: SnapshotKind::After,
            commit_sha: Some(commit_sha),
            parent_commit_sha: Some(previous_commit),
            branch,
            worktree_path: Some(workspace.display().to_string()),
            patch: (!diff.patch.is_empty()).then_some(diff.patch),
            files_changed: diff.files_changed,
            insertions: diff.insertions,
            deletions: diff.deletions,
            created_at: None,
            file_changes: diff.files,
        })?;
        self.notify(snapshot);
        Ok(())
    }

    fn notify(&self, snapshot: ReplaySnapshot) {
        self.live.publish(
            "snapshot.created",
            Some(&snapshot.session_id),
            snapshot.step_id.as_deref(),
            json!({
                "snapshotId": snapshot.id,
                "kind": snapshot.kind,
                "filesChanged": snapshot.files_changed,
                "insertions": snapshot.insertions,
                "deletions": snapshot.deletions,
            }),
        );
        if let Some(guards) = &self.guards {
            guards.schedule_scan(&snapshot.session_id, Duration::from_millis(750));
        }
    }

    async fn resolve_workspace(&self, session: &Session) -> Option<PathBuf> {
        let candidate = session
            .workspace_path
            .as_deref()
            .map(PathBuf::from)
            .or_else(|| self.workspace_path.clone())?;
        if !candidate.is_dir() {
            return None;
        }

        let output = self
            .run_git(&candidate, &["rev-parse", "--show-toplevel"], None)
            .await
            .ok()?;
        if !output.success {
            return None;
        }
        let root = output.stdout.trim();
        if root.is_empty() {
            return None;
        }
        let root = PathBuf::from(root);
        Some(if root.is_absolute() {
            root
        } else {
            candidate.join(root)
        })
    }

    async fn resolve_head(&self, root: &Path) -> Result<Option<String>> {
        let output = self
            .run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"], None)
            .await?;
        if !output.success {
            return Ok(None);
        }
        let sha = output.stdout.trim();
        Ok(is_commit_sha(sha).then(|| sha.to_string()))
    }

    async fn current_branch(&self, root: &Path) -> Result<Option<String>> {
        let output = self
            .run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"], None)
            .await?;
        if !output.success {
            return Ok(None);
        }
        let branch = output.stdout.trim();
        Ok((!branch.is_empty() && branch != "HEAD").then(|| branch.to_string()))
    }

    async fn commit_exists(&self, root: &Path, sha: &str) -> Result<bool> {
        let output = self
            .run_git(
                root,
                &["cat-file", "-e", &format!("{sha}^{{commit}}")],
                None,
            )
            .await?;
        Ok(output.success)
    }

    async fn create_working_tree_commit(
        &self,
        root: &Path,
        parent: Option<&str>,
        message: &str,
    ) -> Result<String> {
        tokio::fs::create_dir_all(&self.snapshots_directory)
            .await
            .map_err(|error| {
                DaemonError::other(format!("could not create the snapshot directory: {error}"))
            })?;
        let index_path = self
            .snapshots_directory
            .join(format!("index-{}", uuid::Uuid::new_v4()));
        let index_value = index_path.display().to_string();
        let env = [
            ("GIT_INDEX_FILE", index_value.as_str()),
            ("GIT_AUTHOR_NAME", "Pandu"),
            ("GIT_AUTHOR_EMAIL", "pandu@localhost"),
            ("GIT_COMMITTER_NAME", "Pandu"),
            ("GIT_COMMITTER_EMAIL", "pandu@localhost"),
        ];

        let result = async {
            let add = self
                .run_git(root, &["add", "-A", "--", "."], Some(&env))
                .await?;
            if !add.success {
                return Err(git_failure("git add", &add));
            }
            let tree = self.run_git(root, &["write-tree"], Some(&env)).await?;
            if !tree.success {
                return Err(git_failure("git write-tree", &tree));
            }
            let tree = tree.stdout.trim().to_string();
            if tree.is_empty() {
                return Err(DaemonError::other("git returned an empty tree"));
            }

            let sanitized = message.split_whitespace().collect::<Vec<_>>().join(" ");
            let sanitized: String = sanitized.chars().take(500).collect();
            let mut args = vec!["commit-tree", tree.as_str(), "-m", sanitized.as_str()];
            if let Some(parent) = parent {
                args.push("-p");
                args.push(parent);
            }
            let commit = self.run_git(root, &args, Some(&env)).await?;
            if !commit.success {
                return Err(git_failure("git commit-tree", &commit));
            }
            let sha = commit.stdout.trim().to_string();
            if !is_commit_sha(&sha) {
                return Err(DaemonError::other(
                    "git did not return a valid snapshot commit",
                ));
            }
            Ok(sha)
        }
        .await;

        if let Err(error) = tokio::fs::remove_file(&index_path).await {
            tracing::debug!(%error, path = %index_path.display(), "could not remove the temporary git index");
        }
        result
    }

    async fn diff_snapshots(
        &self,
        root: &Path,
        parent: &str,
        commit: &str,
    ) -> Result<SnapshotDiff> {
        let name_status = self
            .run_git(
                root,
                &[
                    "diff",
                    "--name-status",
                    "-z",
                    "--find-renames",
                    "--no-ext-diff",
                    parent,
                    commit,
                ],
                None,
            )
            .await?;
        if !name_status.success {
            return Err(git_failure("git diff --name-status", &name_status));
        }
        let numstat = self
            .run_git(
                root,
                &[
                    "diff",
                    "--numstat",
                    "-z",
                    "--find-renames",
                    "--no-ext-diff",
                    parent,
                    commit,
                ],
                None,
            )
            .await?;
        if !numstat.success {
            return Err(git_failure("git diff --numstat", &numstat));
        }

        let entries = parse_name_status(&name_status.stdout);
        let stats = parse_numstat(&numstat.stdout);
        let mut files: Vec<DiffEntry> = entries
            .into_iter()
            .map(|entry| {
                let stat = stats.get(&entry.path).copied().unwrap_or_default();
                DiffEntry {
                    path: entry.path,
                    old_path: entry.old_path,
                    change_type: entry.change_type,
                    additions: stat.0,
                    deletions: stat.1,
                }
            })
            .collect();

        let files_changed = files.len() as u64;
        let insertions = files.iter().map(|file| file.additions).sum();
        let deletions = files.iter().map(|file| file.deletions).sum();

        let mut stored = Vec::new();
        let mut patch = String::new();
        for entry in files.drain(..).take(MAX_STORED_FILES) {
            let diff = match self.diff_one(root, parent, commit, &entry).await {
                Ok(diff) => diff,
                Err(error) => {
                    tracing::warn!(%error, path = entry.path, "could not read a file diff");
                    String::new()
                }
            };
            let diff = clip(&diff, MAX_FILE_DIFF_CHARS);
            patch.push_str(&diff);
            stored.push(NewFileChange {
                path: entry.path,
                old_path: entry.old_path,
                change_type: entry.change_type,
                additions: entry.additions,
                deletions: entry.deletions,
                diff: (!diff.is_empty()).then_some(diff),
                ai_authored: None,
            });
        }

        Ok(SnapshotDiff {
            patch: clip(&patch, MAX_PATCH_CHARS),
            files: stored,
            files_changed,
            insertions,
            deletions,
        })
    }

    async fn diff_one(
        &self,
        root: &Path,
        parent: &str,
        commit: &str,
        entry: &DiffEntry,
    ) -> Result<String> {
        let mut args: Vec<String> = vec![
            "diff".to_string(),
            "--no-color".to_string(),
            "--no-ext-diff".to_string(),
            "--unified=3".to_string(),
            "--find-renames".to_string(),
            parent.to_string(),
            commit.to_string(),
            "--".to_string(),
        ];
        match entry.old_path.as_deref() {
            Some(old_path) if old_path != entry.path => {
                args.push(format!(":(literal){old_path}"));
                args.push(format!(":(literal){}", entry.path));
            }
            _ => args.push(format!(":(literal){}", entry.path)),
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = self.run_git(root, &refs, None).await?;
        if !output.success {
            return Err(git_failure("git diff", &output));
        }
        Ok(output.stdout)
    }

    async fn run_git(
        &self,
        cwd: &Path,
        args: &[&str],
        env: Option<&[(&str, &str)]>,
    ) -> Result<GitOutput> {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(env) = env {
            for (key, value) in env {
                command.env(key, value);
            }
        }

        let output = match tokio::time::timeout(GIT_TIMEOUT, command.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                return Err(DaemonError::other(format!(
                    "could not run git {}: {error}",
                    args.first().copied().unwrap_or("")
                )));
            }
            Err(_) => {
                return Err(DaemonError::other(format!(
                    "git {} timed out after {} seconds",
                    args.first().copied().unwrap_or(""),
                    GIT_TIMEOUT.as_secs()
                )));
            }
        };

        Ok(GitOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    }
}

struct SnapshotDiff {
    patch: String,
    files: Vec<NewFileChange>,
    files_changed: u64,
    insertions: u64,
    deletions: u64,
}

struct NameStatusEntry {
    path: String,
    old_path: Option<String>,
    change_type: FileChangeType,
}

fn is_commit_sha(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn git_failure(command: &str, output: &GitOutput) -> DaemonError {
    let stderr = output.stderr.trim();
    if stderr.is_empty() {
        DaemonError::other(format!("{command} failed"))
    } else {
        DaemonError::other(format!("{command} failed: {}", truncate(stderr, 500)))
    }
}

fn truncate(value: &str, maximum: usize) -> String {
    if value.chars().count() <= maximum {
        return value.to_string();
    }
    value.chars().take(maximum).collect()
}

fn clip(text: &str, maximum: usize) -> String {
    if text.len() <= maximum {
        return text.to_string();
    }
    let mut end = maximum;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… diff truncated by Pandu …\n", &text[..end])
}

fn parse_name_status(output: &str) -> Vec<NameStatusEntry> {
    let tokens: Vec<&str> = output.split('\0').collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let status = tokens[index];
        index += 1;
        if status.is_empty() {
            continue;
        }
        let letter = status.chars().next().unwrap_or('M');
        if letter == 'R' || letter == 'C' {
            let old_path = tokens.get(index).copied().unwrap_or_default();
            let new_path = tokens.get(index + 1).copied().unwrap_or_default();
            index += 2;
            if old_path.is_empty() || new_path.is_empty() {
                continue;
            }
            entries.push(NameStatusEntry {
                path: new_path.to_string(),
                old_path: Some(old_path.to_string()),
                change_type: if letter == 'R' {
                    FileChangeType::Renamed
                } else {
                    FileChangeType::Added
                },
            });
            continue;
        }
        let path = tokens.get(index).copied().unwrap_or_default();
        index += 1;
        if path.is_empty() {
            continue;
        }
        entries.push(NameStatusEntry {
            path: path.to_string(),
            old_path: None,
            change_type: match letter {
                'A' => FileChangeType::Added,
                'D' => FileChangeType::Deleted,
                _ => FileChangeType::Modified,
            },
        });
    }
    entries
}

fn parse_numstat(output: &str) -> HashMap<String, (u64, u64)> {
    let tokens: Vec<&str> = output.split('\0').collect();
    let mut entries = HashMap::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        if token.is_empty() {
            continue;
        }
        let parts: Vec<&str> = token.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let additions = if parts[0] == "-" {
            0
        } else {
            parts[0].parse::<u64>().unwrap_or(0)
        };
        let deletions = if parts[1] == "-" {
            0
        } else {
            parts[1].parse::<u64>().unwrap_or(0)
        };
        let mut path = parts[2].to_string();
        if path.is_empty() {
            // Renames and copies carry the old and new path in two extra tokens.
            index += 1;
            path = tokens.get(index).copied().unwrap_or_default().to_string();
            index += 1;
        }
        if path.is_empty() {
            continue;
        }
        entries.insert(path, (additions, deletions));
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "Pandu Test")
            .env("GIT_AUTHOR_EMAIL", "pandu@example.com")
            .env("GIT_COMMITTER_NAME", "Pandu Test")
            .env("GIT_COMMITTER_EMAIL", "pandu@example.com")
            .output()
            .expect("git is required for the snapshot tests");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn parses_name_status_with_renames() {
        let entries =
            parse_name_status("M\0src/a.rs\0R100\0src/old.rs\0src/new.rs\0A\0docs/x.md\0");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "src/a.rs");
        assert_eq!(entries[0].change_type, FileChangeType::Modified);
        assert_eq!(entries[1].change_type, FileChangeType::Renamed);
        assert_eq!(entries[1].old_path.as_deref(), Some("src/old.rs"));
        assert_eq!(entries[2].change_type, FileChangeType::Added);
    }

    #[test]
    fn parses_numstat_with_renames() {
        let stats = parse_numstat(concat!(
            "10\t2\tsrc/a.rs\0",
            "4\t1\t\0",
            "src/old.rs\0",
            "src/new.rs\0",
        ));
        assert_eq!(stats.get("src/a.rs"), Some(&(10, 2)));
        assert_eq!(stats.get("src/new.rs"), Some(&(4, 1)));
    }

    #[test]
    fn clips_on_character_boundaries() {
        let clipped = clip("abcdéfg", 5);
        assert!(clipped.starts_with("abcd"));
        assert!(clipped.contains("truncated"));
    }

    #[test]
    fn validates_commit_shas() {
        assert!(is_commit_sha("abcdef1"));
        assert!(!is_commit_sha("HEAD"));
        assert!(!is_commit_sha(""));
    }

    #[tokio::test]
    async fn captures_shadow_commits_without_touching_the_user_repository() {
        use std::fs;

        use pandu_core::model::{CaptureMode, SessionSource};

        use crate::store::{NewSession, Store};

        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("tracked.txt"), "one\n").unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["add", "tracked.txt"]);
        git(&repo, &["commit", "-q", "-m", "initial"]);

        // `git status` may refresh the index, so run it before checksumming.
        assert!(git(&repo, &["status", "--porcelain"]).is_empty());
        let head_before = git(&repo, &["rev-parse", "HEAD"]);
        let index_path = repo.join(".git/index");
        let index_before = fs::read(&index_path).unwrap();
        let reflog_path = repo.join(".git/logs/HEAD");
        let reflog_before = fs::read(&reflog_path).unwrap();

        let store = Arc::new(Store::open(":memory:").unwrap());
        let live = LiveBus::new(store.clone(), 0);
        let snapshots_dir = home.path().join("snapshots");
        let service =
            GitSnapshotService::new(store.clone(), live, None, snapshots_dir.clone(), None);
        let session = store
            .create_session(NewSession {
                title: "Snapshot flight".to_string(),
                source: SessionSource::Proxy,
                capture_mode: CaptureMode::Proxy,
                workspace_path: Some(repo.display().to_string()),
                ..NewSession::default()
            })
            .unwrap();

        service.capture_base(&session).await.unwrap();
        fs::write(repo.join("tracked.txt"), "two\n").unwrap();
        fs::write(repo.join("new.txt"), "hello\n").unwrap();
        service
            .capture_after(&session, "not-a-step", "step")
            .await
            .unwrap();

        // The user's branch, index, and reflog are byte-for-byte unchanged.
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head_before);
        assert_eq!(fs::read(&index_path).unwrap(), index_before);
        assert_eq!(fs::read(&reflog_path).unwrap(), reflog_before);
        let status = git(&repo, &["status", "--porcelain"]);
        assert!(status.contains("tracked.txt"), "status was {status:?}");
        assert!(status.contains("new.txt"), "status was {status:?}");

        let snapshots = store.list_snapshots(&session.id).unwrap();
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[0].kind, SnapshotKind::Before);
        assert_eq!(snapshots[1].kind, SnapshotKind::After);
        let base = snapshots[0].commit_sha.clone().unwrap();
        assert_eq!(
            snapshots[1].parent_commit_sha.as_deref(),
            Some(base.as_str())
        );
        assert_eq!(snapshots[1].files_changed, 2);
        assert_eq!(snapshots[1].insertions, 2);
        assert_eq!(snapshots[1].deletions, 1);
        let patch = snapshots[1].patch.as_deref().unwrap();
        assert!(patch.contains("+two"), "patch was {patch:?}");
        assert!(patch.contains("+hello"), "patch was {patch:?}");

        let changes = store.list_snapshot_file_changes(&snapshots[1].id).unwrap();
        assert_eq!(changes.len(), 2);
        assert!(changes.iter().any(|change| {
            change.path == "tracked.txt" && change.change_type == FileChangeType::Modified
        }));
        assert!(changes.iter().any(|change| {
            change.path == "new.txt" && change.change_type == FileChangeType::Added
        }));

        // Shadow commits are unreferenced, so they never enter history.
        let history = git(&repo, &["rev-list", "--all"]);
        assert!(!history.split_whitespace().any(|sha| sha == base));

        // Temporary indexes are always removed, even on success.
        let leftovers = fs::read_dir(&snapshots_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("index-"))
            .count();
        assert_eq!(leftovers, 0);
    }
}
