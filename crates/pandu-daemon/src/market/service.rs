//! The market service: verified registry loading, cached refresh, catalog
//! projection, previews, and installed-entry state.
//!
//! Network access happens only on an explicit refresh or install action, or on
//! the opt-in daily refresh. A failed refresh never discards a verified cache;
//! a failed signature check never falls back to an unverified copy.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use pandu_core::adapter::AdapterRegistry;
use serde::{Deserialize, Serialize};

use super::archive::{ExtractedFile, read_local_tree, verify_tree};
use super::install::{
    self, InstallManifest, InstallOutcome, InstallPreview, InstallState, InstalledSummary,
    PREVIEW_TTL, PreviewInputs, PreviewPlan, UndoOutcome, UninstallOutcome, UninstallPreview,
    now_iso,
};
use super::registry_check::fetch_tree;
use super::targets::{self, TargetContext};
use super::{
    ACTIVE_INDEX_FILE, ACTIVE_REVOKED_FILE, InstallScope, LoadedRegistry, MAX_ENTRY_BYTES,
    MarketEntry, MarketError, MarketKind, MarketPermission, PREPARING_MESSAGE,
    PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64, Reviewer, SignedIndex, SignedRevocation, TrustRoot,
    TrustTier, load_registry_dir, parse_registry, resolve_trust_root, sanitize_markdown,
    verify_index, verify_revocation,
};
use pandu_core::ids::create_id;

pub const SETTINGS_FILE: &str = "settings.json";
pub const DEFAULT_REGISTRY_URL: &str = pandu_core::brand::REGISTRY_URL;
pub const DAILY_REFRESH_SECS: i64 = 24 * 60 * 60;
/// A cached registry older than this may miss new revocations.
pub const CACHE_STALE_AFTER_SECS: i64 = 7 * 24 * 60 * 60;

#[cfg(debug_assertions)]
const BUNDLED_INDEX: &str = include_str!("../../../../registry/index.test.json");
#[cfg(not(debug_assertions))]
const BUNDLED_INDEX: &str = include_str!("../../../../registry/index.json");
#[cfg(debug_assertions)]
const BUNDLED_REVOKED: &str = include_str!("../../../../registry/revoked.test.json");
#[cfg(not(debug_assertions))]
const BUNDLED_REVOKED: &str = include_str!("../../../../registry/revoked.json");
const BUNDLED_ENTRIES: &[(&str, &str)] = &[
    (
        "skills/algorithmic-art.yaml",
        include_str!("../../../../registry/skills/algorithmic-art.yaml"),
    ),
    (
        "skills/brand-guidelines.yaml",
        include_str!("../../../../registry/skills/brand-guidelines.yaml"),
    ),
    (
        "skills/canvas-design.yaml",
        include_str!("../../../../registry/skills/canvas-design.yaml"),
    ),
    (
        "skills/example-changelog-writer.yaml",
        include_str!("../../../../registry/skills/example-changelog-writer.yaml"),
    ),
    (
        "skills/example-commit-messages.yaml",
        include_str!("../../../../registry/skills/example-commit-messages.yaml"),
    ),
    (
        "skills/frontend-design.yaml",
        include_str!("../../../../registry/skills/frontend-design.yaml"),
    ),
    (
        "skills/internal-comms.yaml",
        include_str!("../../../../registry/skills/internal-comms.yaml"),
    ),
    (
        "skills/mcp-builder.yaml",
        include_str!("../../../../registry/skills/mcp-builder.yaml"),
    ),
    (
        "skills/skill-creator.yaml",
        include_str!("../../../../registry/skills/skill-creator.yaml"),
    ),
    (
        "skills/slack-gif-creator.yaml",
        include_str!("../../../../registry/skills/slack-gif-creator.yaml"),
    ),
    (
        "skills/theme-factory.yaml",
        include_str!("../../../../registry/skills/theme-factory.yaml"),
    ),
    (
        "skills/web-artifacts-builder.yaml",
        include_str!("../../../../registry/skills/web-artifacts-builder.yaml"),
    ),
    (
        "skills/webapp-testing.yaml",
        include_str!("../../../../registry/skills/webapp-testing.yaml"),
    ),
    (
        "mcp/context7.yaml",
        include_str!("../../../../registry/mcp/context7.yaml"),
    ),
    (
        "mcp/example-weather.yaml",
        include_str!("../../../../registry/mcp/example-weather.yaml"),
    ),
    (
        "mcp/fetch.yaml",
        include_str!("../../../../registry/mcp/fetch.yaml"),
    ),
    (
        "mcp/git.yaml",
        include_str!("../../../../registry/mcp/git.yaml"),
    ),
    (
        "mcp/github-mcp-remote.yaml",
        include_str!("../../../../registry/mcp/github-mcp-remote.yaml"),
    ),
    (
        "mcp/github-mcp-server.yaml",
        include_str!("../../../../registry/mcp/github-mcp-server.yaml"),
    ),
    (
        "mcp/playwright.yaml",
        include_str!("../../../../registry/mcp/playwright.yaml"),
    ),
    (
        "mcp/sequential-thinking.yaml",
        include_str!("../../../../registry/mcp/sequential-thinking.yaml"),
    ),
    (
        "mcp/time.yaml",
        include_str!("../../../../registry/mcp/time.yaml"),
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RegistrySource {
    Environment,
    Cache,
    Repo,
    Bundled,
    Network,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSettings {
    #[serde(default)]
    pub auto_refresh: bool,
    #[serde(default)]
    pub last_refresh: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSupport {
    pub agent: String,
    pub name: String,
    pub scopes: Vec<InstallScope>,
    pub verified: bool,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCard {
    pub id: String,
    pub kind: MarketKind,
    pub name: String,
    pub version: String,
    pub short_description: String,
    pub long_description: String,
    pub categories: Vec<String>,
    pub tags: Vec<String>,
    pub agents: Vec<String>,
    pub license: String,
    pub trust: TrustTier,
    pub reviewer: Option<Reviewer>,
    pub reviewed_on: Option<String>,
    pub homepage: Option<String>,
    pub permissions: Vec<MarketPermission>,
    pub example: bool,
    pub revoked: bool,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub latest_version: String,
    pub support: Vec<AgentSupport>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDetail {
    #[serde(flatten)]
    pub card: MarketCard,
    pub source: super::MarketSource,
    pub readme: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub entries: Vec<MarketCard>,
    pub categories: Vec<String>,
    pub agents: Vec<String>,
    pub generated_at: Option<String>,
    pub source: RegistrySource,
    pub offline: bool,
    pub warnings: Vec<String>,
    pub last_error: Option<String>,
    /// True when a release build has no production trust root yet. The
    /// catalogue is empty and no entry is exposed.
    pub preparing: bool,
    pub settings: MarketSettings,
    pub counts: CatalogCounts,
    pub cache_verified_at: Option<String>,
    pub cache_age_seconds: Option<i64>,
    pub cache_stale: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCounts {
    pub skills: usize,
    pub mcp: usize,
    pub installed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledResponse {
    pub installs: Vec<InstalledSummary>,
    pub source: RegistrySource,
    pub offline: bool,
    pub warnings: Vec<String>,
    pub last_error: Option<String>,
}

struct State {
    registry: Option<Arc<LoadedRegistry>>,
    source: RegistrySource,
    offline: bool,
    last_error: Option<String>,
    warnings: Vec<String>,
    settings: MarketSettings,
    previews: HashMap<String, PreviewPlan>,
    trees: HashMap<String, Vec<ExtractedFile>>,
}

pub struct MarketService {
    home: PathBuf,
    user_home: PathBuf,
    workspace: Option<PathBuf>,
    adapters: Arc<AdapterRegistry>,
    client: reqwest::Client,
    include_examples: bool,
    forced_offline: bool,
    local_source: Option<PathBuf>,
    registry_url: String,
    trust_root: TrustRoot,
    state: Mutex<State>,
}

impl MarketService {
    pub fn new(
        home: PathBuf,
        user_home: PathBuf,
        workspace: Option<PathBuf>,
        adapters: Arc<AdapterRegistry>,
        client: reqwest::Client,
    ) -> Arc<Self> {
        let forced_offline = cfg!(debug_assertions)
            && std::env::var(pandu_core::brand::env_name("MARKET_OFFLINE")).as_deref() == Ok("1");
        let include_examples = cfg!(debug_assertions)
            && std::env::var(pandu_core::brand::env_name("MARKET_EXAMPLES")).as_deref() != Ok("0");
        let local_source = if cfg!(debug_assertions) {
            std::env::var_os(pandu_core::brand::env_name("MARKET_LOCAL_SOURCE")).map(PathBuf::from)
        } else {
            None
        };
        let registry_url = debug_only(
            cfg!(debug_assertions),
            std::env::var(pandu_core::brand::env_name("MARKET_REGISTRY_URL")).ok(),
        )
        .filter(|value| validate_registry_url(value).is_ok())
        .unwrap_or_else(|| DEFAULT_REGISTRY_URL.to_string());
        let trust_root = resolve_trust_root(
            cfg!(debug_assertions),
            PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64,
        );
        let settings = load_settings(&home);
        let mut warnings = Vec::new();
        if let Err(error) = install::recover_installs(&home, &user_home, workspace.as_deref()) {
            warnings.push(format!(
                "An interrupted install could not be recovered: {error}"
            ));
        }
        Arc::new(Self {
            home,
            user_home,
            workspace,
            adapters,
            client,
            include_examples,
            forced_offline,
            local_source,
            registry_url,
            trust_root,
            state: Mutex::new(State {
                registry: None,
                source: RegistrySource::Bundled,
                offline: forced_offline,
                last_error: None,
                warnings,
                settings,
                previews: HashMap::new(),
                trees: HashMap::new(),
            }),
        })
    }

    /// Integration-test constructor. It takes an explicit user home and,
    /// optionally, an already verified registry so tests never depend on
    /// process environment variables or the developer's real home directory.
    /// It is always offline: tests that exercise the network use a mock
    /// registry through the CLI or the HTTP surface instead.
    #[doc(hidden)]
    pub fn for_test(
        home: PathBuf,
        user_home: PathBuf,
        workspace: Option<PathBuf>,
        adapters: Arc<AdapterRegistry>,
        registry: Option<LoadedRegistry>,
        local_source: Option<PathBuf>,
    ) -> Arc<Self> {
        let settings = load_settings(&home);
        let mut warnings = Vec::new();
        if let Err(error) = install::recover_installs(&home, &user_home, workspace.as_deref()) {
            warnings.push(format!(
                "An interrupted install could not be recovered: {error}"
            ));
        }
        Arc::new(Self {
            home,
            user_home,
            workspace,
            adapters,
            client: reqwest::Client::new(),
            include_examples: true,
            forced_offline: true,
            local_source,
            registry_url: DEFAULT_REGISTRY_URL.to_string(),
            trust_root: TrustRoot::Ready,
            state: Mutex::new(State {
                registry: registry.map(Arc::new),
                source: RegistrySource::Cache,
                offline: true,
                last_error: None,
                warnings,
                settings,
                previews: HashMap::new(),
                trees: HashMap::new(),
            }),
        })
    }

    pub fn settings(&self) -> MarketSettings {
        self.state.lock().expect("market state").settings.clone()
    }

    pub fn trust_root(&self) -> TrustRoot {
        self.trust_root
    }

    fn require_trust_root(&self) -> Result<(), MarketError> {
        match self.trust_root {
            TrustRoot::Ready => Ok(()),
            TrustRoot::Preparing => Err(MarketError::Preparing),
            TrustRoot::Refused => Err(MarketError::Signature(
                "This release build embedded the test registry key. Pandu refuses to open the \
                 market with a test trust root."
                    .into(),
            )),
        }
    }

    pub fn set_auto_refresh(&self, enabled: bool) -> Result<MarketSettings, MarketError> {
        let mut state = self.state.lock().expect("market state");
        state.settings.auto_refresh = enabled;
        save_settings(&self.home, &state.settings)?;
        Ok(state.settings.clone())
    }

    async fn ensure_registry(
        &self,
        allow_network: bool,
    ) -> Result<Arc<LoadedRegistry>, MarketError> {
        self.require_trust_root()?;
        {
            let state = self.state.lock().expect("market state");
            if let Some(registry) = &state.registry {
                return Ok(registry.clone());
            }
        }

        let settings = self.settings();
        if allow_network && !self.forced_offline && settings.auto_refresh && refresh_due(&settings)
        {
            if let Err(error) = self.refresh_inner().await {
                let mut state = self.state.lock().expect("market state");
                state.last_error = Some(error.to_string());
                state.offline = true;
            }
        }

        let (registry, source, warnings) = self.load_best_registry()?;
        let mut state = self.state.lock().expect("market state");
        state.registry = Some(registry.clone());
        state.source = source;
        state.offline = self.forced_offline || (source == RegistrySource::Cache && state.offline);
        state.warnings = warnings;
        Ok(registry)
    }

    fn load_best_registry(
        &self,
    ) -> Result<(Arc<LoadedRegistry>, RegistrySource, Vec<String>), MarketError> {
        if let Some(dir) = debug_only(
            cfg!(debug_assertions),
            std::env::var_os(pandu_core::brand::env_name("MARKET_REGISTRY")).map(PathBuf::from),
        ) {
            let registry = load_registry_dir(&dir, self.include_examples)?;
            return Ok((
                Arc::new(registry),
                RegistrySource::Environment,
                vec![format!("Using the registry at {}.", dir.display())],
            ));
        }
        let cache = self.home.join("market").join("registry");
        recover_cache(&self.home);
        if cache.join(ACTIVE_INDEX_FILE).exists() {
            let registry = load_registry_dir(&cache, self.include_examples)?;
            return Ok((Arc::new(registry), RegistrySource::Cache, Vec::new()));
        }
        if cfg!(debug_assertions) {
            if let Some(dir) = repo_registry_dir() {
                let registry = load_registry_dir(&dir, self.include_examples)?;
                return Ok((
                    Arc::new(registry),
                    RegistrySource::Repo,
                    vec!["Using the development registry bundled with this build.".into()],
                ));
            }
        }
        let registry = parse_registry(
            BUNDLED_INDEX.as_bytes(),
            BUNDLED_REVOKED.as_bytes(),
            self.include_examples,
            |path| {
                BUNDLED_ENTRIES
                    .iter()
                    .find(|(candidate, _)| *candidate == path)
                    .map(|(_, contents)| contents.as_bytes().to_vec())
                    .ok_or_else(|| {
                        MarketError::Registry(format!("The built-in registry is missing `{path}`."))
                    })
            },
        )?;
        Ok((Arc::new(registry), RegistrySource::Bundled, Vec::new()))
    }

    /// When the catalogue comes from the on-disk cache, report when that cache
    /// was last verified. A successful refresh records `last_refresh`; older
    /// caches without that setting fall back to the index file's mtime.
    fn cache_verified_at(
        &self,
        source: RegistrySource,
        last_refresh: Option<&str>,
    ) -> Option<String> {
        if source != RegistrySource::Cache {
            return None;
        }
        if let Some(last) = last_refresh {
            if DateTime::parse_from_rfc3339(last).is_ok() {
                return Some(last.to_string());
            }
        }
        let index = self
            .home
            .join("market")
            .join("registry")
            .join(ACTIVE_INDEX_FILE);
        let modified = std::fs::metadata(index).ok()?.modified().ok()?;
        Some(DateTime::<Utc>::from(modified).to_rfc3339())
    }

    async fn refresh_inner(&self) -> Result<(), MarketError> {
        self.require_trust_root()?;
        if self.forced_offline {
            return Err(MarketError::Network(
                "Pandu is in offline mode. Disable PANDU_MARKET_OFFLINE to refresh.".into(),
            ));
        }
        validate_registry_url(&self.registry_url)?;
        let base = self.registry_url.trim_end_matches('/');
        let index_bytes = fetch_limited(
            &self.client,
            &format!("{base}/{ACTIVE_INDEX_FILE}"),
            4 * 1024 * 1024,
        )
        .await?;
        let revoked_bytes = fetch_limited(
            &self.client,
            &format!("{base}/{ACTIVE_REVOKED_FILE}"),
            2 * 1024 * 1024,
        )
        .await?;
        let index: SignedIndex = serde_json::from_slice(&index_bytes).map_err(|error| {
            MarketError::Registry(format!("The downloaded index is not valid JSON: {error}"))
        })?;
        verify_index(&index)?;
        let revoked: SignedRevocation =
            serde_json::from_slice(&revoked_bytes).map_err(|error| {
                MarketError::Registry(format!(
                    "The downloaded revocation list is not valid JSON: {error}"
                ))
            })?;
        verify_revocation(&revoked)?;

        let mut entries = Vec::new();
        for indexed in &index.entries {
            let bytes = fetch_limited(
                &self.client,
                &format!("{base}/{}", indexed.path),
                MAX_ENTRY_BYTES,
            )
            .await?;
            entries.push((indexed.path.clone(), bytes));
        }
        // Parse everything before writing anything. A bad download leaves the
        // previous verified cache untouched.
        let registry = parse_registry(
            &index_bytes,
            &revoked_bytes,
            self.include_examples,
            |path| {
                entries
                    .iter()
                    .find(|(candidate, _)| candidate == path)
                    .map(|(_, bytes)| bytes.clone())
                    .ok_or_else(|| {
                        MarketError::Registry(format!(
                            "The downloaded index references missing `{path}`."
                        ))
                    })
            },
        )?;
        write_registry_cache(&self.home, &index_bytes, &revoked_bytes, &entries)?;
        let mut state = self.state.lock().expect("market state");
        state.registry = Some(Arc::new(registry));
        state.source = RegistrySource::Network;
        state.offline = false;
        state.last_error = None;
        state.settings.last_refresh = Some(now_iso());
        save_settings(&self.home, &state.settings)?;
        Ok(())
    }

    pub async fn refresh(&self) -> Result<CatalogResponse, MarketError> {
        self.refresh_inner().await?;
        self.catalog(false).await
    }

    /// A fail-closed catalogue for a release build with no production key.
    /// It exposes no entries, no categories, and no agents.
    fn preparing_catalog(&self) -> CatalogResponse {
        CatalogResponse {
            entries: Vec::new(),
            categories: Vec::new(),
            agents: Vec::new(),
            generated_at: None,
            source: RegistrySource::Bundled,
            offline: false,
            warnings: vec![PREPARING_MESSAGE.into()],
            last_error: Some(PREPARING_MESSAGE.into()),
            preparing: true,
            settings: self.settings(),
            counts: CatalogCounts::default(),
            cache_verified_at: None,
            cache_age_seconds: None,
            cache_stale: false,
        }
    }

    pub async fn catalog(&self, allow_network: bool) -> Result<CatalogResponse, MarketError> {
        if self.trust_root == TrustRoot::Preparing {
            return Ok(self.preparing_catalog());
        }
        let registry = self.ensure_registry(allow_network).await?;
        let manifests =
            install::load_manifests(&self.home, &self.user_home, self.workspace.as_deref())?;
        let entries = registry
            .entries
            .iter()
            .map(|entry| self.card(entry, &registry, &manifests))
            .collect::<Vec<_>>();
        let mut categories = BTreeSet::new();
        let mut agents = BTreeSet::new();
        for entry in &registry.entries {
            for category in &entry.categories {
                categories.insert(category.clone());
            }
            for agent in &entry.agents {
                agents.insert(agent.clone());
            }
        }
        let (source, offline, mut warnings, settings, last_error) = {
            let state = self.state.lock().expect("market state");
            (
                state.source,
                state.offline || self.forced_offline,
                state.warnings.clone(),
                state.settings.clone(),
                state.last_error.clone(),
            )
        };
        let cache_verified_at = self.cache_verified_at(source, settings.last_refresh.as_deref());
        let cache_age_seconds = cache_verified_at.as_deref().and_then(|value| {
            DateTime::parse_from_rfc3339(value).ok().map(|time| {
                Utc::now()
                    .signed_duration_since(time.with_timezone(&Utc))
                    .num_seconds()
                    .max(0)
            })
        });
        let cache_stale = cache_age_seconds.is_some_and(|age| age >= CACHE_STALE_AFTER_SECS);
        if cache_stale {
            let days = cache_age_seconds.unwrap_or_default() / 86_400;
            warnings.push(format!(
                "The cached registry was last verified {days} days ago. New revocations may be missed until Pandu refreshes online."
            ));
        }
        let installed = manifests
            .iter()
            .filter(|manifest| manifest.state == InstallState::Installed)
            .count();
        Ok(CatalogResponse {
            entries,
            categories: super::MARKET_CATEGORIES
                .iter()
                .filter(|category| categories.contains(**category))
                .map(|category| (*category).to_string())
                .collect(),
            agents: agents.into_iter().collect(),
            generated_at: Some(registry.index.generated_at.clone()),
            source,
            offline,
            warnings,
            last_error,
            preparing: false,
            settings,
            counts: CatalogCounts {
                skills: registry
                    .entries
                    .iter()
                    .filter(|entry| entry.kind == MarketKind::Skill)
                    .count(),
                mcp: registry
                    .entries
                    .iter()
                    .filter(|entry| entry.kind == MarketKind::Mcp)
                    .count(),
                installed,
            },
            cache_verified_at,
            cache_age_seconds,
            cache_stale,
        })
    }

    pub async fn detail(&self, kind: MarketKind, id: &str) -> Result<MarketDetail, MarketError> {
        let registry = self.ensure_registry(false).await?;
        let entry = registry
            .entry(kind, id)
            .ok_or_else(|| MarketError::NotFound(format!("`{id}` is not in the registry.")))?;
        let manifests =
            install::load_manifests(&self.home, &self.user_home, self.workspace.as_deref())?;
        let card = self.card(entry, &registry, &manifests);
        Ok(MarketDetail {
            card,
            source: entry.source.clone(),
            readme: sanitize_markdown(&entry.readme),
        })
    }

    pub async fn preview(
        &self,
        kind: MarketKind,
        id: &str,
        agent: &str,
        scope: InstallScope,
    ) -> Result<InstallPreview, MarketError> {
        let registry = self.ensure_registry(false).await?;
        let entry = registry
            .entry(kind, id)
            .ok_or_else(|| MarketError::NotFound(format!("`{id}` is not in the registry.")))?;
        if registry.is_revoked(kind, id) {
            return Err(MarketError::Install(format!(
                "{} was revoked by the registry. Pandu will not install it.",
                entry.name
            )));
        }
        let context = TargetContext {
            adapters: &self.adapters,
            user_home: &self.user_home,
            workspace: self.workspace.as_deref(),
        };
        let target = targets::resolve(entry, agent, scope, &context)?;
        if !target.verified && target.manual.is_none() {
            return Err(MarketError::Install(
                "Pandu could not verify this agent's install location.".into(),
            ));
        }
        let tree = if target.manual.is_none() && kind == MarketKind::Skill {
            Some(self.tree_for(entry).await?)
        } else {
            None
        };
        let manifests =
            install::load_manifests(&self.home, &self.user_home, self.workspace.as_deref())?;
        let existing = manifests.iter().find(|manifest| {
            manifest.state == InstallState::Installed
                && manifest.kind == kind
                && manifest.entry_id == entry.id
                && manifest.agent == agent
                && manifest.scope == scope
        });
        let preview_id = create_id();
        let plan = install::build_preview(PreviewInputs {
            entry,
            target: &target,
            tree: tree.as_deref(),
            existing,
            preview_id: preview_id.clone(),
        })?;
        let preview = plan.preview.clone();
        let mut state = self.state.lock().expect("market state");
        state
            .previews
            .retain(|_, plan| plan.created_at.elapsed() < PREVIEW_TTL);
        state.previews.insert(preview_id, plan);
        Ok(preview)
    }

    pub fn install(
        &self,
        preview_id: &str,
        secrets: BTreeMap<String, String>,
    ) -> Result<InstallOutcome, MarketError> {
        let plan = {
            let mut state = self.state.lock().expect("market state");
            state.previews.remove(preview_id).ok_or_else(|| {
                MarketError::Install(
                    "This install preview expired or was already used. Preview again.".into(),
                )
            })?
        };
        if plan.created_at.elapsed() >= PREVIEW_TTL {
            return Err(MarketError::Install(
                "This install preview expired. Preview again.".into(),
            ));
        }
        for name in &plan.preview.secret_names {
            let Some(value) = secrets.get(name) else {
                return Err(MarketError::Install(format!(
                    "The secret {name} is required for this install."
                )));
            };
            if value.is_empty() || value.len() > 4096 || value.contains('\0') {
                return Err(MarketError::Install(format!(
                    "The secret {name} is empty or too long."
                )));
            }
        }
        for name in secrets.keys() {
            if !plan.preview.secret_names.contains(name) {
                return Err(MarketError::Install(format!(
                    "Pandu did not ask for the secret {name}."
                )));
            }
        }
        install::apply_plan(
            &self.home,
            &self.user_home,
            self.workspace.as_deref(),
            &plan,
            &secrets,
        )
    }

    pub fn installed(&self) -> Result<InstalledResponse, MarketError> {
        let manifests =
            install::load_manifests(&self.home, &self.user_home, self.workspace.as_deref())?;
        let state = self.state.lock().expect("market state");
        let registry = state.registry.clone();
        let mut warnings = state.warnings.clone();
        if registry.is_none() {
            warnings.push(if self.trust_root == TrustRoot::Preparing {
                "The registry is being prepared; updates cannot be checked.".into()
            } else {
                "The registry is not loaded; updates cannot be checked.".into()
            });
        }
        let mut installs = Vec::new();
        for manifest in &manifests {
            let catalog = registry
                .as_ref()
                .and_then(|registry| registry.entry(manifest.kind, &manifest.entry_id));
            let revoked = registry
                .as_ref()
                .is_some_and(|registry| registry.is_revoked(manifest.kind, &manifest.entry_id));
            installs.push(install::summarize(manifest, catalog, revoked));
        }
        Ok(InstalledResponse {
            installs,
            source: state.source,
            offline: state.offline || self.forced_offline,
            warnings,
            last_error: state.last_error.clone(),
        })
    }

    pub async fn installed_checked(&self) -> Result<InstalledResponse, MarketError> {
        // A preparing release build still shows the local install list; it
        // simply cannot check for updates.
        if self.trust_root == TrustRoot::Preparing {
            return self.installed();
        }
        self.ensure_registry(false).await?;
        self.installed()
    }

    pub fn preview_uninstall(&self, install_id: &str) -> Result<UninstallPreview, MarketError> {
        let manifest = install::load_manifest(
            &self.home,
            &self.user_home,
            self.workspace.as_deref(),
            install_id,
        )?;
        install::preview_uninstall(
            &self.home,
            &self.user_home,
            self.workspace.as_deref(),
            &manifest,
        )
    }

    pub fn uninstall(
        &self,
        install_id: &str,
        confirm_edited: bool,
    ) -> Result<UninstallOutcome, MarketError> {
        let manifest = install::load_manifest(
            &self.home,
            &self.user_home,
            self.workspace.as_deref(),
            install_id,
        )?;
        install::uninstall(
            &self.home,
            &self.user_home,
            self.workspace.as_deref(),
            &manifest,
            confirm_edited,
        )
    }

    pub fn undo(&self, install_id: &str, confirm_edited: bool) -> Result<UndoOutcome, MarketError> {
        let manifest = install::load_manifest(
            &self.home,
            &self.user_home,
            self.workspace.as_deref(),
            install_id,
        )?;
        install::undo(
            &self.home,
            &self.user_home,
            self.workspace.as_deref(),
            &manifest,
            confirm_edited,
        )
    }

    fn card(
        &self,
        entry: &MarketEntry,
        registry: &LoadedRegistry,
        manifests: &[InstallManifest],
    ) -> MarketCard {
        let installed = manifests.iter().find(|manifest| {
            manifest.state == InstallState::Installed
                && manifest.kind == entry.kind
                && manifest.entry_id == entry.id
        });
        let update_available = installed.is_some_and(|manifest| {
            manifest.version != entry.version || manifest.source.commit != entry.source.commit
        });
        MarketCard {
            id: entry.id.clone(),
            kind: entry.kind,
            name: entry.name.clone(),
            version: entry.version.clone(),
            short_description: entry.short_description.clone(),
            long_description: entry.long_description.clone(),
            categories: entry.categories.clone(),
            tags: entry.tags.clone(),
            agents: entry.agents.clone(),
            license: entry.license.clone(),
            trust: entry.trust,
            reviewer: entry.reviewer.clone(),
            reviewed_on: entry.reviewed_on.clone(),
            homepage: entry.homepage.clone(),
            permissions: entry.permissions.clone(),
            example: entry.example,
            revoked: registry.is_revoked(entry.kind, &entry.id),
            installed: installed.is_some(),
            installed_version: installed.map(|manifest| manifest.version.clone()),
            update_available,
            latest_version: entry.version.clone(),
            support: self.support(entry),
        }
    }

    fn support(&self, entry: &MarketEntry) -> Vec<AgentSupport> {
        let mut support = Vec::new();
        let mut seen = BTreeSet::new();
        let agents = match entry.kind {
            MarketKind::Skill => entry
                .skills
                .as_ref()
                .map(|recipe| {
                    recipe
                        .install
                        .iter()
                        .map(|target| (target.agent.clone(), target.scopes.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            MarketKind::Mcp => entry
                .mcp
                .as_ref()
                .map(|recipe| {
                    recipe
                        .install
                        .iter()
                        .map(|target| (target.agent.clone(), target.scopes.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
        };
        for (agent, mut scopes) in agents {
            if !seen.insert(agent.clone()) {
                continue;
            }
            let adapter = self.adapters.get(&agent);
            let name = adapter
                .map(|adapter| adapter.name.clone())
                .unwrap_or_else(|| agent.clone());
            let spec = adapter.and_then(|adapter| match entry.kind {
                MarketKind::Skill => adapter.skills.as_ref().map(|spec| {
                    (
                        spec.verified,
                        !spec.user_paths.is_empty(),
                        !spec.project_paths.is_empty(),
                    )
                }),
                MarketKind::Mcp => adapter.mcp.as_ref().map(|spec| {
                    (
                        spec.verified,
                        !spec.user_paths.is_empty(),
                        !spec.project_paths.is_empty(),
                    )
                }),
            });
            scopes.retain(|scope| match scope {
                InstallScope::User => spec.is_some_and(|spec| spec.1),
                InstallScope::Project => spec.is_some_and(|spec| spec.2),
            });
            support.push(AgentSupport {
                agent,
                name,
                scopes,
                verified: spec.is_some_and(|spec| spec.0),
                available: adapter.is_some() && spec.is_some(),
            });
        }
        support.sort_by(|left, right| left.name.cmp(&right.name));
        support
    }

    async fn tree_for(&self, entry: &MarketEntry) -> Result<Vec<ExtractedFile>, MarketError> {
        let key = format!("{}@{}", entry.id, entry.source.commit);
        {
            let state = self.state.lock().expect("market state");
            if let Some(tree) = state.trees.get(&key) {
                return Ok(tree.clone());
            }
        }
        let tree = if let Some(local) = &self.local_source {
            let root = local.join(&entry.id);
            read_local_tree(&root)?
        } else if entry.example {
            if let Some(repo) = repo_registry_dir() {
                let root = repo.join("fixtures").join(&entry.id);
                read_local_tree(&root)?
            } else {
                return Err(MarketError::Install(
                    "This example has no local fixture tree in this build.".into(),
                ));
            }
        } else {
            fetch_tree(&self.client, entry).await?
        };
        verify_tree(&tree, &entry.source.content_sha256)?;
        let mut state = self.state.lock().expect("market state");
        state.trees.insert(key, tree.clone());
        Ok(tree)
    }
}

fn validate_registry_url(value: &str) -> Result<(), MarketError> {
    let allowed = value.starts_with("https://raw.githubusercontent.com/")
        || value.starts_with("https://github.com/");
    if !allowed || value.len() > 500 || value.contains(char::is_whitespace) || value.contains("..")
    {
        return Err(MarketError::Network(
            "The registry URL must be a GitHub HTTPS URL.".into(),
        ));
    }
    Ok(())
}

/// Turn a failed registry response into a message that makes sense while the
/// repository is still unpublished. GitHub answers 404 for a missing
/// repository and for a private one it will not reveal, so the message names
/// both possibilities and reassures the user that the verified cache survives.
fn registry_http_error(status: reqwest::StatusCode, url: &str) -> MarketError {
    if matches!(status.as_u16(), 401 | 403 | 404) {
        MarketError::Network(format!(
            "The registry is not available: {url} returned HTTP {status}. The repository may \
             not exist yet or may be private. Pandu keeps using the last verified registry."
        ))
    } else {
        MarketError::Network(format!("The registry returned HTTP {status} for {url}."))
    }
}

async fn fetch_limited(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
) -> Result<Vec<u8>, MarketError> {
    let response = client
        .get(url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|error| {
            MarketError::Network(format!("Pandu could not reach the registry: {error}"))
        })?;
    if !response.status().is_success() {
        return Err(registry_http_error(response.status(), url));
    }
    if let Some(length) = response.content_length() {
        if length as usize > limit {
            return Err(MarketError::Network(format!(
                "The registry response from {url} is larger than the limit."
            )));
        }
    }
    use futures_util::StreamExt as _;
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            MarketError::Network(format!("The registry download failed: {error}"))
        })?;
        if bytes.len() + chunk.len() > limit {
            return Err(MarketError::Network(format!(
                "The registry response from {url} is larger than the limit."
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Environment overrides are a development convenience. A release build must
/// ignore them so a user or attacker cannot point the app at a different
/// registry URL or directory; the embedded key still verifies every byte, and
/// this gate removes the override entirely outside debug builds.
fn debug_only<T>(enabled: bool, value: Option<T>) -> Option<T> {
    if enabled { value } else { None }
}

fn refresh_due(settings: &MarketSettings) -> bool {
    let Some(last) = &settings.last_refresh else {
        return true;
    };
    match DateTime::parse_from_rfc3339(last) {
        Ok(last) => {
            Utc::now()
                .signed_duration_since(last.with_timezone(&Utc))
                .num_seconds()
                >= DAILY_REFRESH_SECS
        }
        Err(_) => true,
    }
}

fn repo_registry_dir() -> Option<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../registry");
    let dir = dir.canonicalize().ok()?;
    dir.join(ACTIVE_INDEX_FILE).is_file().then_some(dir)
}

fn load_settings(home: &Path) -> MarketSettings {
    let path = home.join("market").join(SETTINGS_FILE);
    let Ok(bytes) = std::fs::read(&path) else {
        return MarketSettings::default();
    };
    if bytes.len() > 64 * 1024 {
        return MarketSettings::default();
    }
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save_settings(home: &Path, settings: &MarketSettings) -> Result<(), MarketError> {
    let dir = home.join("market");
    std::fs::create_dir_all(&dir).map_err(|error| {
        MarketError::Install(format!("Could not create the market folder: {error}"))
    })?;
    let path = dir.join(SETTINGS_FILE);
    let text = serde_json::to_string_pretty(settings)
        .map_err(|error| MarketError::Install(error.to_string()))?;
    let temp = dir.join(format!(".settings-{}.tmp", rand::random::<u64>()));
    std::fs::write(&temp, text).map_err(|error| {
        MarketError::Install(format!("Could not write market settings: {error}"))
    })?;
    #[cfg(windows)]
    {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|error| {
                MarketError::Install(format!("Could not replace market settings: {error}"))
            })?;
        }
    }
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        MarketError::Install(format!("Could not replace market settings: {error}"))
    })
}

fn write_registry_cache(
    home: &Path,
    index_bytes: &[u8],
    revoked_bytes: &[u8],
    entries: &[(String, Vec<u8>)],
) -> Result<(), MarketError> {
    let market = home.join("market");
    std::fs::create_dir_all(&market).map_err(|error| {
        MarketError::Registry(format!("Could not create the registry cache: {error}"))
    })?;
    let suffix = rand::random::<u64>();
    let temp = market.join(format!(".registry-tmp-{suffix}"));
    if temp.exists() {
        let _ = std::fs::remove_dir_all(&temp);
    }
    std::fs::create_dir_all(&temp).map_err(|error| {
        MarketError::Registry(format!("Could not create the registry cache: {error}"))
    })?;
    let write = |path: &Path, bytes: &[u8]| -> Result<(), MarketError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                MarketError::Registry(format!("Could not create the registry cache: {error}"))
            })?;
        }
        std::fs::write(path, bytes).map_err(|error| {
            MarketError::Registry(format!("Could not write the registry cache: {error}"))
        })
    };
    for (path, bytes) in entries {
        write(&temp.join(path), bytes)?;
    }
    write(&temp.join(ACTIVE_REVOKED_FILE), revoked_bytes)?;
    write(&temp.join(ACTIVE_INDEX_FILE), index_bytes)?;

    let cache = market.join("registry");
    let old = market.join(format!(".registry-old-{suffix}"));
    if cache.exists() {
        std::fs::rename(&cache, &old).map_err(|error| {
            let _ = std::fs::remove_dir_all(&temp);
            MarketError::Registry(format!("Could not replace the registry cache: {error}"))
        })?;
    }
    if let Err(error) = std::fs::rename(&temp, &cache) {
        if old.exists() {
            let _ = std::fs::rename(&old, &cache);
        }
        let _ = std::fs::remove_dir_all(&temp);
        return Err(MarketError::Registry(format!(
            "Could not replace the registry cache: {error}"
        )));
    }
    if old.exists() {
        let _ = std::fs::remove_dir_all(&old);
    }
    Ok(())
}

fn recover_cache(home: &Path) {
    let market = home.join("market");
    let cache = market.join("registry");
    if cache.join(ACTIVE_INDEX_FILE).exists() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&market) else {
        return;
    };
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(".registry-old-"))
        })
        .collect();
    candidates.sort();
    if let Some(candidate) = candidates.pop() {
        let _ = std::fs::rename(candidate, cache);
    }
}

/// The market never exposes a remote endpoint. This constant is referenced by
/// the remote isolation test so a future refactor cannot silently mount it.
pub const HOST_ONLY_PREFIX: &str = "/api/market";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::{PRODUCTION_REGISTRY_KEY_ID, verify_index_with, verify_revocation_with};

    #[test]
    #[cfg(debug_assertions)]
    fn bundled_test_registry_is_verifiable_and_complete() {
        let registry = parse_registry(
            BUNDLED_INDEX.as_bytes(),
            BUNDLED_REVOKED.as_bytes(),
            true,
            |path| {
                BUNDLED_ENTRIES
                    .iter()
                    .find(|(candidate, _)| *candidate == path)
                    .map(|(_, contents)| contents.as_bytes().to_vec())
                    .ok_or_else(|| MarketError::Registry(path.to_string()))
            },
        )
        .unwrap();
        assert_eq!(registry.entries.len(), 22);
        assert_eq!(
            registry
                .entries
                .iter()
                .filter(|entry| entry.example)
                .count(),
            3
        );
        assert_eq!(registry.index.key_id, crate::market::REGISTRY_KEY_ID);
    }

    #[test]
    fn release_without_a_production_key_refuses_the_bundled_registry() {
        // The production index is unsigned until the maintainer provisions the
        // offline key. A release build must refuse it, never fall back to the
        // test registry.
        let index: SignedIndex =
            serde_json::from_str(include_str!("../../../../registry/index.json")).unwrap();
        assert!(matches!(
            verify_index_with(
                &index,
                PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64,
                PRODUCTION_REGISTRY_KEY_ID
            ),
            Err(MarketError::Signature(_))
        ));
        assert!(PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64.is_none());
        assert_eq!(
            resolve_trust_root(false, PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64),
            TrustRoot::Preparing
        );
    }

    /// Ignored by default: it requires the production key that signed the
    /// bundled registry. The release workflow runs it with `--ignored`. A
    /// missing key, an unsigned index, a stale key id, or a bad signature
    /// fails the job and blocks publishing.
    #[test]
    #[ignore = "requires the production registry key; run in the release workflow"]
    fn bundled_production_registry_verifies_with_the_production_key() {
        let Some(public_key) = PRODUCTION_REGISTRY_PUBLIC_KEY_BASE64 else {
            panic!(
                "No production registry key is embedded. Follow docs/registry/KEYS.md, then \
                 re-sign registry/index.json and registry/revoked.json. Refusing to publish."
            );
        };
        let index: SignedIndex =
            serde_json::from_str(include_str!("../../../../registry/index.json")).unwrap();
        let revoked: SignedRevocation =
            serde_json::from_str(include_str!("../../../../registry/revoked.json")).unwrap();
        verify_index_with(&index, Some(public_key), PRODUCTION_REGISTRY_KEY_ID)
            .expect("the bundled production index must verify with the production key");
        verify_revocation_with(&revoked, Some(public_key), PRODUCTION_REGISTRY_KEY_ID)
            .expect("the bundled production revocation list must verify with the production key");
    }

    #[tokio::test]
    async fn preparing_catalog_is_empty_and_exposes_no_entries() {
        let home = tempfile::tempdir().unwrap();
        let user_home = tempfile::tempdir().unwrap();
        let mut service = MarketService::for_test(
            home.path().to_path_buf(),
            user_home.path().to_path_buf(),
            None,
            Arc::new(pandu_core::adapter::AdapterRegistry::new(
                Vec::new(),
                Vec::new(),
            )),
            None,
            None,
        );
        Arc::get_mut(&mut service).unwrap().trust_root = TrustRoot::Preparing;

        let catalog = service.catalog(false).await.unwrap();
        assert!(catalog.preparing);
        assert!(catalog.entries.is_empty());
        assert!(catalog.categories.is_empty());
        assert!(catalog.agents.is_empty());
        assert_eq!(catalog.counts.skills, 0);
        assert_eq!(catalog.counts.mcp, 0);
        assert_eq!(catalog.last_error.as_deref(), Some(PREPARING_MESSAGE));
        assert!(matches!(
            service
                .detail(MarketKind::Skill, "example-commit-messages")
                .await,
            Err(MarketError::Preparing)
        ));
        let installed = service.installed_checked().await.unwrap();
        assert!(installed.installs.is_empty());
        assert!(
            installed
                .warnings
                .iter()
                .any(|warning| warning.contains("being prepared"))
        );
    }

    #[test]
    fn a_missing_or_private_registry_gets_a_clear_message() {
        let url = "https://raw.githubusercontent.com/ganddtn40/pandu/main/registry/index.json";
        for status in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::FORBIDDEN,
            reqwest::StatusCode::NOT_FOUND,
        ] {
            let message = registry_http_error(status, url).to_string();
            assert!(message.contains("not available"), "{message}");
            assert!(message.contains("may not exist"), "{message}");
            assert!(message.contains("private"), "{message}");
            assert!(message.contains("last verified registry"), "{message}");
        }
        let other =
            registry_http_error(reqwest::StatusCode::INTERNAL_SERVER_ERROR, url).to_string();
        assert!(other.contains("HTTP 500"), "{other}");
        assert!(!other.contains("may be private"), "{other}");
    }

    #[test]
    fn environment_overrides_are_debug_only() {
        assert_eq!(debug_only(false, Some("https://example.invalid")), None);
        assert_eq!(
            debug_only(true, Some("https://example.invalid")),
            Some("https://example.invalid")
        );
    }

    #[test]
    #[cfg(debug_assertions)]
    fn debug_builds_reject_the_unsigned_production_registry() {
        let index: SignedIndex =
            serde_json::from_str(include_str!("../../../../registry/index.json")).unwrap();
        assert!(matches!(
            verify_index(&index),
            Err(MarketError::Signature(_))
        ));
    }

    #[test]
    #[cfg(debug_assertions)]
    fn examples_are_hidden_when_not_requested() {
        let registry = parse_registry(
            BUNDLED_INDEX.as_bytes(),
            BUNDLED_REVOKED.as_bytes(),
            false,
            |path| {
                BUNDLED_ENTRIES
                    .iter()
                    .find(|(candidate, _)| *candidate == path)
                    .map(|(_, contents)| contents.as_bytes().to_vec())
                    .ok_or_else(|| MarketError::Registry(path.to_string()))
            },
        )
        .unwrap();
        assert_eq!(registry.entries.len(), 19);
        assert!(registry.entries.iter().all(|entry| !entry.example));
    }

    #[test]
    fn registry_urls_must_be_github_https() {
        assert!(validate_registry_url(DEFAULT_REGISTRY_URL).is_ok());
        for url in [
            "http://raw.githubusercontent.com/x/y",
            "https://evil.example/registry",
            "https://raw.githubusercontent.com/x/../y",
        ] {
            assert!(validate_registry_url(url).is_err(), "{url}");
        }
    }
}
