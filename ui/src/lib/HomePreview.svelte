<script lang="ts">
  import { onDestroy } from 'svelte';
  import Icon from './Icon.svelte';
  import { activeSessions, daemonState, pendingGuards, refreshDaemon, seedDemoData } from './api/daemon.svelte';
  import type { Session } from './api/types';
  import { openAddAgent } from './add-agent.svelte';
  import {
    moveWidgetBy,
    reorderWidgetBefore,
    resetWidgetLayout,
    toggleWidgetHidden,
    widgetState,
  } from './design/widgets.svelte';
  import { visibleWidgets, type WidgetId } from './design/widgets';
  import {
    formatElapsed,
    formatTokens,
    formatUsd,
    statusKey,
    timeAgo,
  } from './format';
  import { t, type MessageKey } from './i18n/i18n.svelte';
  import { openQuickPrompt } from './quick-prompt.svelte';
  import { navigate } from './router.svelte';
  import { toast } from './toast-store.svelte';

  const labels: Record<WidgetId, MessageKey> = {
    live: 'widgets.live',
    spend: 'widgets.spend',
    tokens: 'widgets.tokens',
    guards: 'widgets.guards',
    approvals: 'widgets.approvals',
    activity: 'widgets.activity',
    recent: 'widgets.recent',
    agents: 'widgets.agents',
  };

  let editing = $state(false);
  let dragId = $state<WidgetId | null>(null);
  let dragPointer = -1;
  let longPressTimer = 0;
  let pressStart = { x: 0, y: 0 };
  let now = $state(Date.now());
  let loadingDemo = $state(false);

  const widgets = $derived(visibleWidgets(widgetState));
  const stats = $derived(daemonState.overview?.stats ?? null);
  const active = $derived(activeSessions());
  const live = $derived(active[0] ?? null);
  const pending = $derived(pendingGuards());
  const rules = $derived(daemonState.rules);
  const adapters = $derived(daemonState.adapters);
  const installed = $derived(adapters.filter((adapter) => adapter.installed));
  const demo = $derived(daemonState.health?.demoMode === true);
  const offline = $derived(daemonState.status === 'offline');
  const recent = $derived((daemonState.overview?.recentSessions ?? daemonState.sessions).slice(0, 4));
  const totalTokens = $derived(
    stats
      ? stats.inputTokens +
          stats.outputTokens +
          stats.cacheReadTokens +
          stats.cacheWriteTokens +
          stats.reasoningTokens
      : 0,
  );
  const activeRules = $derived(rules.filter((rule) => rule.enabled).length);
  const pendingCount = $derived(pending.length);

  const liveEvents = $derived(
    live
      ? daemonState.liveEvents.filter((event) => event.sessionId === live.id).slice(-3)
      : [],
  );

  const spendDays = $derived.by(() => {
    const buckets: Array<{ date: Date; value: number }> = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      buckets.push({ date, value: 0 });
    }
    for (const session of daemonState.sessions) {
      const started = Date.parse(session.startedAt);
      if (!Number.isFinite(started)) continue;
      const day = new Date(started);
      day.setHours(0, 0, 0, 0);
      const bucket = buckets.find((entry) => entry.date.getTime() === day.getTime());
      if (bucket) bucket.value += session.totals.totalCostUsd;
    }
    return buckets.map((entry) => ({
      label: new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(entry.date),
      value: entry.value,
    }));
  });
  const weekSpend = $derived(spendDays.reduce((sum, day) => sum + day.value, 0));
  const maxDaySpend = $derived(Math.max(0.01, ...spendDays.map((day) => day.value)));

  $effect(() => {
    if (active.length === 0) return;
    const timer = window.setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => window.clearInterval(timer);
  });

  function startEditing(): void {
    editing = true;
  }

  function finishEditing(): void {
    editing = false;
    endDrag();
  }

  function onTilePointerDown(event: PointerEvent): void {
    if (editing || event.pointerType !== 'touch') return;
    pressStart = { x: event.clientX, y: event.clientY };
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(startEditing, 520);
  }

  function cancelLongPress(): void {
    window.clearTimeout(longPressTimer);
  }

  function onTilePointerMove(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    if (Math.abs(event.clientX - pressStart.x) > 10 || Math.abs(event.clientY - pressStart.y) > 10) {
      cancelLongPress();
    }
  }

  function startDrag(event: PointerEvent, id: WidgetId): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragId = id;
    dragPointer = event.pointerId;
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  function onDragMove(event: PointerEvent): void {
    if (!dragId || event.pointerId !== dragPointer) return;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-widget]');
    const beforeId = target?.dataset.widget as WidgetId | undefined;
    if (beforeId && beforeId !== dragId) {
      reorderWidgetBefore(dragId, beforeId);
    }
  }

  function endDrag(): void {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    dragId = null;
    dragPointer = -1;
  }

  function hide(id: WidgetId): void {
    toggleWidgetHidden(id);
  }

  function openSession(session: Session): void {
    navigate(`/flights?session=${encodeURIComponent(session.id)}`);
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

  function statusClass(status: string): string {
    if (status === 'completed') return 'status-pill--ok';
    if (status === 'active') return 'status-pill--live';
    if (status === 'failed' || status === 'killed') return 'status-pill--danger';
    return '';
  }

  function isDemoSession(session: Session): boolean {
    return session.source === 'demo' || session.metadata?.demo === true;
  }

  async function loadDemo(): Promise<void> {
    loadingDemo = true;
    try {
      await seedDemoData();
      toast(t('home.demoLoaded'));
    } catch {
      toast(t('common.offline'));
    } finally {
      loadingDemo = false;
    }
  }

  async function retry(): Promise<void> {
    await refreshDaemon();
  }

  onDestroy(() => {
    cancelLongPress();
    endDrag();
  });
</script>

<div class="screen-head">
  <div>
    <p class="kicker">{t('home.kicker')}</p>
    <h1>{t('home.title')}</h1>
    <p class="screen-lede">{t('home.lede')}</p>
  </div>
  <div class="screen-actions">
    <span
      class="status-pill"
      class:status-pill--ok={daemonState.status === 'online'}
      class:status-pill--danger={daemonState.status === 'offline'}
    >
      <span
        class="dot"
        class:dot--ok={daemonState.status === 'online'}
        class:dot--danger={daemonState.status === 'offline'}
      ></span>
      {daemonState.status === 'online'
        ? t('common.online')
        : daemonState.status === 'connecting'
          ? t('common.connecting')
          : t('common.offline')}
    </span>
    {#if demo}
      <span class="status-pill status-pill--demo">{t('topbar.demo')}</span>
    {/if}
    <button class="btn btn--ghost" type="button" onclick={() => (editing ? finishEditing() : startEditing())}>
      <Icon name={editing ? 'check' : 'grid'} size={16} />
      {editing ? t('common.done') : t('home.customize')}
    </button>
    <button class="btn btn--primary" type="button" onclick={openQuickPrompt}>
      <Icon name="sparkles" size={16} />
      {t('home.quickPrompt')}
    </button>
  </div>
</div>

{#if offline && !stats}
  <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
    <span class="empty-state__icon"><Icon name="alert" size={24} /></span>
    <h2>{t('home.offlineTitle')}</h2>
    <p>{t('home.offlineBody')}</p>
    <div class="button-row">
      <button class="btn btn--primary" type="button" onclick={retry} disabled={daemonState.loading}>
        <Icon name="refresh" size={16} />
        {t('home.offlineAction')}
      </button>
      <button class="btn btn--ghost" type="button" onclick={openQuickPrompt}>
        <Icon name="terminal" size={16} />
        {t('home.quickPrompt')}
      </button>
    </div>
    <p class="empty-state__note">{t('home.offlineDemo')}</p>
  </section>
{:else if daemonState.loading && !stats}
  <section class="empty-state card">
    <span class="empty-state__icon"><Icon name="clock" size={22} /></span>
    <p>{t('common.loading')}</p>
  </section>
{:else}
  {#if editing}
    <div class="edit-note card">
      <span class="edit-note__icon"><Icon name="grip" size={16} /></span>
      <p>{t('home.editHint')}</p>
      <button class="text-link" type="button" onclick={resetWidgetLayout}>
        <Icon name="rotate" size={14} />
        {t('home.resetLayout')}
      </button>
    </div>
  {/if}

  <div class="bento" class:is-editing={editing} role="region" aria-label={t('home.title')}>
    {#each widgets as id (id)}
      <section
        class="tile tile--{id} card"
        class:is-editing={editing}
        class:is-dragging={dragId === id}
        role="group"
        aria-label={t(labels[id])}
        data-widget={id}
        data-glass
        data-glass-layer="card"
        data-glass-depth="2"
        onpointerdown={onTilePointerDown}
        onpointermove={onTilePointerMove}
        onpointerup={cancelLongPress}
        onpointercancel={cancelLongPress}
        oncontextmenu={(event) => {
          if (editing) event.preventDefault();
        }}
      >
        <div class="tile__head">
          <span class="tile__label">{t(labels[id])}</span>
          <div class="tile__actions">
            {#if editing}
              <button
                class="tile__action"
                type="button"
                aria-label={t('home.moveUp', { name: t(labels[id]) })}
                onclick={() => moveWidgetBy(id, -1)}
              >
                <Icon name="arrow-up" size={15} />
              </button>
              <button
                class="tile__action"
                type="button"
                aria-label={t('home.moveDown', { name: t(labels[id]) })}
                onclick={() => moveWidgetBy(id, 1)}
              >
                <Icon name="arrow-down" size={15} />
              </button>
              <button
                class="tile__action"
                type="button"
                aria-label={t('home.hide', { name: t(labels[id]) })}
                onclick={() => hide(id)}
              >
                <Icon name="eye-off" size={15} />
              </button>
            {/if}
            <button
              class="tile__drag"
              type="button"
              aria-label={t('home.drag', { name: t(labels[id]) })}
              onpointerdown={(event) => startDrag(event, id)}
            >
              <Icon name="grip" size={16} />
            </button>
          </div>
        </div>

        {#if id === 'live'}
          {#if live}
            <div class="live-grid">
              <div class="live-main">
                <span class="eyebrow">
                  <span class="dot dot--live"></span>
                  {t('common.active')} · {sessionAgent(live)}
                  {#if isDemoSession(live)}
                    <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
                  {/if}
                </span>
                <h2>{live.title}</h2>
                <p class="tile__body">
                  {live.workspacePath || t('common.local')} · {live.model || t('common.unknown')}
                </p>
                <div class="live-steps">
                  {#each liveEvents as event}
                    <div class="live-step">
                      <span class="live-step__dot is-done"></span>
                      <span>{event.type}</span>
                      <small>{timeAgo(event.at, t, now)}</small>
                    </div>
                  {:else}
                    <div class="live-step">
                      <span class="live-step__dot is-done"></span>
                      <span>{t('flights.steps', { count: live.totals.stepCount })}</span>
                      <small>{t('flights.recorded')}</small>
                    </div>
                  {/each}
                </div>
                <div class="button-row">
                  <button class="btn btn--primary" type="button" onclick={() => openSession(live)}>
                    {t('home.openFlight')}
                    <Icon name="arrow-right" size={15} />
                  </button>
                  <button class="btn btn--ghost" type="button" onclick={openQuickPrompt}>
                    {t('home.startAgent')}
                  </button>
                </div>
              </div>
              <div class="live-side">
                <div class="mini-stat"><span>{t('home.elapsed')}</span><strong>{formatElapsed(live.startedAt, now)}</strong></div>
                <div class="mini-stat"><span>{t('common.cost')}</span><strong>{formatUsd(live.totals.totalCostUsd, live.totals.unknownCostCalls, t('common.priceUnknown'))}</strong></div>
                <div class="mini-stat"><span>{t('common.tokens')}</span><strong>{formatTokens(sessionTokens(live))}</strong></div>
                <div class="mini-stat">
                  <span>{t('widgets.guards')}</span>
                  <strong class:ok={pendingCount === 0}>
                    {pendingCount > 0 ? t('home.guardWaiting') : t('home.guardArmed')}
                  </strong>
                </div>
              </div>
            </div>
          {:else}
            <div class="tile-empty">
              <span class="eyebrow"><span class="dot"></span> {t('home.liveNone')}</span>
              <p class="tile__body">{t('home.liveNoneBody')}</p>
              <div class="button-row">
                <button class="btn btn--primary" type="button" onclick={openQuickPrompt}>
                  <Icon name="sparkles" size={15} />
                  {t('home.startAgent')}
                </button>
                <button class="btn btn--ghost" type="button" onclick={openAddAgent}>
                  {t('home.addAgent')}
                </button>
              </div>
              {#if demo}
                <button class="text-link" type="button" onclick={loadDemo} disabled={loadingDemo}>
                  <Icon name="play" size={14} />
                  {t('home.loadDemo')}
                </button>
              {/if}
            </div>
          {/if}
        {:else if id === 'spend'}
          <span class="tile__value">{formatUsd(stats?.totalCostUsd ?? 0, stats?.unknownCostCalls ?? 0, t('common.priceUnknown'))}</span>
          <span class="tile__sub">
            {t('home.acrossFlights', { count: stats?.sessionCount ?? 0 })}
          </span>
          {#if (stats?.unknownCostCalls ?? 0) > 0}
            <span class="tile__note">{t('home.unpricedCalls', { count: stats?.unknownCostCalls ?? 0 })}</span>
          {/if}
        {:else if id === 'tokens'}
          <span class="tile__value">{formatTokens(totalTokens)}</span>
          <span class="tile__sub">{t('home.tokensAcross')}</span>
          <span class="tile__note">{t('home.flightsCount', { count: stats?.sessionCount ?? 0 })}</span>
        {:else if id === 'guards'}
          <span class="tile__value tile__value--status">
            <span class="dot" class:dot--ok={pendingCount === 0} class:dot--warn={pendingCount > 0}></span>
            {pendingCount > 0 ? t('home.guardWaiting') : t('home.guardArmed')}
          </span>
          <span class="tile__sub">{t('home.guardRules', { count: activeRules })}</span>
          <span class="tile__note">
            {pendingCount > 0 ? t('home.guardPending', { count: pendingCount }) : t('home.guardIdle')}
          </span>
        {:else if id === 'approvals'}
          <span class="tile__value">{pendingCount}</span>
          <span class="tile__sub">
            <span class="dot" class:dot--warn={pendingCount > 0}></span>
            {pendingCount > 0 ? t('home.guardWaiting') : t('home.approvalsNone')}
          </span>
          {#if pendingCount > 0}
            <button class="text-link" type="button" onclick={() => navigate('/inbox')}>
              {t('nav.inbox')}
              <Icon name="arrow-right" size={14} />
            </button>
          {/if}
        {:else if id === 'activity'}
          <div class="activity-head">
            <div>
              <span class="tile__value tile__value--md">{formatUsd(weekSpend)}</span>
              <span class="tile__sub">{t('home.recentSpendNote')}</span>
            </div>
          </div>
          {#if weekSpend > 0}
            <div class="spend-bars" role="img" aria-label={t('home.recentSpendNote')}>
              {#each spendDays as day}
                <span class="spend-bars__column">
                  <span
                    class="spend-bars__bar"
                    style={`height: ${Math.max(4, Math.round((day.value / maxDaySpend) * 100))}%`}
                  ></span>
                  <small>{day.label}</small>
                </span>
              {/each}
            </div>
          {:else}
            <p class="tile__note">{t('home.spendEmpty')}</p>
          {/if}
        {:else if id === 'recent'}
          {#if recent.length > 0}
            <div class="list">
              {#each recent as session (session.id)}
                <button class="list-row" type="button" onclick={() => openSession(session)}>
                  <span class="list-row__icon"><Icon name="plane" size={16} /></span>
                  <span class="list-row__text">
                    <strong>
                      {session.title}
                      {#if isDemoSession(session)}
                        <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
                      {/if}
                    </strong>
                    <small>{sessionAgent(session)} · {timeAgo(session.startedAt, t, now)}</small>
                  </span>
                  <span class="list-row__meta">
                    <span class="status-pill {statusClass(session.status)}">{t(statusKey(session.status))}</span>
                    <span class="list-row__cost">{formatUsd(session.totals.totalCostUsd, session.totals.unknownCostCalls, t('common.priceUnknown'))}</span>
                  </span>
                </button>
              {/each}
            </div>
          {:else}
            <div class="tile-empty">
              <p class="tile__body">{t('home.noRecent')}</p>
              <button class="text-link" type="button" onclick={openQuickPrompt}>
                {t('home.startAgent')}
                <Icon name="arrow-right" size={14} />
              </button>
            </div>
          {/if}
        {:else if id === 'agents'}
          {#if installed.length > 0}
            <div class="agent-list">
              {#each installed.slice(0, 3) as adapter (adapter.id)}
                <div class="agent-row">
                  <span class="agent-row__avatar">
                    {adapter.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span class="agent-row__text">
                    <strong>{adapter.name}</strong>
                    <small>
                      {t('home.agentInstalled')}
                      {#if adapter.verified} · {t('addAgent.verified')}{/if}
                    </small>
                  </span>
                  <span class="dot dot--ok"></span>
                </div>
              {/each}
            </div>
          {:else}
            <p class="tile__body">{t('onboarding.noAdapters')}</p>
          {/if}
          <button class="text-link" type="button" onclick={openAddAgent}>
            {t('home.addAgent')}
            <Icon name="arrow-right" size={14} />
          </button>
        {/if}
      </section>
    {/each}
  </div>

  {#if widgets.length === 0}
    <div class="empty-state card">
      <span class="empty-state__icon"><Icon name="grid" size={22} /></span>
      <h2>{t('home.boardEmpty')}</h2>
      <p>{t('home.boardEmptyBody')}</p>
      <button class="btn btn--primary" type="button" onclick={resetWidgetLayout}>{t('home.resetLayout')}</button>
    </div>
  {/if}

  {#if editing && widgetState.hidden.length > 0}
    <section class="hidden-tray card" aria-label={t('home.hiddenWidgets')}>
      <span class="tile__label">{t('home.hiddenWidgets')}</span>
      <div class="hidden-tray__list">
        {#each widgetState.hidden as id (id)}
          <button class="btn btn--small btn--ghost" type="button" onclick={() => toggleWidgetHidden(id)}>
            <Icon name="eye" size={15} />
            {t('home.show', { name: t(labels[id]) })}
          </button>
        {/each}
      </div>
    </section>
  {/if}

  <p class="preview-note">
    {daemonState.lastSyncedAt
      ? t('home.lastSynced', { time: timeAgo(new Date(daemonState.lastSyncedAt).toISOString(), t, now) })
      : t('home.neverSynced')}
    {#if demo} · {t('home.demoHint')}{/if}
  </p>
{/if}
