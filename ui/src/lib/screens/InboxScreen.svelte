<script lang="ts">
  import Icon from '../Icon.svelte';
  import {
    acknowledgeAgentEvent,
    agentAttentionCount,
    daemonState,
    decideGuard,
    openAgentEvents,
    pendingGuards,
    refreshDaemon,
    resolvedGuards,
    seedDemoData,
    acknowledgedAgentEvents,
  } from '../api/daemon.svelte';
  import type { AgentEvent, GuardEvent } from '../api/types';
  import { agentEventKey, agentEventNeedsYou, agentEventTone } from '../agent-events';
  import { statusKey, timeAgo } from '../format';
  import { t } from '../i18n/i18n.svelte';
  import { navigate } from '../router.svelte';
  import { toast } from '../toast-store.svelte';

  type ResolvedEntry =
    | { kind: 'guard'; at: string; guard: GuardEvent }
    | { kind: 'agent'; at: string; event: AgentEvent };

  let busy = $state<Record<string, boolean>>({});
  let ackBusy = $state<Record<string, boolean>>({});
  let loadingDemo = $state(false);
  let confirmFor = $state<string | null>(null);
  let confirmText = $state('');

  const pending = $derived(pendingGuards());
  const agentEvents = $derived(openAgentEvents());
  const attention = $derived(pending.length + agentAttentionCount());
  const demo = $derived(daemonState.health?.demoMode === true);
  const offline = $derived(daemonState.status === 'offline' && daemonState.overview === null);
  const resolvedEntries = $derived<ResolvedEntry[]>(
    [
      ...resolvedGuards().map(
        (guard): ResolvedEntry => ({
          kind: 'guard',
          at: guard.resolvedAt ?? guard.requestedAt,
          guard,
        }),
      ),
      ...acknowledgedAgentEvents().map(
        (event): ResolvedEntry => ({
          kind: 'agent',
          at: event.acknowledgedAt ?? event.createdAt,
          event,
        }),
      ),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 20),
  );

  function guardClass(event: GuardEvent): string {
    if (event.status === 'approved') return 'status-pill--ok';
    if (event.status === 'denied' || event.status === 'blocked') return 'status-pill--danger';
    if (event.status === 'warned') return 'status-pill--warn';
    if (event.status === 'redacted') return 'status-pill--accent';
    return '';
  }

  function severityClass(event: GuardEvent): string {
    if (event.severity === 'critical' || event.severity === 'high') return 'status-pill--danger';
    if (event.severity === 'medium') return 'status-pill--warn';
    return '';
  }

  function sessionTitle(event: GuardEvent): string {
    return (
      daemonState.sessions.find((session) => session.id === event.sessionId)?.title ??
      t('inbox.noSession')
    );
  }

  function agentSession(event: AgentEvent) {
    return daemonState.sessions.find((session) => session.id === event.sessionId);
  }

  function liveAgent(event: AgentEvent) {
    return daemonState.agents.find((session) => session.sessionId === event.sessionId);
  }

  function agentIsDemo(event: AgentEvent): boolean {
    return event.metadata?.demo === true || agentSession(event)?.source === 'demo';
  }

  function agentNote(event: AgentEvent): string {
    if (event.type === 'auth_required') return t('inbox.agentAuthNote');
    if (event.type === 'done') return t('inbox.agentDoneNote');
    if (event.type === 'error') return t('inbox.agentErrorNote');
    if (agentEventNeedsYou(event.type)) return t('inbox.agentAnswerNote');
    return t('inbox.agentInfoNote');
  }

  function isHighRisk(event: GuardEvent): boolean {
    return event.severity === 'high' || event.severity === 'critical';
  }

  /** The command is already shown in its own block; do not repeat it. */
  function evidenceFor(event: GuardEvent): GuardEvent['evidence'] {
    const command = event.command?.trim();
    return event.evidence.filter(
      (entry) =>
        entry.field !== 'command' &&
        !(command && entry.excerpt?.trim() === command),
    );
  }

  function focusIf(node: HTMLElement, active: boolean): void {
    if (active) queueMicrotask(() => node.focus());
  }

  function focusInput(node: HTMLElement): void {
    queueMicrotask(() => node.focus());
  }

  function startApprove(event: GuardEvent): void {
    confirmFor = event.id;
    confirmText = '';
  }

  function cancelApprove(): void {
    confirmFor = null;
    confirmText = '';
  }

  function canConfirm(): boolean {
    return confirmText.trim().toLowerCase() === 'approve';
  }

  async function decide(event: GuardEvent, decision: 'approve' | 'deny'): Promise<void> {
    if (busy[event.id]) return;
    if (decision === 'approve' && !canConfirm()) return;
    busy = { ...busy, [event.id]: true };
    try {
      await decideGuard(event.id, { decision });
      toast(decision === 'approve' ? t('inbox.approved') : t('inbox.denied'));
      if (decision === 'approve') cancelApprove();
    } catch {
      toast(t('inbox.decisionFailed'));
    } finally {
      busy = { ...busy, [event.id]: false };
    }
  }

  async function acknowledge(event: AgentEvent): Promise<void> {
    if (ackBusy[event.id]) return;
    ackBusy = { ...ackBusy, [event.id]: true };
    try {
      await acknowledgeAgentEvent(event.id);
      toast(t('inbox.acknowledged'));
    } catch {
      toast(t('inbox.ackFailed'));
    } finally {
      ackBusy = { ...ackBusy, [event.id]: false };
    }
  }

  function openAgent(event: AgentEvent): void {
    if (liveAgent(event)) {
      navigate(`/session?id=${encodeURIComponent(event.sessionId)}`);
    } else {
      navigate(`/flights?session=${encodeURIComponent(event.sessionId)}`);
    }
  }

  async function loadDemo(): Promise<void> {
    loadingDemo = true;
    try {
      await seedDemoData();
      toast(t('inbox.loadedDemo'));
    } catch {
      toast(t('common.offline'));
    } finally {
      loadingDemo = false;
    }
  }

  async function retry(): Promise<void> {
    await refreshDaemon();
  }
</script>

<div class="screen-head">
  <div>
    <p class="kicker">{t('inbox.kicker')}</p>
    <h1>{t('inbox.title')}</h1>
    <p class="screen-lede">{t('inbox.lede')}</p>
  </div>
  <div class="screen-actions">
    <span class="status-pill" class:status-pill--warn={attention > 0} class:status-pill--ok={attention === 0}>
      <span class="dot" class:dot--warn={attention > 0} class:dot--ok={attention === 0}></span>
      {attention > 0 ? t('inbox.waiting', { count: attention }) : t('inbox.allClear')}
    </span>
    {#if demo}
      <span class="status-pill status-pill--demo">{t('topbar.demo')}</span>
    {/if}
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
  {#if agentEvents.length > 0 || pending.length > 0}
    <div class="guard-list">
      {#each agentEvents as event (event.id)}
        <article class="guard-card agent-event card" data-glass data-glass-layer="card" data-glass-depth="2">
          <div class="guard-card__head">
            <div class="guard-card__title">
              <span class="status-pill {agentEventTone(event.type)}">{t(agentEventKey(event.type))}</span>
              {#if agentIsDemo(event)}
                <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
              {/if}
              <h2>{event.agentName} · {event.projectName}</h2>
            </div>
            <span class="status-pill status-pill--warn">
              <span class="dot dot--warn"></span>
              {t('common.pending')}
            </span>
          </div>

          {#if event.message}
            <p class="guard-card__description">{event.message}</p>
          {/if}

          <dl class="guard-card__meta">
            <div><dt>{t('flights.agent')}</dt><dd>{event.agentName}</dd></div>
            <div><dt>{t('flights.project')}</dt><dd>{event.projectName}</dd></div>
            <div><dt>{t('inbox.requestedAt')}</dt><dd>{timeAgo(event.createdAt, t)}</dd></div>
          </dl>

          <div class="agent-event__note" class:agent-event__note--auth={event.type === 'auth_required'}>
            <Icon name={event.type === 'auth_required' ? 'lock' : 'terminal'} size={15} />
            <span>{agentNote(event)}</span>
          </div>

          <div class="guard-card__actions">
            <button
              class="btn btn--primary"
              type="button"
              onclick={() => acknowledge(event)}
              disabled={ackBusy[event.id]}
            >
              <Icon name="check" size={16} />
              {t('inbox.acknowledge')}
            </button>
            <button class="btn btn--ghost" type="button" onclick={() => openAgent(event)}>
              <Icon name={liveAgent(event) ? 'terminal' : 'plane'} size={16} />
              {liveAgent(event) ? t('inbox.openSession') : t('inbox.openFlight')}
            </button>
          </div>
        </article>
      {/each}

      {#each pending as event (event.id)}
        <article class="guard-card card" data-glass data-glass-layer="card" data-glass-depth="2">
          <div class="guard-card__head">
            <div class="guard-card__title">
              <span class="status-pill {severityClass(event)}">{event.severity}</span>
              {#if event.metadata?.demo}
                <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
              {/if}
              <h2>{event.title}</h2>
            </div>
            <span class="status-pill status-pill--warn">
              <span class="dot dot--warn"></span>
              {t('common.pending')}
            </span>
          </div>

          <p class="guard-card__description">{event.description}</p>

          <dl class="guard-card__meta">
            <div><dt>{t('flights.agent')}</dt><dd>{sessionTitle(event)}</dd></div>
            <div><dt>{t('inbox.rule')}</dt><dd><code>{event.ruleId}</code></dd></div>
            <div><dt>{t('inbox.requestedAt')}</dt><dd>{timeAgo(event.requestedAt, t)}</dd></div>
          </dl>

          {#if event.command}
            <div class="guard-command">
              <span>{t('inbox.command')}</span>
              <pre><code>{event.command}</code></pre>
            </div>
          {/if}

          <div class="guard-evidence">
            {#if evidenceFor(event).length > 0}
              <span class="guard-evidence__label">{t('inbox.evidence')}</span>
              <ul>
                {#each evidenceFor(event) as evidence}
                  <li>
                    {#if evidence.field}<code>{evidence.field}</code>{/if}
                    {#if evidence.excerpt}<span>{evidence.excerpt}</span>{/if}
                    {#if evidence.path}<span>{evidence.path}{#if evidence.line}:{evidence.line}{/if}</span>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          {#if demo && event.metadata?.demo}
            <p class="guard-card__demo">{t('inbox.demoHint')}</p>
          {/if}

          <div class="guard-card__actions">
            {#if confirmFor === event.id}
              <div class="guard-confirm">
                <label for={`confirm-${event.id}`}>{t('inbox.confirmApprove')}</label>
                <input
                  id={`confirm-${event.id}`}
                  class="guard-confirm__input"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder={t('inbox.confirmPlaceholder')}
                  bind:value={confirmText}
                  use:focusInput
                  onkeydown={(keyEvent) => {
                    if (keyEvent.key === 'Enter' && canConfirm()) void decide(event, 'approve');
                    if (keyEvent.key === 'Escape') cancelApprove();
                  }}
                />
                <p class="guard-confirm__hint">
                  {confirmText.trim().length > 0 && !canConfirm()
                    ? t('inbox.confirmMismatch')
                    : t('inbox.confirmHint')}
                </p>
                <div class="button-row">
                  <button
                    class="btn btn--primary"
                    type="button"
                    onclick={() => decide(event, 'approve')}
                    disabled={busy[event.id] || !canConfirm()}
                  >
                    <Icon name="check" size={16} />
                    {t('inbox.confirmButton')}
                  </button>
                  <button class="btn btn--ghost" type="button" onclick={cancelApprove}>
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            {:else}
              <button
                class="btn btn--primary"
                type="button"
                onclick={() => startApprove(event)}
                disabled={busy[event.id]}
              >
                <Icon name="check" size={16} />
                {t('inbox.approve')}
              </button>
              <button
                class="btn btn--ghost"
                type="button"
                onclick={() => decide(event, 'deny')}
                disabled={busy[event.id]}
                use:focusIf={isHighRisk(event)}
              >
                <Icon name="x" size={16} />
                {t('inbox.deny')}
              </button>
            {/if}
            <button
              class="text-link"
              type="button"
              onclick={() => navigate(`/flights?session=${encodeURIComponent(event.sessionId)}`)}
            >
              {t('inbox.openFlight')}
              <Icon name="arrow-right" size={14} />
            </button>
          </div>
        </article>
      {/each}
    </div>
  {:else}
    <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
      <span class="empty-state__icon"><Icon name="inbox" size={24} /></span>
      <h2>{t('inbox.emptyTitle')}</h2>
      <p>{t('inbox.emptyBody')}</p>
      <div class="button-row">
        {#if demo}
          <button class="btn btn--primary" type="button" onclick={loadDemo} disabled={loadingDemo}>
            <Icon name="play" size={16} />
            {t('inbox.loadDemo')}
          </button>
        {/if}
        <button class="btn btn--ghost" type="button" onclick={() => navigate('/flights')}>
          <Icon name="plane" size={16} />
          {t('nav.flights')}
        </button>
      </div>
    </section>
  {/if}

  {#if resolvedEntries.length > 0}
    <section class="resolved-section">
      <h2 class="section-title">{t('inbox.resolved')}</h2>
      <div class="resolved-list">
        {#each resolvedEntries as entry (entry.kind === 'guard' ? entry.guard.id : entry.event.id)}
          {#if entry.kind === 'guard'}
            <article class="resolved-row card">
              <div class="resolved-row__main">
                <span class="status-pill {guardClass(entry.guard)}">{t(statusKey(entry.guard.status))}</span>
                <div>
                  <strong>
                    {entry.guard.title}
                    {#if entry.guard.metadata?.demo}
                      <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
                    {/if}
                  </strong>
                  <small>{sessionTitle(entry.guard)} · {timeAgo(entry.guard.resolvedAt ?? entry.guard.requestedAt, t)}</small>
                </div>
              </div>
              {#if entry.guard.resolvedBy}
                <span class="resolved-row__by">{t('inbox.resolvedBy', { name: entry.guard.resolvedBy })}</span>
              {/if}
            </article>
          {:else}
            <article class="resolved-row card">
              <div class="resolved-row__main">
                <span class="status-pill status-pill--ok">{t('common.acknowledged')}</span>
                <div>
                  <strong>
                    {t(agentEventKey(entry.event.type))} · {entry.event.agentName}
                    {#if agentIsDemo(entry.event)}
                      <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
                    {/if}
                  </strong>
                  <small>{entry.event.projectName} · {timeAgo(entry.event.acknowledgedAt ?? entry.event.createdAt, t)}</small>
                </div>
              </div>
            </article>
          {/if}
        {/each}
      </div>
    </section>
  {/if}
{/if}
