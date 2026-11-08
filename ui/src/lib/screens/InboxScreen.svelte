<script lang="ts">
  import Icon from '../Icon.svelte';
  import {
    daemonState,
    decideGuard,
    pendingGuards,
    refreshDaemon,
    resolvedGuards,
    seedDemoData,
  } from '../api/daemon.svelte';
  import type { GuardEvent } from '../api/types';
  import { statusKey, timeAgo } from '../format';
  import { t } from '../i18n/i18n.svelte';
  import { navigate } from '../router.svelte';
  import { toast } from '../toast-store.svelte';

  let busy = $state<Record<string, boolean>>({});
  let loadingDemo = $state(false);
  let confirmFor = $state<string | null>(null);
  let confirmText = $state('');

  const pending = $derived(pendingGuards());
  const resolved = $derived(resolvedGuards().slice(0, 20));
  const demo = $derived(daemonState.health?.demoMode === true);
  const offline = $derived(daemonState.status === 'offline' && daemonState.overview === null);

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
    <span class="status-pill" class:status-pill--warn={pending.length > 0} class:status-pill--ok={pending.length === 0}>
      <span class="dot" class:dot--warn={pending.length > 0} class:dot--ok={pending.length === 0}></span>
      {pending.length > 0 ? t('inbox.waiting', { count: pending.length }) : t('inbox.allClear')}
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
  {#if pending.length > 0}
    <div class="guard-list">
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

  {#if resolved.length > 0}
    <section class="resolved-section">
      <h2 class="section-title">{t('inbox.resolved')}</h2>
      <div class="resolved-list">
        {#each resolved as event (event.id)}
          <article class="resolved-row card">
            <div class="resolved-row__main">
              <span class="status-pill {guardClass(event)}">{t(statusKey(event.status))}</span>
              <div>
                <strong>
                  {event.title}
                  {#if event.metadata?.demo}
                    <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
                  {/if}
                </strong>
                <small>{sessionTitle(event)} · {timeAgo(event.resolvedAt ?? event.requestedAt, t)}</small>
              </div>
            </div>
            {#if event.resolvedBy}
              <span class="resolved-row__by">{t('inbox.resolvedBy', { name: event.resolvedBy })}</span>
            {/if}
          </article>
        {/each}
      </div>
    </section>
  {/if}
{/if}
