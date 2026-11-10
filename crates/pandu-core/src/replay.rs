use serde::{Deserialize, Serialize};

use crate::model::{Session, Step};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotKind {
    Before,
    After,
    Fork,
    Checkpoint,
}

impl SnapshotKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Before => "before",
            Self::After => "after",
            Self::Fork => "fork",
            Self::Checkpoint => "checkpoint",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "before" => Some(Self::Before),
            "after" => Some(Self::After),
            "fork" => Some(Self::Fork),
            "checkpoint" => Some(Self::Checkpoint),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
}

impl FileChangeType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "added" => Some(Self::Added),
            "modified" => Some(Self::Modified),
            "deleted" => Some(Self::Deleted),
            "renamed" => Some(Self::Renamed),
            _ => None,
        }
    }
}

/// A point-in-time capture of the working tree.
///
/// Snapshots are shadow git commits. They are deliberately unreferenced, so a
/// capture can never move the user's branch, index, or reflog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySnapshot {
    pub id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub kind: SnapshotKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_commit_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    #[serde(default)]
    pub files_changed: u64,
    #[serde(default)]
    pub insertions: u64,
    #[serde(default)]
    pub deletions: u64,
    pub created_at: String,
}

impl ReplaySnapshot {
    /// The replay list shows metadata only; patches can be megabytes.
    pub fn summary(&self) -> Self {
        let mut summary = self.clone();
        summary.patch = None;
        summary
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayFileChange {
    pub id: String,
    pub snapshot_id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub change_type: FileChangeType,
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_authored: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayForkStatus {
    Creating,
    Ready,
    Error,
    Removed,
}

/// Replay forks are not implemented in 0.2.0. The type stays here so the
/// replay response keeps its 0.1.0 shape and older clients can parse it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayFork {
    pub id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub branch: String,
    pub worktree_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    pub resume_brief: String,
    pub status: ReplayForkStatus,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayResponse {
    pub session: Session,
    pub steps: Vec<Step>,
    pub snapshots: Vec<ReplaySnapshot>,
    pub forks: Vec<ReplayFork>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotDetailResponse {
    pub snapshot: ReplaySnapshot,
    pub file_changes: Vec<ReplayFileChange>,
}
