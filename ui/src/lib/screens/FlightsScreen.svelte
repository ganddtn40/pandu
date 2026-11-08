<script lang="ts">
  import Icon from '../Icon.svelte';
  import { daemonApi } from '../api/client';
  import {
    daemonErrorMessage,
    daemonState,
    refreshDaemon,
    seedDemoData,
  } from '../api/daemon.svelte';
  import type {
    ReplayResponse,
    Session,
    SnapshotDetailResponse,
    Step,
    StepDetail,
  } from '../api/types';
  import {
    formatDate,
    formatDuration,
    formatTokens,
    formatUsd,
    statusKey,
    timeAgo,
  } from '../format';
  import { copyText } from '../clipboard';
  import { t } from '../i18n/i18n.svelte';
  import { openQuickPrompt } from '../quick-prompt.svelte';
  import { navigate, routeParam } from '../router.svelte';
  import { toast } from '../toast-store.svelte';

  type Filter = 'all' | 'active' | 'completed' | 'failed';
  type Tab = 'output' | 'timeline' | 'snapshots';
  type OutputKind = 'text' | 'thinking' | 'tool' | 'error' | 'live';

  interface OutputBlock {
    key: string;
    label: string;
    kind: OutputKind;
    text: string;
  }

  const FILTERS: Array<{ id: Filter; label: 'common.all' | 'common.active' | 'common.completed' | 'common.failed' }> = [
    { id: 'all', label: 'common.all' },
    { id: 'active', label: 'common.active' },
    { id: 'completed', label: 'common.completed' },
    { id: 'failed', label: 'common.failed' },
  ];

  let selectedId = $state<string | null>(routeParam('session'));
  let replay = $state<ReplayResponse | null>(null);
  let details = $state<Record<string, StepDetail>>({});
  let snapshotDetails = $state<Record<string, SnapshotDetailResponse>>({});
  let snapshotLoading = $state<Record<string, boolean>>({});
  let snapshotErrors = $state<Record<string, string>>({});
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let selectedStepId = $state<string | null>(null);
  let tab = $state<Tab>('output');
  let filter = $state<Filter>('all');
  let query = $state('');
  let playing = $state(false);
  let replayIndex = $state(0);
  let liveBaseline = $state(0);
  let loadingDemo = $state(false);
  let loadToken = 0;

  const demo = $derived(daemonState.health?.demoMode === true);
  const offline = $derived(daemonState.status === 'offline' && daemonState.sessions.length === 0);

  const sessions = $derived.by(() => {
    const term = query.trim().toLowerCase();
    return daemonState.sessions.filter((session) => {
      if (filter !== 'all' && session.status !== filter) return false;
      if (!term) return true;
      return [session.title, session.agent?.name, session.provider, session.workspacePath, session.model]
        .filter((value): value is string => typeof value === 'string')
        .some((value) => value.toLowerCase().includes(term));
    });
  });

  const selectedSession = $derived(
    replay?.session ?? daemonState.sessions.find((session) => session.id === selectedId) ?? null,
  );
  const visibleSteps = $derived(replay ? replay.steps.slice(0, replayIndex) : []);
  const selectedStep = $derived(
    replay?.steps.find((step) => step.id === selectedStepId) ?? null,
  );
  const selectedDetail = $derived(
    selectedStepId ? (details[selectedStepId] ?? null) : null,
  );

  const outputBlocks = $derived.by((): OutputBlock[] => {
    if (!replay) return [];
    const blocks: OutputBlock[] = [];
    for (const step of replay.steps) {
      const detail = details[step.id];
      const label = t('flights.step', { seq: step.seq });
      if (!detail) {
        const text = step.response?.text?.trim();
        if (text) blocks.push({ key: step.id, label, kind: 'text', text });
        continue;
      }

      let buffer = '';
      let bufferKind: 'text' | 'thinking' = 'text';
      const flush = (): void => {
        if (!buffer.trim()) {
          buffer = '';
          return;
        }
        blocks.push({
          key: `${step.id}-${blocks.length}`,
          label,
          kind: bufferKind,
          text: buffer,
        });
        buffer = '';
      };

      for (const chunk of detail.streamChunks) {
        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          if (chunk.kind !== bufferKind) {
            flush();
            bufferKind = chunk.kind;
          }
          buffer += chunk.deltaText ?? chunk.data ?? '';
          continue;
        }
        flush();
        if (chunk.kind === 'error' || chunk.kind === 'tool_call') {
          const text = (chunk.deltaText ?? chunk.data ?? '').trim();
          if (text) {
            blocks.push({
              key: `${step.id}-${chunk.id}`,
              label,
              kind: chunk.kind === 'error' ? 'error' : 'tool',
              text,
            });
          }
        }
      }
      flush();

      if (detail.streamChunks.length === 0) {
        const thinking = step.response?.thinking?.trim();
        if (thinking) {
          blocks.push({ key: `${step.id}-thinking`, label, kind: 'thinking', text: thinking });
        }
        const text = step.response?.text?.trim();
        if (text) blocks.push({ key: `${step.id}-text`, label, kind: 'text', text });
      }
    }
    return blocks;
  });

  const liveText = $derived.by(() => {
    if (!selectedSession || selectedSession.status !== 'active') return '';
    return daemonState.liveEvents
      .filter(
        (event) =>
          event.type === 'stream.chunk' &&
          event.sessionId === selectedSession.id &&
          event.sequence > liveBaseline,
      )
      .map((event) => {
        const delta = event.payload.deltaText;
        return typeof delta === 'string' ? delta : '';
      })
      .join('');
  });

  const hasOutput = $derived(outputBlocks.length > 0 || liveText.trim().length > 0);

  // Keep the URL and the selected flight in step. `?session=<id>` is a real
  // deep link: reloading or sharing it opens the same flight.
  $effect(() => {
    const id = routeParam('session');
    if (id === selectedId) return;
    selectedId = id;
    selectedStepId = null;
    tab = 'output';
  });

  $effect(() => {
    const id = selectedId;
    if (!id) {
      replay = null;
      details = {};
      snapshotDetails = {};
      snapshotLoading = {};
      snapshotErrors = {};
      selectedStepId = null;
      loadError = null;
      loading = false;
      return;
    }
    replay = null;
    details = {};
    snapshotDetails = {};
    snapshotLoading = {};
    snapshotErrors = {};
    selectedStepId = null;
    void loadFlight(id);
  });

  $effect(() => {
    if (!selectedStepId || details[selectedStepId]) return;
    void loadStepDetail(selectedStepId);
  });

  $effect(() => {
    if (!playing || !replay) return;
    const timer = window.setInterval(() => {
      if (!replay || replayIndex >= replay.steps.length) {
        playing = false;
        return;
      }
      replayIndex += 1;
    }, 700);
    return () => window.clearInterval(timer);
  });

  async function loadFlight(id: string): Promise<void> {
    const token = ++loadToken;
    loading = true;
    loadError = null;
    try {
      const data = await daemonApi.replay(id);
      if (token !== loadToken) return;
      replay = data;
      replayIndex = data.steps.length;
      playing = false;
      liveBaseline = daemonState.liveEvents.at(-1)?.sequence ?? 0;
      details = {};
      selectedStepId = data.steps.at(-1)?.id ?? null;

      const wanted = data.steps
        .filter((step) => step.kind === 'model' || step.kind === 'tool')
        .slice(-12);
      const results = await Promise.allSettled(
        wanted.map((step) => daemonApi.step(step.id)),
      );
      if (token !== loadToken) return;
      const map: Record<string, StepDetail> = {};
      for (const result of results) {
        if (result.status === 'fulfilled') map[result.value.step.id] = result.value;
      }
      details = map;
    } catch (error) {
      if (token !== loadToken) return;
      replay = null;
      loadError = daemonErrorMessage(error);
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  async function loadStepDetail(stepId: string): Promise<void> {
    try {
      const detail = await daemonApi.step(stepId);
      details = { ...details, [detail.step.id]: detail };
    } catch {
      // The timeline still works without the detail body.
    }
  }

  // Replay responses carry snapshot summaries only. The patch and per-file
  // changes are fetched the first time a snapshot is expanded, so a long
  // session does not ship every diff up front.
  async function loadSnapshot(snapshotId: string): Promise<void> {
    if (snapshotDetails[snapshotId] || snapshotLoading[snapshotId]) return;
    snapshotLoading = { ...snapshotLoading, [snapshotId]: true };
    snapshotErrors = { ...snapshotErrors, [snapshotId]: '' };
    try {
      const detail = await daemonApi.snapshot(snapshotId);
      snapshotDetails = { ...snapshotDetails, [snapshotId]: detail };
    } catch (error) {
      snapshotErrors = { ...snapshotErrors, [snapshotId]: daemonErrorMessage(error) };
    } finally {
      snapshotLoading = { ...snapshotLoading, [snapshotId]: false };
    }
  }

  function onSnapshotToggle(snapshotId: string, event: Event): void {
    const detailsElement = event.currentTarget as HTMLDetailsElement | null;
    if (detailsElement?.open) void loadSnapshot(snapshotId);
  }

  function openFlight(session: Session): void {
    if (session.captureMode === 'pty') {
      navigate(`/session?id=${encodeURIComponent(session.id)}`);
      return;
    }
    navigate(`/flights?session=${encodeURIComponent(session.id)}`);
  }

  function closeFlight(): void {
    navigate('/flights', { keepSearch: false });
  }

  function selectStep(step: Step): void {
    selectedStepId = step.id;
  }

  function togglePlay(): void {
    if (!replay) return;
    if (playing) {
      playing = false;
      return;
    }
    if (replayIndex >= replay.steps.length) replayIndex = 0;
    playing = true;
  }

  function onScrub(event: Event): void {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(value)) replayIndex = value;
  }

  function sessionAgent(session: Session): string {
    return session.agent?.name?.trim() || session.provider || t('common.unknown');
  }

  function sessionTokens(session: Session): number {
    const totals = session.totals;
    return (
      totals.inputTokens +
      totals.outputTokens +
      totals.cacheReadTokens +
      totals.cacheWriteTokens +
      totals.reasoningTokens
    );
  }

  function isDemoSession(session: Session): boolean {
    return session.source === 'demo' || session.metadata?.demo === true;
  }

  function statusClass(status: string): string {
    if (status === 'completed') return 'status-pill--ok';
    if (status === 'active') return 'status-pill--live';
    if (status === 'failed' || status === 'killed') return 'status-pill--danger';
    return '';
  }

  function stepClass(step: Step): string {
    if (step.status === 'completed') return 'status-pill--ok';
    if (step.status === 'running') return 'status-pill--live';
    if (step.status === 'failed' || step.status === 'blocked') return 'status-pill--danger';
    if (step.status === 'cancelled') return 'status-pill--warn';
    return '';
  }

  function pretty(value: unknown): string {
    if (value === undefined || value === null) return '';
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return text.length > 12_000 ? `${text.slice(0, 12_000)}…` : text;
    } catch {
      return String(value);
    }
  }

  function requestText(detail: StepDetail): string {
    return (
      detail.step.request?.promptText?.trim() ||
      detail.step.request?.systemPrompt?.trim() ||
      pretty(detail.step.request?.body)
    );
  }

  function responseText(detail: StepDetail): string {
    return detail.step.response?.text?.trim() || pretty(detail.step.response?.body);
  }

  async function loadDemo(): Promise<void> {
    loadingDemo = true;
    try {
      await seedDemoData();
      toast(t('flights.loadedDemo'));
    } catch {
      toast(t('common.offline'));
    } finally {
      loadingDemo = false;
    }
  }

  async function retry(): Promise<void> {
    await refreshDaemon();
    if (selectedId) await loadFlight(selectedId);
  }

  async function copyBranch(branch: string): Promise<void> {
    if (await copyText(branch)) toast(t('common.copied'));
    else toast(t('common.copyFailed'));
  }
</script>

<div class="flights-screen" class:is-detail={selectedId !== null}>
<div class="screen-head">
  <div>
    <p class="kicker">{t('flights.kicker')}</p>
    <h1>{t('flights.title')}</h1>
    <p class="screen-lede">{t('flights.lede')}</p>
  </div>
  <div class="screen-actions">
    {#if demo}
      <span class="status-pill status-pill--demo">{t('topbar.demo')}</span>
    {/if}
    <button class="btn btn--ghost" type="button" onclick={retry} disabled={daemonState.loading}>
      <Icon name="refresh" size={16} />
      {t('flights.refresh')}
    </button>
    <button class="btn btn--primary" type="button" onclick={openQuickPrompt}>
      <Icon name="sparkles" size={16} />
      {t('flights.newFlight')}
    </button>
  </div>
</div>

{#if offline}
  <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
    <span class="empty-state__icon"><Icon name="alert" size={24} /></span>
    <h2>{t('home.offlineTitle')}</h2>
    <p>{t('home.offlineBody')}</p>
    <button class="btn btn--primary" type="button" onclick={retry} disabled={daemonState.loading}>
      <Icon name="refresh" size={16} />
      {t('home.offlineAction')}
    </button>
  </section>
{:else}
  <div class="flights-toolbar">
    <div class="segmented" role="group" aria-label={t('flights.filters')}>
      {#each FILTERS as item}
        <button
          class="segmented__item"
          class:is-active={filter === item.id}
          type="button"
          aria-pressed={filter === item.id}
          onclick={() => (filter = item.id)}
        >
          {t(item.label)}
        </button>
      {/each}
    </div>
    <label class="search-field">
      <Icon name="search" size={16} />
      <span class="sr-only">{t('flights.searchPlaceholder')}</span>
      <input type="search" bind:value={query} placeholder={t('flights.searchPlaceholder')} />
    </label>
    <span class="flights-toolbar__count">{t('flights.count', { count: sessions.length })}</span>
  </div>

  <div class="flights-layout" class:has-detail={selectedId !== null}>
    <section class="flight-list card" aria-label={t('flights.title')} data-glass data-glass-layer="card" data-glass-depth="2">
      {#if sessions.length > 0}
        {#each sessions as session (session.id)}
          <button
            class="flight-row"
            class:is-active={selectedId === session.id}
            type="button"
            aria-current={selectedId === session.id ? 'true' : undefined}
            onclick={() => openFlight(session)}
          >
            <span class="flight-row__icon"><Icon name={session.captureMode === 'pty' ? 'terminal' : 'plane'} size={17} /></span>
            <span class="flight-row__main">
              <span class="flight-row__title">
                <strong>{session.title}</strong>
                {#if isDemoSession(session)}
                  <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
                {/if}
              </span>
              <span class="flight-row__meta">
                {sessionAgent(session)} · {timeAgo(session.startedAt, t)} · {session.captureMode === 'pty'
                  ? t('flights.liveTerminal')
                  : t('flights.steps', { count: session.totals.stepCount })}
              </span>
            </span>
            <span class="flight-row__side">
              <span class="status-pill {statusClass(session.status)}">{t(statusKey(session.status))}</span>
              <span class="flight-row__cost">{formatUsd(session.totals.totalCostUsd, session.totals.unknownCostCalls, t('common.priceUnknown'))}</span>
            </span>
          </button>
        {/each}
      {:else if daemonState.sessions.length === 0}
        <div class="flight-list__empty">
          <span class="empty-state__icon"><Icon name="plane" size={22} /></span>
          <h2>{t('flights.emptyTitle')}</h2>
          <p>{t('flights.emptyBody')}</p>
          <div class="button-row">
            <button class="btn btn--primary" type="button" onclick={openQuickPrompt}>
              <Icon name="sparkles" size={16} />
              {t('flights.newFlight')}
            </button>
            {#if demo}
              <button class="btn btn--ghost" type="button" onclick={loadDemo} disabled={loadingDemo}>
                <Icon name="play" size={16} />
                {t('flights.loadDemo')}
              </button>
            {/if}
          </div>
        </div>
      {:else}
        <div class="flight-list__empty">
          <span class="empty-state__icon"><Icon name="search" size={22} /></span>
          <h2>{t('flights.emptyFilterTitle')}</h2>
          <p>{t('flights.emptyFilterBody')}</p>
        </div>
      {/if}
    </section>

    {#if selectedId}
      <section class="flight-detail" aria-label={t('flights.stepDetail')}>
        {#if loading && !replay}
          <div class="empty-state card">
            <span class="empty-state__icon"><Icon name="clock" size={22} /></span>
            <p>{t('flights.loadingFlight')}</p>
          </div>
        {:else if loadError}
          <div class="empty-state card">
            <span class="empty-state__icon"><Icon name="alert" size={22} /></span>
            <h2>{t('flights.notFoundTitle')}</h2>
            <p>{loadError}</p>
            <div class="button-row">
              <button class="btn btn--primary" type="button" onclick={() => (selectedId ? loadFlight(selectedId) : undefined)}>
                <Icon name="refresh" size={16} />
                {t('flights.retry')}
              </button>
              <button class="btn btn--ghost" type="button" onclick={closeFlight}>
                <Icon name="arrow-left" size={16} />
                {t('flights.openList')}
              </button>
            </div>
          </div>
        {:else if replay && selectedSession}
          <div class="flight-detail__head">
            <button class="text-link flight-detail__back" type="button" onclick={closeFlight}>
              <Icon name="arrow-left" size={15} />
              {t('flights.openList')}
            </button>
            <div class="flight-detail__title">
              <div class="flight-detail__badges">
                <span class="status-pill {statusClass(selectedSession.status)}">
                  {t(statusKey(selectedSession.status))}
                </span>
                {#if isDemoSession(selectedSession)}
                  <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
                {/if}
                <span class="status-pill">{selectedSession.sourceLabel || selectedSession.source}</span>
              </div>
              <h2>{selectedSession.title}</h2>
              <p>
                {sessionAgent(selectedSession)}
                {#if selectedSession.model} · {selectedSession.model}{/if}
                {#if selectedSession.workspacePath} · {selectedSession.workspacePath}{/if}
              </p>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label={t('flights.refresh')}
              onclick={() => loadFlight(selectedSession.id)}
              disabled={loading}
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>

          <dl class="flight-meta">
            <div><dt>{t('flights.started')}</dt><dd>{formatDate(selectedSession.startedAt)}</dd></div>
            <div><dt>{t('flights.elapsed')}</dt><dd>{formatDuration(selectedSession.durationMs)}</dd></div>
            <div><dt>{t('flights.stepsLabel')}</dt><dd>{selectedSession.totals.stepCount}</dd></div>
            <div><dt>{t('flights.toolCallsLabel')}</dt><dd>{selectedSession.totals.toolCallCount}</dd></div>
            <div><dt>{t('flights.tokensLabel')}</dt><dd>{formatTokens(sessionTokens(selectedSession))}</dd></div>
            <div><dt>{t('common.cost')}</dt><dd>{formatUsd(selectedSession.totals.totalCostUsd, selectedSession.totals.unknownCostCalls, t('common.priceUnknown'))}</dd></div>
            {#if selectedSession.gitBranch}
              <div class="flight-meta__wide">
                <dt>{t('flights.branch')}</dt>
                <dd class="flight-meta__branch">
                  <code title={selectedSession.gitBranch}>{selectedSession.gitBranch}</code>
                  <button
                    class="icon-button icon-button--small"
                    type="button"
                    aria-label={t('common.copy')}
                    onclick={() => copyBranch(selectedSession.gitBranch ?? '')}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                </dd>
              </div>
            {/if}
          </dl>

          <div class="tab-strip" role="tablist" aria-label={t('flights.title')}>
            <button
              class="tab-strip__item"
              class:is-active={tab === 'output'}
              type="button"
              role="tab"
              aria-selected={tab === 'output'}
              onclick={() => (tab = 'output')}
            >
              <Icon name="terminal" size={15} />
              {t('flights.output')}
              {#if selectedSession.status === 'active'}<span class="dot dot--live"></span>{/if}
            </button>
            <button
              class="tab-strip__item"
              class:is-active={tab === 'timeline'}
              type="button"
              role="tab"
              aria-selected={tab === 'timeline'}
              onclick={() => (tab = 'timeline')}
            >
              <Icon name="list" size={15} />
              {t('flights.timeline')}
            </button>
            <button
              class="tab-strip__item"
              class:is-active={tab === 'snapshots'}
              type="button"
              role="tab"
              aria-selected={tab === 'snapshots'}
              onclick={() => (tab = 'snapshots')}
            >
              <Icon name="layers" size={15} />
              {t('flights.snapshots')}
              {#if replay.snapshots.length > 0}<span class="tab-strip__count">{replay.snapshots.length}</span>{/if}
            </button>
          </div>

          {#if tab === 'output'}
            <div class="output-panel">
              {#if !hasOutput}
                <div class="empty-inline">
                  <Icon name="terminal" size={18} />
                  <p>
                    {selectedSession.status === 'active'
                      ? t('flights.waitingOutput')
                      : t('flights.noOutput')}
                  </p>
                </div>
              {:else}
                {#each outputBlocks as block (block.key)}
                  <article class="output-block output-block--{block.kind}">
                    <header>
                      <span>{block.label}</span>
                      <span class="eyebrow">
                        {block.kind === 'thinking'
                          ? t('flights.thinking')
                          : block.kind === 'error'
                            ? t('flights.error')
                            : block.kind === 'tool'
                              ? t('flights.toolCallsTitle')
                              : t('flights.response')}
                      </span>
                    </header>
                    <pre>{block.text}</pre>
                  </article>
                {/each}
                {#if liveText.trim()}
                  <article class="output-block output-block--live">
                    <header>
                      <span class="eyebrow"><span class="dot dot--live"></span> {t('flights.live')}</span>
                      <span>{t('flights.liveHint')}</span>
                    </header>
                    <pre>{liveText}</pre>
                  </article>
                {/if}
              {/if}
            </div>
          {:else if tab === 'timeline'}
            <div class="timeline-controls">
              <button
                class="icon-button timeline-controls__play"
                type="button"
                aria-label={playing ? t('flights.pause') : t('flights.play')}
                onclick={togglePlay}
                disabled={replay.steps.length === 0}
              >
                <Icon name={playing ? 'pause' : 'play'} size={18} />
              </button>
              <div class="timeline-controls__main">
                <div class="timeline-controls__label">
                  <span>{t('flights.replayProgress', { current: replayIndex, total: replay.steps.length })}</span>
                  <span class="eyebrow">{t('flights.replayHint')}</span>
                </div>
                <input
                  class="timeline-controls__range"
                  type="range"
                  min="0"
                  max={replay.steps.length}
                  value={replayIndex}
                  aria-label={t('flights.replayProgress', { current: replayIndex, total: replay.steps.length })}
                  oninput={onScrub}
                />
              </div>
            </div>

            {#if replay.steps.length === 0}
              <div class="empty-inline">
                <Icon name="list" size={18} />
                <p>{t('flights.noSteps')}</p>
              </div>
            {:else}
              <ol class="step-list">
                {#each visibleSteps as step (step.id)}
                  <li>
                    <button
                      class="step-row"
                      class:is-active={selectedStepId === step.id}
                      type="button"
                      onclick={() => selectStep(step)}
                    >
                      <span class="step-row__seq">{step.seq}</span>
                      <span class="step-row__main">
                        <strong>{step.kind}{#if step.model}{` · ${step.model}`}{:else if step.provider}{` · ${step.provider}`}{/if}</strong>
                        <small>
                          {formatDuration(step.durationMs)}
                          · {formatTokens(step.usage.inputTokens + step.usage.outputTokens)} {t('common.tokens')}
                          {#if step.costKnown && step.costUsd !== undefined} · {formatUsd(step.costUsd)}{/if}
                        </small>
                      </span>
                      <span class="status-pill {stepClass(step)}">{t(statusKey(step.status))}</span>
                    </button>
                  </li>
                {/each}
              </ol>
            {/if}

            {#if selectedStep}
              <article class="step-detail card">
                <header class="step-detail__head">
                  <div>
                    <p class="kicker">{t('flights.stepDetail')}</p>
                    <h3>{selectedStep.kind}{#if selectedStep.model}{` · ${selectedStep.model}`}{/if}</h3>
                  </div>
                  <span class="status-pill {stepClass(selectedStep)}">{t(statusKey(selectedStep.status))}</span>
                </header>

                <dl class="summary-list summary-list--tight">
                  {#if selectedStep.model}<div><dt>{t('flights.model')}</dt><dd>{selectedStep.model}</dd></div>{/if}
                  {#if selectedStep.provider}<div><dt>{t('flights.agent')}</dt><dd>{selectedStep.provider}</dd></div>{/if}
                  <div><dt>{t('flights.elapsed')}</dt><dd>{formatDuration(selectedStep.durationMs)}</dd></div>
                  <div><dt>{t('flights.tokensLabel')}</dt><dd>{formatTokens(selectedStep.usage.inputTokens + selectedStep.usage.outputTokens + selectedStep.usage.reasoningTokens)}</dd></div>
                  <div><dt>{t('common.cost')}</dt><dd>{selectedStep.costKnown ? formatUsd(selectedStep.costUsd ?? 0) : t('common.priceUnknown')}</dd></div>
                </dl>

                {#if selectedStep.error}
                  <div class="step-detail__error">
                    <Icon name="alert" size={16} />
                    <pre>{selectedStep.error}</pre>
                  </div>
                {/if}

                {#if selectedDetail}
                  {#if selectedDetail.redactions.length > 0}
                    <section class="step-detail__section">
                      <h4>{t('flights.redactionsTitle')}</h4>
                      <ul class="step-detail__list">
                        {#each selectedDetail.redactions as redaction}
                          <li><code>{redaction.label}</code> · {redaction.location} · {redaction.occurrences}</li>
                        {/each}
                      </ul>
                    </section>
                  {/if}

                  {#if selectedDetail.toolCalls.length > 0}
                    <section class="step-detail__section">
                      <h4>{t('flights.toolCallsTitle')}</h4>
                      {#each selectedDetail.toolCalls as call}
                        <div class="tool-call">
                          <div class="tool-call__head">
                            <strong>{call.name}</strong>
                            <span class="status-pill">{call.status}</span>
                          </div>
                          {#if call.input !== undefined}
                            <pre>{pretty(call.input)}</pre>
                          {/if}
                          {#if call.error}
                            <p class="tool-call__error">{call.error}</p>
                          {/if}
                          {#if call.filePaths.length > 0}
                            <ul class="tool-call__files">
                              {#each call.filePaths as path}<li><code>{path}</code></li>{/each}
                            </ul>
                          {/if}
                        </div>
                      {/each}
                    </section>
                  {/if}

                  <section class="step-detail__section">
                    <h4>{t('flights.request')}</h4>
                    {#if requestText(selectedDetail)}
                      <pre>{requestText(selectedDetail)}</pre>
                    {:else}
                      <p class="step-detail__muted">{t('flights.noRequest')}</p>
                    {/if}
                  </section>

                  <section class="step-detail__section">
                    <h4>{t('flights.response')}</h4>
                    {#if responseText(selectedDetail)}
                      <pre>{responseText(selectedDetail)}</pre>
                    {:else}
                      <p class="step-detail__muted">{t('flights.noResponse')}</p>
                    {/if}
                    {#if selectedDetail.step.response?.thinking}
                      <h4 class="step-detail__subhead">{t('flights.thinking')}</h4>
                      <pre>{selectedDetail.step.response.thinking}</pre>
                    {/if}
                  </section>
                {:else}
                  <div class="empty-inline">
                    <Icon name="clock" size={16} />
                    <p>{t('common.loading')}</p>
                  </div>
                {/if}
              </article>
            {:else}
              <div class="empty-inline">
                <Icon name="info" size={18} />
                <p>{t('flights.noStep')}</p>
              </div>
            {/if}
          {:else}
            {#if replay.snapshots.length === 0}
              <div class="empty-inline">
                <Icon name="layers" size={18} />
                <p>{t('flights.noSnapshots')}</p>
              </div>
            {:else}
              <div class="snapshot-list">
                {#each replay.snapshots as snapshot (snapshot.id)}
                  <article class="snapshot-card card">
                    <header>
                      <span class="snapshot-card__icon"><Icon name="layers" size={16} /></span>
                      <div>
                        <strong>{snapshot.kind}</strong>
                        <small>{t('flights.snapshotAt', { time: timeAgo(snapshot.createdAt, t) })}</small>
                      </div>
                      <span class="snapshot-card__numbers">
                        {t('flights.filesChanged', { count: snapshot.filesChanged })}
                        · <span class="is-add">{t('flights.insertions', { count: snapshot.insertions })}</span>
                        · <span class="is-del">{t('flights.deletions', { count: snapshot.deletions })}</span>
                      </span>
                    </header>
                    <dl class="summary-list summary-list--tight">
                      {#if snapshot.branch}<div><dt>{t('flights.branch')}</dt><dd><code>{snapshot.branch}</code></dd></div>{/if}
                      {#if snapshot.commitSha}<div><dt>{t('flights.commit')}</dt><dd><code>{snapshot.commitSha.slice(0, 12)}</code></dd></div>{/if}
                    </dl>
                    <details
                      class="snapshot-card__patch"
                      ontoggle={(event) => onSnapshotToggle(snapshot.id, event)}
                    >
                      <summary>{t('flights.patch')}</summary>
                      {#if snapshotDetails[snapshot.id]}
                        {@const detail = snapshotDetails[snapshot.id]!}
                        {#if detail.fileChanges.length > 0}
                          <ul class="snapshot-card__files">
                            {#each detail.fileChanges as change (change.id)}
                              <li>
                                <code>{change.path}</code>
                                <span class="is-add">+{change.additions}</span>
                                <span class="is-del">−{change.deletions}</span>
                              </li>
                            {/each}
                          </ul>
                        {/if}
                        {#if detail.snapshot.patch}
                          <pre>{detail.snapshot.patch}</pre>
                        {:else}
                          <p class="snapshot-card__empty">{t('flights.noPatch')}</p>
                        {/if}
                      {:else if snapshotLoading[snapshot.id]}
                        <p class="snapshot-card__empty">{t('common.loading')}</p>
                      {:else if snapshotErrors[snapshot.id]}
                        <p class="snapshot-card__empty">{snapshotErrors[snapshot.id]}</p>
                      {/if}
                    </details>
                  </article>
                {/each}
              </div>
            {/if}
          {/if}
        {/if}
      </section>
    {:else}
      <aside class="flight-hint card" data-glass data-glass-layer="card" data-glass-depth="2">
        <span class="empty-state__icon"><Icon name="plane" size={22} /></span>
        <h2>{t('flights.noSelection')}</h2>
        <p>{t('flights.noSelectionBody')}</p>
        <p class="flight-hint__note">{t('flights.selectHint')}</p>
        <button class="btn btn--ghost" type="button" onclick={openQuickPrompt}>
          <Icon name="sparkles" size={16} />
          {t('flights.newFlight')}
        </button>
      </aside>
    {/if}
  </div>
{/if}
</div>
