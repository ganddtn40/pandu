<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../Icon.svelte';
  import { marketApi } from '../api/client';
  import { daemonErrorMessage } from '../api/daemon.svelte';
  import type {
    AgentSupport,
    CatalogResponse,
    InstallOutcome,
    InstallPreview,
    InstallScope,
    InstalledResponse,
    InstalledSummary,
    MarketCard,
    MarketDetail,
    RegistrySource,
    TrustTier,
    UndoOutcome,
    UninstallOutcome,
    UninstallPreview,
  } from '../api/types';
  import { copyText } from '../clipboard';
  import { diffLines } from '../diff';
  import { formatDate } from '../format';
  import { t, type MessageKey } from '../i18n/i18n.svelte';
  import { toast } from '../toast-store.svelte';

  type Tab = 'skills' | 'mcp' | 'installed';
  type SortMode = 'name' | 'trust' | 'installed';
  type TierFilter = 'all' | TrustTier;
  type SheetView = 'detail' | 'preview' | 'result' | 'uninstall' | 'uninstall-result';

  const ROW_HEIGHT = 140;
  const ROW_GAP = 10;
  const TRUST_ORDER: Record<TrustTier, number> = {
    official: 0,
    'community-reviewed': 1,
    unreviewed: 2,
  };

  let catalog = $state<CatalogResponse | null>(null);
  let catalogLoading = $state(true);
  let catalogError = $state('');
  let refreshing = $state(false);
  let installedResponse = $state<InstalledResponse | null>(null);
  let installedLoading = $state(false);
  let installedError = $state('');

  let activeTab = $state<Tab>('skills');
  let query = $state('');
  let agentFilters = $state<string[]>([]);
  let categoryFilter = $state('all');
  let tierFilter = $state<TierFilter>('all');
  let installedOnly = $state(false);
  let sortMode = $state<SortMode>('trust');

  let scrollEl = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(560);

  let sheetOpen = $state(false);
  let sheetView = $state<SheetView>('detail');
  let selected = $state<MarketCard | null>(null);
  let detail = $state<MarketDetail | null>(null);
  let detailLoading = $state(false);
  let detailError = $state('');
  let selectedAgent = $state('');
  let selectedScope = $state<InstallScope>('user');

  let preview = $state<InstallPreview | null>(null);
  let previewLoading = $state(false);
  let previewError = $state('');
  let secrets = $state<Record<string, string>>({});
  let installing = $state(false);
  let installError = $state('');
  let outcome = $state<InstallOutcome | null>(null);
  let undoing = $state(false);

  let uninstallTarget = $state<InstalledSummary | null>(null);
  let uninstallPreview = $state<UninstallPreview | null>(null);
  let uninstallLoading = $state(false);
  let uninstallError = $state('');
  let confirmEdited = $state(false);
  let uninstalling = $state(false);
  let uninstallOutcome = $state<UninstallOutcome | null>(null);

  const offline = $derived(catalog?.offline === true);
  const devOverride = $derived(catalog?.source === 'environment');
  const settings = $derived(catalog?.settings ?? { autoRefresh: false, lastRefresh: null });
  const allAgents = $derived(catalog?.agents ?? []);
  const allCategories = $derived(catalog?.categories ?? []);

  const tabEntries = $derived(
    (catalog?.entries ?? []).filter((entry) =>
      activeTab === 'skills' ? entry.kind === 'skill' : entry.kind === 'mcp',
    ),
  );

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const tokens = needle ? needle.split(/\s+/) : [];
    const result = tabEntries.filter((entry) => {
      if (installedOnly && !entry.installed) return false;
      if (tierFilter !== 'all' && entry.trust !== tierFilter) return false;
      if (categoryFilter !== 'all' && !entry.categories.includes(categoryFilter)) return false;
      if (agentFilters.length > 0 && !agentFilters.some((agent) => entry.agents.includes(agent))) {
        return false;
      }
      if (tokens.length > 0) {
        const haystack = [
          entry.name,
          entry.id,
          entry.shortDescription,
          entry.longDescription,
          entry.license,
          ...entry.categories,
          ...entry.agents,
        ]
          .join(' ')
          .toLowerCase();
        if (!tokens.every((token) => haystack.includes(token))) return false;
      }
      return true;
    });
    result.sort((left, right) => {
      if (sortMode === 'name') return left.name.localeCompare(right.name);
      if (sortMode === 'installed') {
        if (left.installed !== right.installed) return left.installed ? -1 : 1;
        return left.name.localeCompare(right.name);
      }
      const trust = TRUST_ORDER[left.trust] - TRUST_ORDER[right.trust];
      return trust === 0 ? left.name.localeCompare(right.name) : trust;
    });
    return result;
  });

  const startIndex = $derived(
    Math.max(0, Math.floor(scrollTop / (ROW_HEIGHT + ROW_GAP)) - 2),
  );
  const endIndex = $derived(
    Math.min(
      filtered.length,
      Math.ceil((scrollTop + viewportHeight) / (ROW_HEIGHT + ROW_GAP)) + 2,
    ),
  );
  const visibleEntries = $derived(filtered.slice(startIndex, endIndex));
  const listHeight = $derived(filtered.length * (ROW_HEIGHT + ROW_GAP));

  const filtersActive = $derived(
    query.trim().length > 0 ||
      agentFilters.length > 0 ||
      categoryFilter !== 'all' ||
      tierFilter !== 'all' ||
      installedOnly,
  );

  const selectedSupport = $derived(
    selected?.support.find((support) => support.agent === selectedAgent) ?? null,
  );
  const selectedScopes = $derived(selectedSupport?.scopes ?? []);
  const missingSecret = $derived(
    preview ? preview.secretNames.some((name) => !(secrets[name] ?? '').trim()) : false,
  );
  const canInstall = $derived(
    preview !== null &&
      preview.manual === null &&
      preview.conflicts.length === 0 &&
      !missingSecret,
  );
  const installedEntries = $derived(installedResponse?.installs ?? []);
  const installedActive = $derived(
    installedEntries.filter((entry) => entry.state === 'installed'),
  );

  $effect(() => {
    const element = scrollEl;
    if (!element) return;
    const measure = () => {
      viewportHeight = element.clientHeight || 560;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  });

  onMount(() => {
    void loadCatalog();
    void loadInstalled();
  });

  async function loadCatalog(): Promise<void> {
    catalogLoading = true;
    catalogError = '';
    try {
      catalog = await marketApi.catalog();
    } catch (error) {
      catalogError = daemonErrorMessage(error);
    } finally {
      catalogLoading = false;
    }
  }

  async function loadInstalled(): Promise<void> {
    installedLoading = true;
    installedError = '';
    try {
      installedResponse = await marketApi.installed();
    } catch (error) {
      installedError = daemonErrorMessage(error);
    } finally {
      installedLoading = false;
    }
  }

  async function refreshRegistry(): Promise<void> {
    if (refreshing || offline) return;
    refreshing = true;
    catalogError = '';
    try {
      catalog = await marketApi.refresh();
      toast(t('market.refreshed'));
      await loadInstalled();
    } catch (error) {
      catalogError = daemonErrorMessage(error);
      toast(t('market.refreshFailed'));
    } finally {
      refreshing = false;
    }
  }

  async function toggleAutoRefresh(): Promise<void> {
    if (!catalog) return;
    const next = !settings.autoRefresh;
    try {
      const updated = await marketApi.updateSettings(next);
      catalog = { ...catalog, settings: updated };
      toast(t(next ? 'market.autoRefreshOn' : 'market.autoRefreshOff'));
    } catch (error) {
      toast(daemonErrorMessage(error));
    }
  }

  function selectTab(tab: Tab): void {
    if (activeTab === tab) return;
    activeTab = tab;
    resetScroll();
    if (tab === 'installed') void loadInstalled();
  }

  function resetScroll(): void {
    scrollTop = 0;
    if (scrollEl) scrollEl.scrollTop = 0;
  }

  function onScroll(event: Event): void {
    scrollTop = (event.currentTarget as HTMLDivElement).scrollTop;
  }

  function toggleAgent(agent: string): void {
    agentFilters = agentFilters.includes(agent)
      ? agentFilters.filter((candidate) => candidate !== agent)
      : [...agentFilters, agent];
    resetScroll();
  }

  function clearFilters(): void {
    query = '';
    agentFilters = [];
    categoryFilter = 'all';
    tierFilter = 'all';
    installedOnly = false;
    resetScroll();
  }

  function kindLabel(kind: MarketCard['kind']): string {
    return t(kind === 'skill' ? 'market.tabSkills' : 'market.tabMcp');
  }

  function agentLabel(agent: string): string {
    const known: Record<string, string> = {
      'claude-code': 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode',
    };
    return known[agent] ?? agent;
  }

  function trustKey(trust: TrustTier): MessageKey {
    if (trust === 'official') return 'market.trustOfficial';
    if (trust === 'community-reviewed') return 'market.trustReviewed';
    return 'market.trustUnreviewed';
  }

  function trustClass(trust: TrustTier): string {
    if (trust === 'official') return 'status-pill--ok';
    if (trust === 'community-reviewed') return 'status-pill--accent';
    return 'status-pill--warn';
  }

  function trustNote(trust: TrustTier): string {
    if (trust === 'official') return t('market.tierOfficialNote');
    if (trust === 'community-reviewed') return t('market.tierReviewedNote');
    return t('market.tierUnreviewedNote');
  }

  function sourceLabel(source: RegistrySource): string {
    const keys: Record<RegistrySource, MessageKey> = {
      environment: 'market.sourceEnvironment',
      cache: 'market.sourceCache',
      repo: 'market.sourceRepo',
      bundled: 'market.sourceBundled',
      network: 'market.sourceNetwork',
    };
    return t(keys[source]);
  }

  function scopeLabel(scope: InstallScope): string {
    return t(scope === 'user' ? 'market.scopeUser' : 'market.scopeProject');
  }

  function supportLabel(support: AgentSupport): string {
    if (!support.available) return t('market.notAvailable');
    if (!support.verified) return t('market.manualOnly');
    return support.scopes.map(scopeLabel).join(' · ');
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function actionKey(action: string): MessageKey {
    if (action === 'create') return 'market.newFile';
    if (action === 'overwrite') return 'market.overwrite';
    if (action === 'unchanged') return 'market.unchanged';
    return 'market.conflict';
  }

  function actionClass(action: string): string {
    if (action === 'conflict') return 'status-pill--danger';
    if (action === 'overwrite') return 'status-pill--warn';
    if (action === 'create') return 'status-pill--accent';
    return '';
  }

  function attentionLabel(text: string): string {
    const missing = /^(\d+) file\(s\) are missing$/.exec(text);
    if (missing) return t('market.attentionMissing', { count: Number(missing[1]) });
    const edited = /^(\d+) file\(s\) changed on disk$/.exec(text);
    if (edited) return t('market.attentionEdited', { count: Number(edited[1]) });
    if (text === 'Configuration changed on disk') return t('market.attentionConfig');
    if (text === 'Revoked by the registry') return t('market.attentionRevoked');
    return text;
  }

  function chooseDefaultTarget(card: MarketCard): void {
    const support =
      card.support.find((candidate) => candidate.available && candidate.scopes.length > 0) ??
      card.support[0];
    if (support) {
      selectedAgent = support.agent;
      selectedScope = support.scopes[0] ?? 'user';
    } else {
      selectedAgent = '';
      selectedScope = 'user';
    }
  }

  function onAgentChange(event: Event): void {
    selectedAgent = (event.currentTarget as HTMLSelectElement).value;
    const support = selected?.support.find((candidate) => candidate.agent === selectedAgent);
    if (support && support.scopes.length > 0) selectedScope = support.scopes[0] ?? 'user';
  }

  function onScopeChange(event: Event): void {
    selectedScope = (event.currentTarget as HTMLSelectElement).value as InstallScope;
  }

  async function openDetail(card: MarketCard): Promise<void> {
    selected = card;
    detail = null;
    detailError = '';
    detailLoading = true;
    sheetOpen = true;
    sheetView = 'detail';
    preview = null;
    outcome = null;
    installError = '';
    uninstallTarget = null;
    uninstallPreview = null;
    uninstallOutcome = null;
    chooseDefaultTarget(card);
    try {
      const loaded = await marketApi.detail(card.kind, card.id);
      detail = loaded;
      selected = loaded;
      chooseDefaultTarget(loaded);
    } catch (error) {
      detailError = daemonErrorMessage(error);
    } finally {
      detailLoading = false;
    }
  }

  async function openUpdate(item: InstalledSummary): Promise<void> {
    const card = catalog?.entries.find(
      (entry) => entry.kind === item.kind && entry.id === item.entryId,
    );
    if (!card) {
      toast(t('market.errorBody'));
      return;
    }
    await openDetail(card);
    await startPreview();
  }

  async function startPreview(): Promise<void> {
    if (!selected || !selectedAgent) return;
    sheetOpen = true;
    sheetView = 'preview';
    preview = null;
    previewError = '';
    installError = '';
    outcome = null;
    secrets = {};
    previewLoading = true;
    try {
      const result = await marketApi.preview(
        selected.kind,
        selected.id,
        selectedAgent,
        selectedScope,
      );
      preview = result;
      const next: Record<string, string> = {};
      for (const name of result.secretNames) next[name] = '';
      secrets = next;
    } catch (error) {
      previewError = daemonErrorMessage(error);
    } finally {
      previewLoading = false;
    }
  }

  async function confirmInstall(): Promise<void> {
    if (!preview || !canInstall || installing) return;
    installing = true;
    installError = '';
    try {
      outcome = await marketApi.install(preview.previewId, { ...secrets });
      sheetView = 'result';
      toast(t('market.installSuccess', { name: outcome.name }));
      await Promise.all([loadCatalog(), loadInstalled()]);
    } catch (error) {
      installError = daemonErrorMessage(error);
    } finally {
      installing = false;
    }
  }

  async function undoInstall(installId: string): Promise<void> {
    if (undoing) return;
    undoing = true;
    installError = '';
    try {
      const result: UndoOutcome = await marketApi.undo(installId, false);
      toast(t('market.undone'));
      sheetOpen = false;
      selected = null;
      detail = null;
      outcome = null;
      uninstallOutcome = null;
      await Promise.all([loadCatalog(), loadInstalled()]);
      if (result.state !== 'installed') {
        activeTab = 'installed';
        resetScroll();
      }
    } catch (error) {
      installError = daemonErrorMessage(error);
      toast(t('market.undoFailed'));
    } finally {
      undoing = false;
    }
  }

  async function startUninstall(item: InstalledSummary): Promise<void> {
    uninstallTarget = item;
    uninstallPreview = null;
    uninstallError = '';
    uninstallOutcome = null;
    confirmEdited = false;
    sheetOpen = true;
    sheetView = 'uninstall';
    uninstallLoading = true;
    try {
      uninstallPreview = await marketApi.previewUninstall(item.installId);
    } catch (error) {
      uninstallError = daemonErrorMessage(error);
    } finally {
      uninstallLoading = false;
    }
  }

  async function confirmUninstall(): Promise<void> {
    if (!uninstallTarget || !uninstallPreview || uninstalling) return;
    if (uninstallPreview.needsConfirmation && !confirmEdited) return;
    uninstalling = true;
    uninstallError = '';
    try {
      uninstallOutcome = await marketApi.uninstall(
        uninstallTarget.installId,
        confirmEdited,
      );
      sheetView = 'uninstall-result';
      toast(t('market.uninstallSuccess', { name: uninstallTarget.name }));
      await Promise.all([loadCatalog(), loadInstalled()]);
    } catch (error) {
      uninstallError = daemonErrorMessage(error);
    } finally {
      uninstalling = false;
    }
  }

  function closeSheet(): void {
    if (installing || uninstalling) return;
    sheetOpen = false;
    selected = null;
    detail = null;
    preview = null;
    outcome = null;
    uninstallTarget = null;
    uninstallPreview = null;
    uninstallOutcome = null;
    installError = '';
    previewError = '';
    uninstallError = '';
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && sheetOpen) {
      event.preventDefault();
      closeSheet();
    }
  }

  async function copySnippet(text: string): Promise<void> {
    const copied = await copyText(text);
    toast(copied ? t('market.instructionsCopied') : t('common.copyFailed'));
  }

  function installActionLabel(card: MarketCard): string {
    if (card.updateAvailable) return t('market.update');
    return t('market.install');
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="screen-head">
  <div>
    <p class="kicker">{t('market.kicker')}</p>
    <h1>{t('market.title')}</h1>
    <p class="screen-lede">{t('market.lede')}</p>
  </div>
  <div class="screen-actions">
    {#if catalog}
      {#if devOverride}
        <span class="status-pill status-pill--warn" data-testid="market-dev-override">
          <span class="dot dot--warn"></span>
          {t('market.devOverride')}
        </span>
      {/if}
      <span class="status-pill" class:status-pill--warn={offline}>
        <span class="dot" class:dot--ok={!offline} class:dot--warn={offline}></span>
        {offline ? t('market.offlineShort') : sourceLabel(catalog.source)}
      </span>
    {/if}
    <button
      class="btn btn--ghost"
      type="button"
      onclick={refreshRegistry}
      disabled={refreshing || offline || !catalog}
    >
      <Icon name="refresh" size={16} />
      {refreshing ? t('market.refreshing') : t('market.refresh')}
    </button>
  </div>
</div>

{#if offline && catalog}
  <section class="market-banner" role="status" data-testid="market-offline">
    <Icon name="alert" size={18} />
    <div>
      <strong>{t('market.offlineTitle')}</strong>
      <p>{t('market.offlineBody')}</p>
    </div>
  </section>
{/if}

{#if catalogError && catalog}
  <section class="market-banner market-banner--danger" role="alert">
    <Icon name="alert" size={18} />
    <div>
      <strong>{t('market.refreshFailed')}</strong>
      <p>{catalogError}</p>
    </div>
  </section>
{/if}

{#if catalogLoading && !catalog}
  <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
    <span class="empty-state__icon"><Icon name="market" size={24} /></span>
    <h2>{t('market.loading')}</h2>
    <p>{t('market.offlineBody')}</p>
  </section>
{:else if catalogError && !catalog}
  <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
    <span class="empty-state__icon"><Icon name="alert" size={24} /></span>
    <h2>{t('market.errorTitle')}</h2>
    <p>{t('market.errorBody')}</p>
    <p class="market-error-detail">{catalogError}</p>
    <button class="btn btn--primary" type="button" onclick={loadCatalog}>
      <Icon name="refresh" size={16} />
      {t('common.retry')}
    </button>
  </section>
{:else if catalog}
  <div class="market-toolbar">
    <div class="segmented market-tabs" role="tablist" aria-label={t('market.title')}>
      <button
        class="segmented__item"
        class:is-active={activeTab === 'skills'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'skills'}
        data-testid="market-tab-skills"
        onclick={() => selectTab('skills')}
      >
        <Icon name="sparkles" size={15} />
        {t('market.tabSkills')}
        <span class="market-tab-count">{catalog.counts.skills}</span>
      </button>
      <button
        class="segmented__item"
        class:is-active={activeTab === 'mcp'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'mcp'}
        data-testid="market-tab-mcp"
        onclick={() => selectTab('mcp')}
      >
        <Icon name="terminal" size={15} />
        {t('market.tabMcp')}
        <span class="market-tab-count">{catalog.counts.mcp}</span>
      </button>
      <button
        class="segmented__item"
        class:is-active={activeTab === 'installed'}
        type="button"
        role="tab"
        aria-selected={activeTab === 'installed'}
        data-testid="market-tab-installed"
        onclick={() => selectTab('installed')}
      >
        <Icon name="download" size={15} />
        {t('market.tabInstalled')}
        <span class="market-tab-count">{installedActive.length}</span>
      </button>
    </div>

    {#if activeTab !== 'installed'}
      <div class="market-toolbar__right">
        <label class="search-field market-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            placeholder={t('market.search')}
            aria-label={t('market.search')}
            data-testid="market-search"
            bind:value={query}
            oninput={resetScroll}
          />
        </label>
        <label class="market-select">
          <span>{t('market.sort')}</span>
          <select
            bind:value={sortMode}
            aria-label={t('market.sort')}
            onchange={resetScroll}
          >
            <option value="trust">{t('market.sortTrust')}</option>
            <option value="name">{t('market.sortName')}</option>
            <option value="installed">{t('market.sortInstalled')}</option>
          </select>
        </label>
        <button
          class="chip"
          class:is-active={settings.autoRefresh}
          type="button"
          aria-pressed={settings.autoRefresh}
          title={t('market.autoRefreshNote')}
          data-testid="market-daily-refresh"
          onclick={toggleAutoRefresh}
        >
          <Icon name="clock" size={14} />
          {t(settings.autoRefresh ? 'market.dailyRefreshOn' : 'market.dailyRefreshOff')}
        </button>
      </div>
      <p class="market-refresh-note" data-testid="market-refresh-note">
        <Icon name="clock" size={13} />
        {t('market.autoRefreshNote')}
      </p>
    {/if}
  </div>

  {#if activeTab !== 'installed'}
    <div class="market-filters">
      <div class="market-filter">
        <span class="market-filter__label">{t('market.agents')}</span>
        <div class="market-filter__chips">
          {#each allAgents as agent}
            <button
              class="chip"
              class:is-active={agentFilters.includes(agent)}
              type="button"
              aria-pressed={agentFilters.includes(agent)}
              data-testid={`market-agent-${agent}`}
              onclick={() => toggleAgent(agent)}
            >
              {agentLabel(agent)}
            </button>
          {/each}
        </div>
      </div>
      <label class="market-select">
        <span>{t('market.categories')}</span>
        <select
          bind:value={categoryFilter}
          aria-label={t('market.categories')}
          onchange={resetScroll}
        >
          <option value="all">{t('market.allCategories')}</option>
          {#each allCategories as category}
            <option value={category}>{category}</option>
          {/each}
        </select>
      </label>
      <label class="market-select">
        <span>{t('market.tier')}</span>
        <select bind:value={tierFilter} aria-label={t('market.tier')} onchange={resetScroll}>
          <option value="all">{t('market.allTiers')}</option>
          <option value="official">{t('market.trustOfficial')}</option>
          <option value="community-reviewed">{t('market.trustReviewed')}</option>
          <option value="unreviewed">{t('market.trustUnreviewed')}</option>
        </select>
      </label>
      <button
        class="chip"
        class:is-active={installedOnly}
        type="button"
        aria-pressed={installedOnly}
        onclick={() => {
          installedOnly = !installedOnly;
          resetScroll();
        }}
      >
        <Icon name="check" size={14} />
        {t('market.installedOnly')}
      </button>
      {#if filtersActive}
        <button class="text-link" type="button" onclick={clearFilters}>
          {t('market.clearFilters')}
        </button>
      {/if}
      <span class="market-showing">
        {t('market.showing', { shown: filtered.length, total: tabEntries.length })}
      </span>
    </div>

    {#if filtered.length === 0}
      <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
        <span class="empty-state__icon"><Icon name="search" size={24} /></span>
        <h2>{filtersActive ? t('market.noResultsTitle') : t('market.emptyTitle')}</h2>
        <p>{filtersActive ? t('market.noResultsBody') : t('market.emptyBody')}</p>
        {#if filtersActive}
          <button class="btn btn--ghost" type="button" onclick={clearFilters}>
            {t('market.clearFilters')}
          </button>
        {/if}
      </section>
    {:else}
      <div class="market-scroll" bind:this={scrollEl} onscroll={onScroll}>
        <div class="market-virtual" style={`height: ${listHeight}px`}>
          {#each visibleEntries as card, index (card.kind + ':' + card.id)}
            <div
              class="market-row"
              style={`top: ${(startIndex + index) * (ROW_HEIGHT + ROW_GAP)}px; height: ${ROW_HEIGHT}px`}
            >
              <button
                class="market-card card"
                type="button"
                data-testid={`market-card-${card.id}`}
                onclick={() => openDetail(card)}
                data-glass
                data-glass-layer="card"
                data-glass-depth="2"
              >
                <span class="market-card__icon" aria-hidden="true">
                  <Icon name={card.kind === 'skill' ? 'sparkles' : 'terminal'} size={22} />
                </span>
                <span class="market-card__body">
                  <span class="market-card__title-row">
                    <strong>{card.name}</strong>
                    <span class={`status-pill ${trustClass(card.trust)}`}>
                      <Icon name={card.trust === 'unreviewed' ? 'alert' : 'shield'} size={12} />
                      {t(trustKey(card.trust))}
                    </span>
                    {#if card.example}
                      <span class="market-badge">{t('market.example')}</span>
                    {/if}
                    {#if card.revoked}
                      <span class="status-pill status-pill--danger">{t('market.revoked')}</span>
                    {/if}
                  </span>
                  <span class="market-card__desc">{card.shortDescription}</span>
                  <span class="market-card__meta">
                    <span class="market-agent-list">
                      {#each card.agents.slice(0, 3) as agent}
                        <span class="market-agent">
                          <Icon name="terminal" size={12} />
                          {agentLabel(agent)}
                        </span>
                      {/each}
                      {#if card.agents.length > 3}
                        <span class="market-agent market-agent--more">
                          +{card.agents.length - 3}
                        </span>
                      {/if}
                    </span>
                    <span class="market-meta-sep">·</span>
                    {#each card.categories as category}
                      <span class="market-category">{category}</span>
                    {/each}
                  </span>
                </span>
                <span class="market-card__side">
                  {#if card.installed}
                    <span class="status-pill status-pill--ok">
                      <Icon name="check" size={12} />
                      {card.installedVersion
                        ? t('market.installedVersion', { version: card.installedVersion })
                        : t('market.installed')}
                    </span>
                  {/if}
                  {#if card.updateAvailable}
                    <span class="status-pill status-pill--accent">{t('market.updateAvailable')}</span>
                  {/if}
                  <span class="market-version">{t('market.version', { version: card.version })}</span>
                  <Icon name="chevron-right" size={17} />
                </span>
              </button>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {:else}
    <section class="market-installed-head">
      <div>
        <p>{t('market.installedTabBody')}</p>
      </div>
      <span class="status-pill"><Icon name="shield" size={13} /> {t('market.hostOnly')}</span>
    </section>

    {#if installedError}
      <section class="market-banner market-banner--danger" role="alert">
        <Icon name="alert" size={18} />
        <div>
          <strong>{t('market.installedError')}</strong>
          <p>{installedError}</p>
          <button
            class="btn btn--ghost btn--small market-banner__action"
            type="button"
            onclick={loadInstalled}
          >
            <Icon name="refresh" size={15} />
            {t('common.retry')}
          </button>
        </div>
      </section>
    {/if}

    {#if installedLoading && !installedResponse}
      <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
        <span class="empty-state__icon"><Icon name="download" size={24} /></span>
        <h2>{t('market.loadInstalled')}</h2>
      </section>
    {:else if installedEntries.length === 0}
      <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
        <span class="empty-state__icon"><Icon name="download" size={24} /></span>
        <h2>{t('market.installedEmptyTitle')}</h2>
        <p>{t('market.installedEmptyBody')}</p>
        <button class="btn btn--primary" type="button" onclick={() => selectTab('skills')}>
          {t('market.tabSkills')}
        </button>
      </section>
    {:else}
      <div class="market-installed-list">
        {#each installedEntries as item (item.installId)}
          <article
            class="market-installed card"
            data-testid={`market-installed-${item.installId}`}
            data-glass
            data-glass-layer="card"
            data-glass-depth="2"
          >
            <div class="market-installed__head">
              <span class="market-card__icon" aria-hidden="true">
                <Icon name={item.kind === 'skill' ? 'sparkles' : 'terminal'} size={20} />
              </span>
              <div class="market-installed__title">
                <strong>{item.name}</strong>
                <small>
                  {agentLabel(item.agent)} · {scopeLabel(item.scope)} ·
                  {t('market.version', { version: item.version })}
                </small>
              </div>
              <span
                class="status-pill"
                class:status-pill--ok={item.state === 'installed'}
                class:status-pill--warn={item.state !== 'installed'}
              >
                {t(item.state === 'installed' ? 'market.stateInstalled' : 'market.stateUninstalled')}
              </span>
              {#if item.revoked}
                <span class="status-pill status-pill--danger">
                  <Icon name="alert" size={12} />
                  {t('market.revoked')}
                </span>
              {/if}
              {#if item.updateAvailable}
                <span class="status-pill status-pill--accent">
                  {t('market.updateAvailable')}
                  {#if item.latestVersion}
                    · {t('market.latestVersion', { version: item.latestVersion })}
                  {/if}
                </span>
              {/if}
            </div>

            {#if item.needsAttention}
              <div class="market-attention">
                <span class="market-attention__label">
                  <Icon name="alert" size={14} />
                  {t('market.needsAttention')}
                </span>
                <ul>
                  {#each item.attention as note}
                    <li>{attentionLabel(note)}</li>
                  {/each}
                </ul>
              </div>
            {/if}

            {#if item.revoked}
              <p class="market-revoked-note">{t('market.revokedBody')}</p>
            {/if}

            <div class="market-installed__meta">
              <span>{t('market.fileCount', { count: item.fileCount })}</span>
              {#if item.configPath}
                <span class="market-mono">{item.configPath}</span>
              {/if}
              <span>{formatDate(item.updatedAt)}</span>
            </div>

            <div class="market-installed__actions">
              {#if item.state === 'installed' && item.updateAvailable}
                <button class="btn btn--ghost btn--small" type="button" onclick={() => openUpdate(item)}>
                  <Icon name="arrow-up" size={14} />
                  {t('market.update')}
                </button>
              {/if}
              {#if item.state === 'installed'}
                <button
                  class="btn btn--ghost btn--small"
                  type="button"
                  data-testid={`market-uninstall-${item.installId}`}
                  onclick={() => startUninstall(item)}
                >
                  <Icon name="trash" size={14} />
                  {t('market.uninstall')}
                </button>
              {:else}
                <button
                  class="btn btn--ghost btn--small"
                  type="button"
                  data-testid={`market-undo-${item.installId}`}
                  disabled={undoing}
                  onclick={() => undoInstall(item.installId)}
                >
                  <Icon name="rotate" size={14} />
                  {t('market.undo')}
                </button>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  {/if}
{/if}

{#if sheetOpen}
  <div
    class="sheet-scrim"
    role="presentation"
    onclick={closeSheet}
    onkeydown={(event) => {
      if (event.key === 'Escape') closeSheet();
    }}
  >
    <div
      class="sheet market-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="market-sheet-title"
      data-testid="market-sheet"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => event.stopPropagation()}
    >
      <header class="sheet__head">
        <div>
          <p class="kicker">
            {#if sheetView === 'detail' && selected}
              {kindLabel(selected.kind)} · {t('market.version', { version: selected.version })}
            {:else if sheetView === 'preview'}
              {t('market.previewTitle')}
            {:else if sheetView === 'uninstall' || sheetView === 'uninstall-result'}
              {t('market.uninstall')}
            {:else}
              {t('market.details')}
            {/if}
          </p>
          <h2 id="market-sheet-title">
            {#if sheetView === 'detail' && selected}
              {selected.name}
            {:else if sheetView === 'preview' && preview}
              {preview.name}
            {:else if sheetView === 'result' && outcome}
              {t('market.installSuccess', { name: outcome.name })}
            {:else if sheetView === 'uninstall' && uninstallTarget}
              {t('market.uninstallTitle', { name: uninstallTarget.name })}
            {:else if sheetView === 'uninstall-result' && uninstallOutcome}
              {t('market.uninstallSuccess', { name: uninstallOutcome.preview.name })}
            {:else}
              {t('market.details')}
            {/if}
          </h2>
        </div>
        <button class="icon-button" type="button" aria-label={t('common.close')} onclick={closeSheet}>
          <Icon name="close" size={19} />
        </button>
      </header>

      <div class="sheet__body market-sheet__body">
        {#if sheetView === 'detail' && selected}
          <div class="market-detail-badges">
            <span class={`status-pill ${trustClass(selected.trust)}`}>
              <Icon name={selected.trust === 'unreviewed' ? 'alert' : 'shield'} size={13} />
              {t(trustKey(selected.trust))}
            </span>
            {#if selected.example}
              <span class="market-badge">{t('market.example')}</span>
            {/if}
            {#if selected.revoked}
              <span class="status-pill status-pill--danger">{t('market.revoked')}</span>
            {/if}
            {#if selected.installed}
              <span class="status-pill status-pill--ok">
                <Icon name="check" size={13} />
                {selected.installedVersion
                  ? t('market.installedVersion', { version: selected.installedVersion })
                  : t('market.installed')}
              </span>
            {/if}
            {#if selected.updateAvailable}
              <span class="status-pill status-pill--accent">{t('market.updateAvailable')}</span>
            {/if}
          </div>

          <p class="market-detail-lede">{selected.longDescription}</p>
          <p class="market-tier-note">{trustNote(selected.trust)}</p>

          {#if selected.revoked}
            <div class="market-warning market-warning--danger">
              <strong>{t('market.revokedTitle')}</strong>
              <p>{t('market.revokedBody')}</p>
            </div>
          {/if}

          {#if selected.example}
            <p class="market-example-note">{t('market.exampleNote')}</p>
          {/if}

          {#if detailLoading}
            <p class="market-muted">{t('common.loading')}</p>
          {/if}
          {#if detailError}
            <div class="market-warning market-warning--danger">
              <p>{detailError}</p>
            </div>
          {/if}

          <section class="sheet-section">
            <div class="sheet-section__head">
              <h3>{t('market.permissions')}</h3>
              <p>{t('market.scanNote')}</p>
            </div>
            {#if selected.permissions.length === 0}
              <p class="market-muted">{t('market.noPermissions')}</p>
            {:else}
              <ul class="market-permissions">
                {#each selected.permissions as permission (permission.id)}
                  <li>
                    <Icon name="shield" size={15} />
                    <div>
                      <strong>{permission.id}</strong>
                      <p>{permission.description}</p>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>

          <section class="sheet-section">
            <div class="sheet-section__head">
              <h3>{t('market.supportedAgents')}</h3>
            </div>
            <div class="market-support-list">
              {#each selected.support as support (support.agent)}
                <div class="market-support">
                  <span class="market-support__icon"><Icon name="terminal" size={15} /></span>
                  <div class="market-support__text">
                    <strong>{support.name}</strong>
                    <small>{supportLabel(support)}</small>
                  </div>
                  {#if support.verified}
                    <span class="status-pill status-pill--ok">{t('market.targetVerified')}</span>
                  {:else}
                    <span class="status-pill status-pill--warn">{t('market.manualOnly')}</span>
                  {/if}
                </div>
              {/each}
              {#if selected.support.length === 0}
                <p class="market-muted">{t('market.noAgents')}</p>
              {/if}
            </div>
          </section>

          {#if detail}
            <section class="sheet-section">
              <div class="sheet-section__head">
                <h3>{t('market.source')}</h3>
              </div>
              <dl class="summary-list">
                <div>
                  <dt>{t('market.source')}</dt>
                  <dd>
                    <a class="text-link" href={detail.source.repo} target="_blank" rel="noreferrer noopener">
                      {detail.source.repo.replace('https://github.com/', '')}
                      <Icon name="external" size={13} />
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>{t('market.commit')}</dt>
                  <dd><span class="market-mono">{detail.source.commit.slice(0, 12)}</span></dd>
                </div>
                <div>
                  <dt>{t('market.license')}</dt>
                  <dd>{detail.license}</dd>
                </div>
                {#if detail.reviewedOn}
                  <div>
                    <dt>{t('market.reviewed')}</dt>
                    <dd>{detail.reviewedOn}</dd>
                  </div>
                {/if}
                {#if detail.reviewer}
                  <div>
                    <dt>{t('market.reviewer')}</dt>
                    <dd>
                      {t('market.reviewedBy', { name: detail.reviewer.name })}
                      {#if detail.reviewer.ciPassed}
                        · {t('market.ciPassed')}
                      {/if}
                    </dd>
                  </div>
                {/if}
                {#if detail.homepage}
                  <div>
                    <dt>{t('market.openSource')}</dt>
                    <dd>
                      <a class="text-link" href={detail.homepage} target="_blank" rel="noreferrer noopener">
                        {detail.homepage}
                        <Icon name="external" size={13} />
                      </a>
                    </dd>
                  </div>
                {/if}
              </dl>
              <div class="market-file-chips">
                {#each detail.source.files as file}
                  <span class="market-file-chip"><Icon name="logs" size={12} /> {file}</span>
                {/each}
              </div>
            </section>

            <section class="sheet-section">
              <div class="sheet-section__head">
                <h3>{t('market.readme')}</h3>
                <p>{t('market.scanNote')}</p>
              </div>
              <pre class="market-readme">{detail.readme}</pre>
            </section>
          {/if}

          <details class="market-policy">
            <summary>{t('market.policy')}</summary>
            <p>{t('market.policyBody')}</p>
          </details>
        {:else if sheetView === 'preview'}
          {#if previewLoading}
            <p class="market-muted market-preview-loading">
              <Icon name="refresh" size={16} />
              {t('market.previewLoading')}
            </p>
          {:else if previewError}
            <div class="market-warning market-warning--danger">
              <p>{previewError}</p>
            </div>
            <button class="btn btn--ghost" type="button" onclick={startPreview}>
              {t('market.tryAgain')}
            </button>
          {:else if preview}
            <div class="market-detail-badges">
              <span class={`status-pill ${trustClass(preview.trust)}`}>
                <Icon name={preview.trust === 'unreviewed' ? 'alert' : 'shield'} size={13} />
                {t(trustKey(preview.trust))}
              </span>
              <span class="status-pill">{preview.license}</span>
              <span class="status-pill">{agentLabel(preview.agent)}</span>
              <span class="status-pill">{scopeLabel(preview.scope)}</span>
              <span class="status-pill">{formatBytes(preview.totalBytes)}</span>
            </div>

            <p class="market-detail-lede">{t('market.previewBody')}</p>

            {#if preview.update}
              <div class="market-warning">
                <strong>{t('market.previewUpdate')}</strong>
                <p>{t('market.previewUpdateBody')}</p>
              </div>
            {/if}

            {#if preview.manual}
              <section class="sheet-section">
                <div class="sheet-section__head">
                  <h3>{t('market.manualOnly')}</h3>
                  <p>{t('market.manualReason', { agent: agentLabel(preview.agent) })}</p>
                </div>
                <p class="market-muted">{preview.manual.reason}</p>
                <dl class="summary-list">
                  <div>
                    <dt>{t('market.manualPath')}</dt>
                    <dd><span class="market-mono">{preview.manual.path}</span></dd>
                  </div>
                </dl>
                <ol class="market-steps">
                  {#each preview.manual.steps as step}
                    <li>{step}</li>
                  {/each}
                </ol>
                <div class="market-command">
                  <div class="market-command__head">
                    <span>{t('market.copyInstructions')}</span>
                    <button
                      class="text-link"
                      type="button"
                      onclick={() => copySnippet(preview?.manual?.snippet ?? '')}
                    >
                      <Icon name="copy" size={14} />
                      {t('common.copy')}
                    </button>
                  </div>
                  <pre>{preview.manual.snippet}</pre>
                </div>
                <p class="market-muted">{t('market.hostOnly')}</p>
              </section>
            {:else}
              {#if preview.warnings.length > 0}
                <div class="market-warning">
                  <strong>{t('market.warnings')}</strong>
                  <ul>
                    {#each preview.warnings as warning}
                      <li>{warning}</li>
                    {/each}
                  </ul>
                </div>
              {/if}

              {#if preview.conflicts.length > 0}
                <div class="market-warning market-warning--danger">
                  <strong>{t('market.conflicts')}</strong>
                  <ul>
                    {#each preview.conflicts as conflict}
                      <li class="market-mono">{conflict}</li>
                    {/each}
                  </ul>
                </div>
              {/if}

              <section class="sheet-section">
                <div class="sheet-section__head">
                  <h3>{t('market.willWrite')}</h3>
                  <p>{t('market.files')} · {t('market.fileCount', { count: preview.files.length })}</p>
                </div>
                {#if preview.files.length === 0}
                  <p class="market-muted">{t('market.noFiles')}</p>
                {:else}
                  <ul class="market-preview-files">
                    {#each preview.files as file (file.path)}
                      <li>
                        <div class="market-preview-file__head">
                          <span class="market-mono">{file.displayPath}</span>
                          <span class={`status-pill ${actionClass(file.action)}`}>
                            {t(actionKey(file.action))}
                          </span>
                          <span class="market-muted">{formatBytes(file.size)}</span>
                        </div>
                        {#if file.binary}
                          <p class="market-muted">{t('market.binaryFile')}</p>
                        {:else if file.diff}
                          <details class="market-diff">
                            <summary>{t('market.showDiff')}</summary>
                            <pre>{#each diffLines(file.diff) as row}<span class={`market-diff__line is-${row.tone}`}>{row.line || ' '}</span>{/each}</pre>
                          </details>
                        {:else if file.content}
                          <details class="market-diff">
                            <summary>{t('market.showDiff')}</summary>
                            <pre>{file.content}</pre>
                          </details>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>

              {#if preview.config}
                <section class="sheet-section">
                  <div class="sheet-section__head">
                    <h3>{t('market.willConfigure')}</h3>
                    <p class="market-mono">{preview.config.displayPath}</p>
                  </div>
                  <p class="market-muted">
                    {t('market.configKeys')}: <span class="market-mono">{preview.config.keyPath.join(' · ')}</span>
                  </p>
                  <pre class="market-diff-block">{#each diffLines(preview.config.diff) as row}<span class={`market-diff__line is-${row.tone}`}>{row.line || ' '}</span>{/each}</pre>
                </section>
              {/if}

              {#if preview.command}
                <section class="sheet-section">
                  <div class="sheet-section__head">
                    <h3>{t('market.command')}</h3>
                  </div>
                  <div class="market-command">
                    <pre>{preview.command}</pre>
                  </div>
                  <p class="market-command-warning">
                    <Icon name="alert" size={15} />
                    {preview.commandWarning ?? t('market.commandWarning')}
                  </p>
                </section>
              {/if}

              <section class="sheet-section">
                <div class="sheet-section__head">
                  <h3>{t('market.permissions')}</h3>
                </div>
                {#if preview.permissions.length === 0}
                  <p class="market-muted">{t('market.noPermissions')}</p>
                {:else}
                  <ul class="market-permissions">
                    {#each preview.permissions as permission (permission.id)}
                      <li>
                        <Icon name="shield" size={15} />
                        <div>
                          <strong>{permission.id}</strong>
                          <p>{permission.description}</p>
                        </div>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>

              {#if preview.secretNames.length > 0}
                <section class="sheet-section">
                  <div class="sheet-section__head">
                    <h3>{t('market.secrets')}</h3>
                    <p>{t('market.secretsBody')}</p>
                  </div>
                  <div class="market-secrets">
                    {#each preview.secretNames as name}
                      <label class="market-secret">
                        <span class="market-mono">{name}</span>
                        <input
                          type="password"
                          autocomplete="off"
                          spellcheck="false"
                          data-testid={`market-secret-${name}`}
                          placeholder={t('market.secretPlaceholder', { name })}
                          value={secrets[name] ?? ''}
                          oninput={(event) => {
                            secrets = {
                              ...secrets,
                              [name]: (event.currentTarget as HTMLInputElement).value,
                            };
                          }}
                        />
                      </label>
                    {/each}
                  </div>
                  {#if missingSecret}
                    <p class="market-warning-text">{t('market.secretRequired')}</p>
                  {/if}
                </section>
              {/if}

              <p class="market-scan-note">{t('market.scanNote')}</p>
            {/if}

            {#if installError}
              <div class="market-warning market-warning--danger" role="alert">
                <p>{installError}</p>
              </div>
            {/if}
          {/if}
        {:else if sheetView === 'result' && outcome}
          <div class="market-result">
            <span class="market-result__icon"><Icon name="check" size={26} /></span>
            <h3>{t('market.installSuccess', { name: outcome.name })}</h3>
            <p>{t('market.installSuccessBody', { count: outcome.filesWritten, agent: agentLabel(outcome.agent) })}</p>
            {#if outcome.configPath}
              <p class="market-mono">{t('market.configUpdated', { path: outcome.configPath })}</p>
            {/if}
            {#if outcome.warnings.length > 0}
              <div class="market-warning">
                <ul>
                  {#each outcome.warnings as warning}
                    <li>{warning}</li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if installError}
              <div class="market-warning market-warning--danger" role="alert">
                <p>{installError}</p>
              </div>
            {/if}
          </div>
        {:else if sheetView === 'uninstall'}
          {#if uninstallLoading}
            <p class="market-muted market-preview-loading">
              <Icon name="refresh" size={16} />
              {t('common.loading')}
            </p>
          {:else if uninstallError}
            <div class="market-warning market-warning--danger">
              <p>{uninstallError}</p>
            </div>
          {:else if uninstallPreview}
            <p class="market-detail-lede">{t('market.uninstallBody')}</p>
            <dl class="summary-list">
              <div>
                <dt>{t('market.filesToRemove')}</dt>
                <dd>{uninstallPreview.filesToRemove.length}</dd>
              </div>
              <div>
                <dt>{t('market.configAction')}</dt>
                <dd>
                  {uninstallPreview.configAction === 'remove'
                    ? t('market.configActionRemove')
                    : t('market.configActionKeep')}
                </dd>
              </div>
            </dl>
            {#if uninstallPreview.filesToRemove.length > 0}
              <ul class="market-file-list">
                {#each uninstallPreview.filesToRemove as file}
                  <li class="market-mono">{file}</li>
                {/each}
              </ul>
            {:else}
              <p class="market-muted">{t('market.noFilesToRemove')}</p>
            {/if}
            {#if uninstallPreview.filesEdited.length > 0}
              <div class="market-warning market-warning--danger">
                <strong>{t('market.filesEdited')}</strong>
                <ul>
                  {#each uninstallPreview.filesEdited as file}
                    <li class="market-mono">{file}</li>
                  {/each}
                </ul>
                <p>{t('market.editedWarning')}</p>
              </div>
            {/if}
            {#if uninstallPreview.filesMissing.length > 0}
              <div class="market-warning">
                <strong>{t('market.filesMissing')}</strong>
                <ul>
                  {#each uninstallPreview.filesMissing as file}
                    <li class="market-mono">{file}</li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#if uninstallPreview.needsConfirmation}
              <label class="market-check">
                <input type="checkbox" bind:checked={confirmEdited} />
                <span>{t('market.removeAnyway')}</span>
              </label>
            {/if}
            {#if uninstallError}
              <div class="market-warning market-warning--danger" role="alert">
                <p>{uninstallError}</p>
              </div>
            {/if}
          {/if}
        {:else if sheetView === 'uninstall-result' && uninstallOutcome}
          <div class="market-result">
            <span class="market-result__icon"><Icon name="check" size={26} /></span>
            <h3>{t('market.uninstallSuccess', { name: uninstallOutcome.preview.name })}</h3>
            <p>{t('market.uninstallSuccessBody')}</p>
            {#if installError}
              <div class="market-warning market-warning--danger" role="alert">
                <p>{installError}</p>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <footer class="market-sheet__foot">
        {#if sheetView === 'detail' && selected}
          {#if selected.revoked}
            {#if selected.installed}
              <button
                class="btn btn--primary"
                type="button"
                onclick={() => {
                  const item = installedEntries.find(
                    (entry) =>
                      entry.kind === selected?.kind &&
                      entry.entryId === selected?.id &&
                      entry.state === 'installed',
                  );
                  if (item) void startUninstall(item);
                }}
              >
                <Icon name="trash" size={15} />
                {t('market.removeNow')}
              </button>
            {/if}
          {:else if selected.support.length === 0}
            <p class="market-muted">{t('market.noAgents')}</p>
          {:else}
            <label class="market-select market-select--compact">
              <span>{t('market.chooseAgent')}</span>
              <select value={selectedAgent} onchange={onAgentChange} aria-label={t('market.chooseAgent')}>
                {#each selected.support as support (support.agent)}
                  <option value={support.agent} disabled={!support.available}>
                    {support.name}{support.verified ? '' : ` · ${t('market.manualOnly')}`}
                  </option>
                {/each}
              </select>
            </label>
            <label class="market-select market-select--compact">
              <span>{t('market.chooseScope')}</span>
              <select value={selectedScope} onchange={onScopeChange} aria-label={t('market.chooseScope')}>
                {#each selectedScopes as scope}
                  <option value={scope}>{scopeLabel(scope)}</option>
                {/each}
              </select>
            </label>
            <button
              class="btn btn--primary"
              type="button"
              data-testid="market-preview-button"
              disabled={!selectedAgent}
              onclick={startPreview}
            >
              <Icon name="eye" size={15} />
              {installActionLabel(selected)}
            </button>
          {/if}
        {:else if sheetView === 'preview'}
          <button class="btn btn--ghost" type="button" onclick={() => (sheetView = 'detail')}>
            <Icon name="arrow-left" size={15} />
            {t('market.back')}
          </button>
          {#if preview && !preview.manual}
            <button
              class="btn btn--primary"
              type="button"
              data-testid="market-confirm-install"
              disabled={!canInstall || installing}
              onclick={confirmInstall}
            >
              <Icon name="download" size={15} />
              {installing ? t('market.installing') : t('market.confirmInstall')}
            </button>
          {:else}
            <button class="btn btn--primary" type="button" onclick={closeSheet}>
              {t('common.close')}
            </button>
          {/if}
        {:else if sheetView === 'result' && outcome}
          <button
            class="btn btn--ghost"
            type="button"
            data-testid="market-undo-result"
            disabled={undoing || !outcome.undoAvailable}
            onclick={() => undoInstall(outcome?.installId ?? '')}
          >
            <Icon name="rotate" size={15} />
            {undoing ? t('market.undoing') : t('market.undo')}
          </button>
          <button class="btn btn--primary" type="button" onclick={closeSheet}>
            {t('market.done')}
          </button>
        {:else if sheetView === 'uninstall' && uninstallPreview}
          <button class="btn btn--ghost" type="button" onclick={closeSheet}>
            {t('market.cancel')}
          </button>
          <button
            class="btn btn--primary"
            type="button"
            data-testid="market-confirm-uninstall"
            disabled={uninstalling || (uninstallPreview.needsConfirmation && !confirmEdited)}
            onclick={confirmUninstall}
          >
            <Icon name="trash" size={15} />
            {uninstalling ? t('market.uninstalling') : t('market.confirmUninstall')}
          </button>
        {:else if sheetView === 'uninstall-result' && uninstallOutcome}
          <button
            class="btn btn--ghost"
            type="button"
            data-testid="market-undo-uninstall"
            disabled={undoing || !uninstallOutcome.undoAvailable}
            onclick={() => undoInstall(uninstallOutcome?.preview.installId ?? '')}
          >
            <Icon name="rotate" size={15} />
            {undoing ? t('market.undoing') : t('market.undo')}
          </button>
          <button class="btn btn--primary" type="button" onclick={closeSheet}>
            {t('market.done')}
          </button>
        {:else}
          <button class="btn btn--ghost" type="button" onclick={closeSheet}>
            {t('common.close')}
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}
