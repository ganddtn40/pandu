<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { remoteDeviceApi } from './api/client';
  import {
    acceptPairingToken,
    claimPairing,
    decideRemoteGuard,
    forgetThisDevice,
    initRemoteApp,
    pollPairing,
    refreshRemote,
    remoteErrorMessage,
    remoteState,
    sendRemotePrompt,
  } from './api/remote.svelte';
  import type {
    AgentOutput,
    AgentSession,
    GuardEvent,
    RemoteClaimTicket,
    Session,
    Step,
  } from './api/types';
  import { formatDuration, timeAgo } from './format';
  import { t } from './i18n/i18n.svelte';
  import { isAuthPrompt, isHighRisk, remoteScopeKey } from './remote-format';
  import { toast } from './toast-store.svelte';

  type Tab = 'inbox' | 'flights' | 'agents';
  type PairStatus = 'idle' | 'waiting' | 'denied' | 'expired';

  let tab = $state<Tab>('inbox');
  let cleanup: (() => void) | undefined;

  // Pairing gate
  let code = $state('');
  let deviceName = $state('');
  let pin = $state('');
  let pasteToken = $state('');
  let pairBusy = $state(false);
  let pairStatus = $state<PairStatus>('idle');
  let pairError = $state<string | null>(null);
  let ticket = $state<RemoteClaimTicket | null>(null);
  let verificationCode = $state('');
  let pairedHasPin = $state(false);
  let showPairingSummary = $state(false);
  let pollTimer: number | undefined;

  // Flights
  let openSession = $state<Session | null>(null);
  let openSteps = $state<Step[]>([]);
  let stepsBusy = $state(false);

  // Agents
  let openAgentId = $state<string | null>(null);
  let openOutput = $state<AgentOutput | null>(null);
  let outputBusy = $state(false);
  let promptText = $state('');
  let promptBusy = $state(false);

  // Approvals
  let pinByEvent = $state<Record<string, string>>({});
  let deciding = $state<string | null>(null);
  let confirmForget = $state(false);

  const info = $derived(remoteState.info);
  const scopes = $derived(info?.scopes ?? []);
  const canViewContent = $derived(scopes.includes('view:content'));
  const canRespond = $derived(scopes.includes('respond'));
  const canPrompt = $derived(scopes.includes('prompt'));
  const pendingGuards = $derived(remoteState.guards.filter((event) => event.status === 'pending'));
  const selectedAgent = $derived(
    openAgentId ? (remoteState.agents.find((agent) => agent.sessionId === openAgentId) ?? null) : null,
  );
  const promptRemaining = $derived(2000 - promptText.length);

  onMount(() => {
    deviceName = guessDeviceName();
    cleanup = initRemoteApp();
    return () => {
      cleanup?.();
      stopPolling();
    };
  });

  function guessDeviceName(): string {
    if (typeof navigator === 'undefined') return 'Remote device';
    const ua = navigator.userAgent;
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android device';
    return 'Remote device';
  }

  function stopPolling(): void {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function newVerificationCode(): string {
    const values = new Uint32Array(1);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(values);
    } else {
      values[0] = Math.floor(Math.random() * 10_000);
    }
    return String(values[0] % 10_000).padStart(4, '0');
  }

  async function submitPairing(): Promise<void> {
    if (pairBusy) return;
    pairError = null;
    if (!code.trim()) {
      pairError = t('remote.pairFailed');
      return;
    }
    const trimmedPin = pin.trim();
    if (trimmedPin && !/^\d{6,12}$/.test(trimmedPin)) {
      pairError = t('remote.pairPinInvalid');
      return;
    }
    pairBusy = true;
    try {
      verificationCode = newVerificationCode();
      ticket = await claimPairing(
        code.trim(),
        deviceName.trim() || 'Remote device',
        trimmedPin || undefined,
        verificationCode,
      );
      pairStatus = 'waiting';
      stopPolling();
      pollTimer = window.setInterval(() => void pollOnce(), 1_500);
      void pollOnce();
    } catch (error) {
      pairError = remoteErrorMessage(error);
    } finally {
      pairBusy = false;
    }
  }

  async function pollOnce(): Promise<void> {
    if (!ticket) return;
    try {
      const result = await pollPairing(ticket);
      if (result.status === 'confirmed' && result.token) {
        stopPolling();
        ticket = null;
        pairStatus = 'idle';
        pairedHasPin = pin.trim().length > 0;
        showPairingSummary = true;
        toast(t('remote.pairApproved'));
        acceptPairingToken(result.token);
      } else if (result.status === 'denied') {
        stopPolling();
        ticket = null;
        pairStatus = 'denied';
        pairError = t('remote.pairDeniedError');
      } else if (result.status === 'expired') {
        stopPolling();
        ticket = null;
        pairStatus = 'expired';
        pairError = t('remote.pairExpired');
      }
    } catch (error) {
      // A dropped poll is transient; the code still expires on the host.
      pairError = remoteErrorMessage(error);
    }
  }

  function useToken(): void {
    const value = pasteToken.trim();
    if (!value) return;
    pairError = null;
    acceptPairingToken(value);
  }

  async function forget(): Promise<void> {
    await forgetThisDevice();
    confirmForget = false;
    toast(t('remote.forgotten'));
  }

  async function decide(event: GuardEvent, decision: 'approve' | 'deny'): Promise<void> {
    if (deciding) return;
    deciding = event.id;
    try {
      const needsPin = isHighRisk(event) && info?.hasPin === true;
      await decideRemoteGuard(event, decision, needsPin ? (pinByEvent[event.id] ?? '') : undefined);
      const next = { ...pinByEvent };
      delete next[event.id];
      pinByEvent = next;
      toast(t('remote.decided'));
    } catch (error) {
      toast(remoteErrorMessage(error));
    } finally {
      deciding = null;
    }
  }

  async function openFlight(session: Session): Promise<void> {
    openSession = session;
    openSteps = [];
    if (!canViewContent) return;
    stepsBusy = true;
    try {
      openSteps = (await remoteDeviceApi.steps(session.id)).steps;
    } catch (error) {
      toast(remoteErrorMessage(error));
    } finally {
      stepsBusy = false;
    }
  }

  async function loadOutput(id: string): Promise<void> {
    openAgentId = id;
    openOutput = null;
    if (!canViewContent) return;
    outputBusy = true;
    try {
      openOutput = await remoteDeviceApi.agent(id);
    } catch (error) {
      toast(remoteErrorMessage(error));
    } finally {
      outputBusy = false;
    }
  }

  async function refreshOutput(): Promise<void> {
    if (!openAgentId || outputBusy) return;
    await loadOutput(openAgentId);
  }

  async function sendPrompt(): Promise<void> {
    if (!openAgentId || promptBusy) return;
    if (promptText.trim().length === 0) return;
    if (promptText.length > 2000) {
      toast(t('remote.promptTooLong', { max: 2000 }));
      return;
    }
    promptBusy = true;
    try {
      const result = await sendRemotePrompt(openAgentId, promptText);
      promptText = '';
      toast(result.status === 'pending_host' ? t('remote.promptWaitingHost') : t('remote.promptSent'));
    } catch (error) {
      toast(remoteErrorMessage(error));
    } finally {
      promptBusy = false;
    }
  }

  function agentStatusKey(status: AgentSession['status']): 'remote.agentRunning' | 'remote.agentExited' | 'remote.agentKilled' {
    if (status === 'running') return 'remote.agentRunning';
    if (status === 'killed') return 'remote.agentKilled';
    return 'remote.agentExited';
  }

  function severityClass(event: GuardEvent): string {
    if (event.severity === 'critical') return 'status-pill status-pill--danger';
    if (event.severity === 'high') return 'status-pill status-pill--warn';
    return 'status-pill';
  }

  // The severity pill already says "high" or "critical". Only add the
  // plain-language risk chip when the danger comes from something the severity
  // does not show, such as a dangerous command at medium severity.
  function needsRiskChip(event: GuardEvent): boolean {
    return isHighRisk(event) && event.severity !== 'high' && event.severity !== 'critical';
  }
</script>

{#if remoteState.phase === 'pairing'}
  <main class="remote-app remote-app--gate">
    <div class="remote-app__brand">
      <span class="remote-app__mark"><Icon name="plane" size={22} /></span>
      <div>
        <strong>{t('remote.appTitle')}</strong>
        <span>{t('remote.appSubtitle')}</span>
      </div>
    </div>

    <section class="card remote-app__panel">
      <div class="remote-app__panel-head">
        <h1>{t('remote.pairTitle')}</h1>
        <p>{t('remote.pairBody')}</p>
      </div>

      {#if pairStatus === 'waiting'}
        <div class="remote-app__waiting" role="status">
          <span class="remote-app__pulse" aria-hidden="true"></span>
          <div>
            <strong>{t('remote.pairWaiting')}</strong>
            <span>{deviceName}</span>
          </div>
        </div>
        <div class="remote-verify" aria-live="polite">
          <span class="kicker">{t('remote.verificationCode')}</span>
          <strong class="remote-verify__code">{verificationCode}</strong>
          <p>{t('remote.verificationBody')}</p>
        </div>
        <button class="text-link" type="button" onclick={() => { stopPolling(); ticket = null; pairStatus = 'idle'; }}>
          {t('common.cancel')}
        </button>
      {:else}
        <form class="remote-app__form" onsubmit={(event) => { event.preventDefault(); void submitPairing(); }}>
          <label class="remote-app__field">
            <span>{t('remote.pairCode')}</span>
            <input
              type="text"
              bind:value={code}
              placeholder={t('remote.pairCodePlaceholder')}
              autocomplete="one-time-code"
              autocapitalize="characters"
              spellcheck="false"
            />
          </label>
          <label class="remote-app__field">
            <span>{t('remote.pairDeviceName')}</span>
            <input
              type="text"
              bind:value={deviceName}
              placeholder={t('remote.pairDeviceNamePlaceholder')}
              autocomplete="off"
              maxlength="48"
            />
          </label>
          <label class="remote-app__field">
            <span>{t('remote.pairPin')}</span>
            <input
              type="password"
              bind:value={pin}
              autocomplete="new-password"
              inputmode="numeric"
              minlength="6"
              maxlength="12"
              pattern={'\\d{6,12}'}
            />
            <small>{t('remote.pairPinNote')}</small>
          </label>
          {#if pairError}
            <p class="remote-app__error" role="alert">
              <Icon name="alert" size={15} />
              {pairError}
            </p>
          {/if}
          <button class="btn btn--primary remote-app__submit" type="submit" disabled={pairBusy}>
            <Icon name="lock" size={16} />
            {pairBusy ? t('common.loading') : t('remote.pairSubmit')}
          </button>
        </form>
      {/if}
    </section>

    <section class="remote-app__token">
      <label class="remote-app__field">
        <span>{t('remote.enterToken')}</span>
        <input
          type="password"
          bind:value={pasteToken}
          placeholder={t('remote.enterTokenPlaceholder')}
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <button class="btn btn--small btn--ghost" type="button" onclick={useToken} disabled={!pasteToken.trim()}>
        {t('remote.useToken')}
      </button>
    </section>
  </main>
{:else if showPairingSummary}
  <main class="remote-app remote-app--gate">
    <div class="remote-app__brand">
      <span class="remote-app__mark"><Icon name="check" size={22} /></span>
      <div>
        <strong>{t('remote.appTitle')}</strong>
        <span>{t('remote.appSubtitle')}</span>
      </div>
    </div>
    <section class="card remote-app__panel">
      <div class="remote-app__panel-head">
        <h1>{t('remote.pairedTitle')}</h1>
        <p>{t('remote.pairedBody')}</p>
      </div>
      <ul class="remote-app__paired-list">
        <li>{t('remote.pairedStatus')}</li>
        <li>{t('remote.pairedNoContent')}</li>
        <li>{pairedHasPin ? t('remote.pairedPin') : t('remote.pairedNoPin')}</li>
      </ul>
      <button
        class="btn btn--primary remote-app__submit"
        type="button"
        disabled={remoteState.phase !== 'ready'}
        onclick={() => (showPairingSummary = false)}
      >
        <Icon name="plane" size={16} />
        {t('remote.openDashboard')}
      </button>
    </section>
  </main>
{:else if remoteState.phase === 'loading'}
  <main class="remote-app remote-app--center">
    <span class="remote-app__spinner" aria-hidden="true"></span>
    <p>{t('common.loading')}</p>
  </main>
{:else if remoteState.phase === 'offline'}
  <main class="remote-app remote-app--center">
    <div class="remote-app__offline card">
      <span class="remote-app__mark"><Icon name="globe" size={22} /></span>
      <h1>{t('remote.offlineTitle')}</h1>
      <p>{remoteState.error ?? t('remote.offlineBody')}</p>
      <div class="button-row">
        <button class="btn btn--primary" type="button" onclick={() => { remoteState.phase = 'loading'; void refreshRemote(); }}>
          <Icon name="refresh" size={15} />
          {t('remote.retry')}
        </button>
        <button class="btn btn--ghost" type="button" onclick={() => (confirmForget = true)}>
          {t('remote.forget')}
        </button>
      </div>
      {#if confirmForget}
        <div class="remote-app__confirm">
          <p>{t('remote.forgetConfirm')}</p>
          <div class="button-row button-row--tight">
            <button class="btn btn--small btn--danger" type="button" onclick={forget}>{t('remote.forget')}</button>
            <button class="btn btn--small btn--ghost" type="button" onclick={() => (confirmForget = false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </main>
{:else}
  <main class="remote-app">
    <header class="remote-app__header">
      <div class="remote-app__brand">
        <span class="remote-app__mark"><Icon name="plane" size={20} /></span>
        <div>
          <strong>{t('remote.appTitle')}</strong>
          <span>{info ? t('remote.sessionFor', { name: info.deviceName }) : ''}</span>
        </div>
      </div>
      <div class="remote-app__meta">
        <span class="status-pill" class:status-pill--ok={remoteState.liveConnected}>
          <span class="dot" class:dot--ok={remoteState.liveConnected}></span>
          {remoteState.liveConnected ? t('remote.live') : t('remote.reconnecting')}
        </span>
        {#each scopes as scope (scope)}
          <span class="status-pill">{t(remoteScopeKey(scope))}</span>
        {/each}
        <button class="text-link" type="button" onclick={() => (confirmForget = true)}>
          {t('remote.forget')}
        </button>
      </div>
    </header>

    {#if confirmForget}
      <div class="remote-app__confirm remote-app__confirm--bar">
        <p>{t('remote.forgetConfirm')}</p>
        <div class="button-row button-row--tight">
          <button class="btn btn--small btn--danger" type="button" onclick={forget}>{t('remote.forget')}</button>
          <button class="btn btn--small btn--ghost" type="button" onclick={() => (confirmForget = false)}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    {/if}

    <nav class="remote-app__tabs" aria-label={t('remote.appTitle')}>
      <button
        class="remote-app__tab"
        class:is-active={tab === 'inbox'}
        type="button"
        aria-current={tab === 'inbox'}
        onclick={() => (tab = 'inbox')}
      >
        <Icon name="inbox" size={16} />
        {t('remote.tabInbox')}
        {#if pendingGuards.length > 0}
          <span class="remote-app__badge">{pendingGuards.length}</span>
        {/if}
      </button>
      <button
        class="remote-app__tab"
        class:is-active={tab === 'flights'}
        type="button"
        aria-current={tab === 'flights'}
        onclick={() => (tab = 'flights')}
      >
        <Icon name="plane" size={16} />
        {t('remote.tabFlights')}
      </button>
      <button
        class="remote-app__tab"
        class:is-active={tab === 'agents'}
        type="button"
        aria-current={tab === 'agents'}
        onclick={() => (tab = 'agents')}
      >
        <Icon name="terminal" size={16} />
        {t('remote.tabAgents')}
      </button>
    </nav>

    {#if tab === 'inbox'}
      <section class="remote-app__section">
        <div class="remote-app__section-head">
          <h2>{t('remote.inboxTitle')}</h2>
          {#if !canRespond}
            <span class="status-pill status-pill--warn">{t('remote.viewOnly')}</span>
          {/if}
        </div>

        {#if !canRespond}
          <p class="remote-app__note">
            <Icon name="lock" size={15} />
            {t('remote.inboxNoScope')}
          </p>
        {/if}
        {#if info?.respondLocked}
          <p class="remote-app__note remote-app__note--warn">
            <Icon name="lock" size={15} />
            {t('remote.respondLocked')}
          </p>
        {/if}

        {#if pendingGuards.length === 0}
          <p class="remote-app__empty">{t('remote.inboxEmpty')}</p>
        {:else}
          <div class="remote-app__events">
            {#each pendingGuards as event (event.id)}
              <article class="remote-app__event card">
                <div class="remote-app__event-head">
                  <span class={severityClass(event)}>{event.severity}</span>
                  {#if needsRiskChip(event)}
                    <span class="status-pill status-pill--danger">{t('remote.highRisk')}</span>
                  {/if}
                  <span class="remote-app__time">{timeAgo(event.requestedAt, t)}</span>
                </div>
                <h3>{event.title}</h3>
                <p>{event.description}</p>
                {#if event.command}
                  <pre class="remote-app__command">{event.command}</pre>
                {/if}

                {#if isAuthPrompt(event)}
                  <div class="remote-app__needs-host">
                    <Icon name="monitor" size={18} />
                    <div>
                      <strong>{t('remote.needsHost')}</strong>
                      <p>{t('remote.needsHostBody')}</p>
                    </div>
                  </div>
                {:else if canRespond && !info?.respondLocked}
                  {#if isHighRisk(event) && info?.hasPin}
                    <label class="remote-app__field remote-app__field--inline">
                      <span>{t('remote.pinRequired')}</span>
                      <input
                        type="password"
                        inputmode="numeric"
                        autocomplete="off"
                        value={pinByEvent[event.id] ?? ''}
                        oninput={(input) => {
                          pinByEvent = { ...pinByEvent, [event.id]: input.currentTarget.value };
                        }}
                      />
                    </label>
                  {/if}
                  {#if isHighRisk(event) && !info?.hasPin}
                    <p class="remote-app__note remote-app__note--warn">
                      <Icon name="alert" size={15} />
                      {t('remote.pinMissing')}
                    </p>
                  {:else}
                    <div class="button-row">
                      <button
                        class="btn btn--primary"
                        type="button"
                        onclick={() => decide(event, 'approve')}
                        disabled={deciding !== null}
                      >
                        <Icon name="check" size={15} />
                        {t('remote.approve')}
                      </button>
                      <button
                        class="btn btn--ghost"
                        type="button"
                        onclick={() => decide(event, 'deny')}
                        disabled={deciding !== null}
                      >
                        <Icon name="close" size={15} />
                        {t('remote.deny')}
                      </button>
                    </div>
                  {/if}
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {:else if tab === 'flights'}
      <section class="remote-app__section">
        {#if openSession}
          <div class="remote-app__section-head">
            <button class="text-link" type="button" onclick={() => (openSession = null)}>
              <Icon name="arrow-left" size={15} />
              {t('remote.back')}
            </button>
            <span class="status-pill">{openSession.status}</span>
          </div>
          <h2>{openSession.title}</h2>
          <p class="remote-app__note">
            {openSession.agent?.name ?? openSession.source}
            {#if openSession.startedAt}· {timeAgo(openSession.startedAt, t)}{/if}
            {#if openSession.durationMs !== undefined}· {formatDuration(openSession.durationMs)}{/if}
            {#if openSession.contextPercent !== undefined}
              · {t('remote.contextValue', { percent: openSession.contextPercent.toFixed(1) })}
            {/if}
          </p>
          <h3>{t('remote.flightSteps')}</h3>
          {#if !canViewContent}
            <p class="remote-app__note">
              <Icon name="lock" size={15} />
              {t('remote.contentNoScope')}
            </p>
          {:else if stepsBusy}
            <p class="remote-app__empty">{t('common.loading')}</p>
          {:else if openSteps.length === 0}
            <p class="remote-app__empty">{t('remote.flightsEmpty')}</p>
          {:else}
            <ol class="remote-app__steps">
              {#each openSteps as step (step.id)}
                <li class="remote-app__step">
                  <span class="status-pill">{step.kind}</span>
                  <strong>{step.model ?? step.provider ?? step.kind}</strong>
                  <span class="remote-app__time">
                    {step.status}
                    {#if step.durationMs !== undefined}· {formatDuration(step.durationMs)}{/if}
                  </span>
                </li>
              {/each}
            </ol>
          {/if}
        {:else}
          <div class="remote-app__section-head">
            <h2>{t('remote.flightsTitle')}</h2>
            <button class="text-link" type="button" onclick={() => void refreshRemote()}>
              <Icon name="refresh" size={14} />
              {t('common.refresh')}
            </button>
          </div>
          {#if remoteState.sessions.length === 0}
            <p class="remote-app__empty">{t('remote.flightsEmpty')}</p>
          {:else}
            <div class="remote-app__list">
              {#each remoteState.sessions as session (session.id)}
                <button class="remote-app__row" type="button" onclick={() => void openFlight(session)}>
                  <span class="remote-app__row-main">
                    <strong>{session.title}</strong>
                    <span>
                      {session.agent?.name ?? session.source} · {timeAgo(session.startedAt, t)}
                      {#if session.contextPercent !== undefined}
                        · {t('remote.contextValue', {
                          percent: session.contextPercent.toFixed(1),
                        })}
                      {/if}
                    </span>
                  </span>
                  <span class="status-pill">{session.status}</span>
                  <Icon name="chevron-right" size={16} />
                </button>
              {/each}
            </div>
          {/if}
        {/if}
      </section>
    {:else}
      <section class="remote-app__section">
        {#if selectedAgent}
          <div class="remote-app__section-head">
            <button class="text-link" type="button" onclick={() => { openAgentId = null; openOutput = null; }}>
              <Icon name="arrow-left" size={15} />
              {t('remote.back')}
            </button>
            <span class="status-pill">{t(agentStatusKey(selectedAgent.status))}</span>
          </div>
          <h2>{selectedAgent.agentName}</h2>
          <p class="remote-app__note">
            {selectedAgent.projectName} · {selectedAgent.workingDir}
          </p>

          {#if selectedAgent.autoApprove}
            <div class="remote-app__banner" role="alert">
              <Icon name="alert" size={18} />
              <div>
                <strong>{t('remote.autoApproveSession')}</strong>
                <p>{t('remote.autoApproveSessionBody')}</p>
              </div>
            </div>
          {/if}

          <div class="remote-app__section-head">
            <h3>{t('remote.agentOutput')}</h3>
            <button
              class="text-link"
              type="button"
              onclick={refreshOutput}
              disabled={outputBusy || !canViewContent}
            >
              <Icon name="refresh" size={14} />
              {t('common.refresh')}
            </button>
          </div>
          {#if !canViewContent}
            <p class="remote-app__note">
              <Icon name="lock" size={15} />
              {t('remote.contentNoScope')}
            </p>
          {:else if outputBusy}
            <p class="remote-app__empty">{t('common.loading')}</p>
          {:else}
            <pre class="remote-app__output">{openOutput?.output ?? t('remote.agentsEmpty')}</pre>
          {/if}

          {#if canPrompt && selectedAgent.status === 'running' && selectedAgent.promptState === 'awaiting_prompt'}
            <form
              class="remote-app__prompt"
              onsubmit={(event) => {
                event.preventDefault();
                void sendPrompt();
              }}
            >
              <label class="remote-app__field">
                <span>{t('remote.promptTitle')}</span>
                <textarea
                  bind:value={promptText}
                  placeholder={t('remote.promptPlaceholder')}
                  rows="3"
                  maxlength="2000"
                ></textarea>
                <small class:is-over={promptRemaining < 0}>{promptRemaining}</small>
              </label>
              <button class="btn btn--primary" type="submit" disabled={promptBusy || promptText.trim().length === 0}>
                <Icon name="send" size={15} />
                {t('remote.promptSend')}
              </button>
            </form>
          {:else if canPrompt && selectedAgent.status === 'running'}
            <p class="remote-app__note remote-app__note--warn">
              <Icon name="alert" size={15} />
              {t('remote.promptAwaitingOnly')}
            </p>
          {:else if !canPrompt}
            <p class="remote-app__note">
              <Icon name="lock" size={15} />
              {t('remote.promptNoScope')}
            </p>
          {/if}

          {#if selectedAgent.needsYou}
            <p class="remote-app__note remote-app__note--warn">
              <Icon name="alert" size={15} />
              {t('remote.needsHost')}
            </p>
          {/if}
        {:else}
          <div class="remote-app__section-head">
            <h2>{t('remote.agentsTitle')}</h2>
            <button class="text-link" type="button" onclick={() => void refreshRemote()}>
              <Icon name="refresh" size={14} />
              {t('common.refresh')}
            </button>
          </div>
          {#if remoteState.agents.length === 0}
            <p class="remote-app__empty">{t('remote.agentsEmpty')}</p>
          {:else}
            <div class="remote-app__list">
              {#each remoteState.agents as agent (agent.sessionId)}
                <button class="remote-app__row" type="button" onclick={() => void loadOutput(agent.sessionId)}>
                  <span class="remote-app__row-main">
                    <strong>{agent.agentName}</strong>
                    <span>{agent.projectName} · {timeAgo(agent.updatedAt, t)}</span>
                  </span>
                  {#if agent.needsYou}
                    <span class="status-pill status-pill--warn">{t('remote.agentNeedsYou')}</span>
                  {/if}
                  {#if agent.autoApprove}
                    <span class="status-pill status-pill--danger">{t('remote.autoApproveSession')}</span>
                  {/if}
                  <span class="status-pill">{t(agentStatusKey(agent.status))}</span>
                  <Icon name="chevron-right" size={16} />
                </button>
              {/each}
            </div>
          {/if}

          <div class="remote-app__section-head remote-app__section-head--spaced">
            <div>
              <h3>{t('remote.eventsTitle')}</h3>
              <p class="remote-app__note">{t('remote.eventsNote')}</p>
            </div>
          </div>
          {#if remoteState.agentEvents.length === 0}
            <p class="remote-app__empty">{t('remote.eventsEmpty')}</p>
          {:else}
            <ul class="remote-app__events-list">
              {#each remoteState.agentEvents.slice(0, 20) as event (event.id)}
                <li>
                  <span class="status-pill">{event.type}</span>
                  <strong>{event.agentName}</strong>
                  <span>{event.message}</span>
                  <span class="remote-app__time">{timeAgo(event.createdAt, t)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </section>
    {/if}
  </main>
{/if}
