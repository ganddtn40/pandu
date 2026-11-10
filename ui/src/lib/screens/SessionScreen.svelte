<script lang="ts">
  import Icon from '../Icon.svelte';
  import { daemonApi } from '../api/client';
  import {
    acknowledgeAgentEvent,
    agentById,
    daemonErrorMessage,
    daemonState,
    openAgentEventsFor,
  } from '../api/daemon.svelte';
  import type { AgentSession, ModelPricingRow } from '../api/types';
  import { t } from '../i18n/i18n.svelte';
  import { navigate, routeParam } from '../router.svelte';
  import { toast } from '../toast-store.svelte';

  const id = $derived(routeParam('id') ?? '');
  let agent = $state<AgentSession | null>(null);
  let output = $state('');
  let loadError = $state('');
  let input = $state('');
  let sending = $state(false);
  let ackBusy = $state(false);
  let outputNode = $state<HTMLPreElement | null>(null);
  let pollTimer: number | undefined;
  let loadToken = 0;
  let lastSequence = -1;
  let models = $state<ModelPricingRow[]>([]);
  let switchModel = $state('');
  let switching = $state(false);
  let switchNote = $state('');

  const ADAPTER_PROVIDERS: Record<string, string> = {
    'claude-code': 'anthropic',
    codex: 'openai',
    'gemini-cli': 'google',
  };

  const adapterProvider = $derived(
    agent ? (ADAPTER_PROVIDERS[agent.adapter] ?? null) : null,
  );
  const switchModels = $derived(
    models.filter(
      (row) => !adapterProvider || row.provider === adapterProvider,
    ),
  );
  const selectedSwitchModel = $derived(
    switchModel || switchModels.find((row) => !row.deprecated)?.model || switchModels[0]?.model || '',
  );

  const authPrompt = $derived(
    id ? openAgentEventsFor(id).find((event) => event.type === 'auth_required') ?? null : null,
  );
  const demo = $derived(
    daemonState.sessions.find((session) => session.id === id)?.source === 'demo',
  );
  const running = $derived(agent?.status === 'running');

  async function load(): Promise<void> {
    if (!id) return;
    const token = ++loadToken;
    try {
      const data = await daemonApi.agent(id);
      if (token !== loadToken) return;
      agent = data.session;
      output = data.output;
      loadError = '';
      if (data.session.outputSequence !== lastSequence) {
        lastSequence = data.session.outputSequence;
        queueMicrotask(() => {
          if (outputNode) outputNode.scrollTop = outputNode.scrollHeight;
        });
      }
    } catch (error) {
      if (token !== loadToken) return;
      // A transient read failure keeps the last terminal frame. A session the
      // daemon no longer holds gets the honest "unavailable" state instead.
      if (!agent) {
        agent = agentById(id) ?? null;
        loadError = daemonErrorMessage(error);
      }
    }
  }

  async function loadModels(): Promise<void> {
    try {
      const data = await daemonApi.models();
      models = data.models;
    } catch {
      models = [];
    }
  }

  async function switchAgentModel(): Promise<void> {
    if (!id || switching || !selectedSwitchModel) return;
    switching = true;
    switchNote = '';
    try {
      const result = await daemonApi.switchSessionModel(id, selectedSwitchModel);
      switchNote = result.instructions;
      toast(result.mode === 'pty' ? t('model.switchSent') : t('model.switchManualToast'));
      await load();
    } catch (error) {
      toast(daemonErrorMessage(error));
    } finally {
      switching = false;
    }
  }

  $effect(() => {
    if (!id) return;
    void loadModels();
  });

  $effect(() => {
    if (!id) return;
    void load();
    pollTimer = window.setInterval(() => {
      if (!document.hidden && agent?.status === 'running') void load();
    }, 1_500);
    return () => {
      if (pollTimer) window.clearInterval(pollTimer);
      pollTimer = undefined;
    };
  });

  async function send(data: string): Promise<void> {
    if (!id || sending || !running) return;
    sending = true;
    try {
      await daemonApi.agentInput(id, data);
      toast(t('session.sent'));
      await load();
    } catch {
      toast(t('session.sendFailed'));
    } finally {
      sending = false;
    }
  }

  function submitAnswer(): void {
    const text = input;
    if (!text.trim()) {
      void send('\r');
      return;
    }
    input = '';
    void send(`${text}\r`);
  }

  async function acknowledgeAuth(): Promise<void> {
    if (!authPrompt || ackBusy) return;
    ackBusy = true;
    try {
      await acknowledgeAgentEvent(authPrompt.id);
      toast(t('inbox.acknowledged'));
    } catch {
      toast(t('inbox.ackFailed'));
    } finally {
      ackBusy = false;
    }
  }

  function openFlight(): void {
    if (id) navigate(`/flights?session=${encodeURIComponent(id)}`);
  }
</script>

<div class="screen-head">
  <div>
    <p class="kicker">{t('session.kicker')}</p>
    <h1>{agent?.projectName ?? t('session.title')}</h1>
    <p class="screen-lede">
      {agent ? `${agent.agentName} · ${agent.workingDir}` : t('session.noSessionId')}
    </p>
  </div>
  <div class="screen-actions">
    {#if demo}
      <span class="status-pill status-pill--demo">{t('demo.badge')}</span>
    {/if}
    {#if agent}
      <span
        class="status-pill"
        class:status-pill--live={running}
        class:status-pill--danger={agent.status !== 'running'}
      >
        <span class="dot" class:dot--live={running} class:dot--danger={agent.status !== 'running'}></span>
        {agent.status === 'running'
          ? t('session.running')
          : agent.status === 'killed'
            ? t('session.killed')
            : t('session.exited')}
      </span>
      {#if agent.needsYou}
        <span class="status-pill status-pill--warn">{t('session.needsYou')}</span>
      {/if}
    {/if}
    <button class="btn btn--ghost" type="button" onclick={() => load()}>
      <Icon name="refresh" size={16} />
      {t('session.refresh')}
    </button>
  </div>
</div>

{#if !id}
  <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
    <span class="empty-state__icon"><Icon name="terminal" size={24} /></span>
    <h2>{t('session.notFoundTitle')}</h2>
    <p>{t('session.noSessionId')}</p>
    <button class="btn btn--primary" type="button" onclick={() => navigate('/flights')}>
      <Icon name="arrow-left" size={16} />
      {t('session.back')}
    </button>
  </section>
{:else if !agent}
  <section class="empty-state card" data-glass data-glass-layer="card" data-glass-depth="2">
    <span class="empty-state__icon"><Icon name="alert" size={24} /></span>
    <h2>{t('session.notFoundTitle')}</h2>
    <p>{loadError ? t('session.notFoundBody') : t('session.waiting')}</p>
    <div class="button-row">
      <button class="btn btn--primary" type="button" onclick={openFlight}>
        <Icon name="plane" size={16} />
        {t('session.openFlight')}
      </button>
      <button class="btn btn--ghost" type="button" onclick={() => navigate('/flights')}>
        <Icon name="arrow-left" size={16} />
        {t('session.back')}
      </button>
    </div>
  </section>
{:else}
  <div class="session-layout">
    <section class="session-terminal card" data-glass data-glass-layer="card" data-glass-depth="2">
      <div class="session-terminal__head">
        <span class="settings-card__icon"><Icon name="terminal" size={19} /></span>
        <div>
          <h2>{t('session.output')}</h2>
          <p>{t('session.outputNote')}</p>
        </div>
        <span class="status-pill">{agent.adapter}</span>
      </div>

      <!-- The terminal is a scrollable log; keyboard users need to focus it to scroll. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre
        class="pty-output"
        bind:this={outputNode}
        role="region"
        tabindex="0"
        aria-label={t('session.output')}
      >{output || t('session.waiting')}</pre>

      <div class="session-terminal__foot">
        <span
          class="status-pill"
          class:status-pill--accent={agent.verified}
          class:status-pill--warn={!agent.verified}
        >
          <Icon name={agent.verified ? 'check' : 'alert'} size={13} />
          {agent.verified ? t('session.verified') : t('session.unverified')}
        </span>
        {#if !agent.verified}
          <p>{t('session.unverifiedNote')}</p>
        {/if}
        {#if demo}
          <p>{t('session.demoHint')}</p>
        {/if}
      </div>
    </section>

    <aside class="session-side">
      {#if authPrompt}
        <section class="session-auth card" data-glass data-glass-layer="card" data-glass-depth="2">
          <span class="settings-card__icon"><Icon name="lock" size={19} /></span>
          <h2>{t('session.authTitle')}</h2>
          <p>{t('session.authBody')}</p>
          <button
            class="btn btn--primary"
            type="button"
            onclick={acknowledgeAuth}
            disabled={ackBusy}
          >
            <Icon name="check" size={16} />
            {t('session.authAcknowledged')}
          </button>
        </section>
      {:else if running}
        <section class="session-answer card" data-glass data-glass-layer="card" data-glass-depth="2">
          <h2>{t('session.answer')}</h2>
          <form
            class="session-answer__form"
            onsubmit={(event) => {
              event.preventDefault();
              submitAnswer();
            }}
          >
            <input
              type="text"
              autocomplete="off"
              spellcheck="false"
              bind:value={input}
              placeholder={t('session.answerPlaceholder')}
              aria-label={t('session.answer')}
            />
            <button class="btn btn--primary" type="submit" disabled={sending}>
              <Icon name="arrow-right" size={16} />
              {t('session.send')}
            </button>
          </form>
          <button
            class="btn btn--small btn--ghost"
            type="button"
            onclick={() => send('\r')}
            disabled={sending}
          >
            {t('session.sendEnter')}
          </button>
          <p class="settings-card__note">{t('session.keystrokesOnly')}</p>
        </section>
      {:else}
        <section class="session-answer card" data-glass data-glass-layer="card" data-glass-depth="2">
          <h2>{t('session.exited')}</h2>
          {#if agent.exitCode !== undefined && agent.exitCode !== null}
            <p class="settings-card__note">{t('session.exitCode', { code: agent.exitCode })}</p>
          {/if}
          <button class="btn btn--primary" type="button" onclick={openFlight}>
            <Icon name="plane" size={16} />
            {t('session.openFlight')}
          </button>
        </section>
      {/if}

      <section class="session-model card" data-glass data-glass-layer="card" data-glass-depth="2" data-session-model>
        <div class="session-model__head">
          <span class="settings-card__icon"><Icon name="sliders" size={19} /></span>
          <div>
            <h2>{t('model.switchTitle')}</h2>
            <p>{agent.modelSwitch.available ? t('model.switchBody') : t('model.manualTitle')}</p>
          </div>
        </div>

        {#if agent.modelSwitch.available && running && switchModels.length > 0}
          <div class="session-model__form">
            <label class="model-field">
              <span>{t('model.chooseModel')}</span>
              <select
                value={selectedSwitchModel}
                onchange={(event) => (switchModel = event.currentTarget.value)}
              >
                {#each switchModels as row (row.model)}
                  <option value={row.model}>
                    {row.displayName}{row.deprecated ? ` · ${t('model.deprecated')}` : ''}
                  </option>
                {/each}
              </select>
            </label>
            <button
              class="btn btn--primary"
              type="button"
              onclick={switchAgentModel}
              disabled={switching}
              data-model-switch
            >
              <Icon name="arrow-right" size={16} />
              {switching ? t('model.confirming') : t('model.switch')}
            </button>
          </div>
          {#if agent.modelSwitch.command}
            <p class="settings-card__note"><code>{agent.modelSwitch.command}</code></p>
          {/if}
        {:else}
          <p class="session-model__manual" data-model-switch-manual>
            {agent.modelSwitch.instructions}
          </p>
        {/if}

        {#if switchNote}
          <p class="settings-card__note" data-model-switch-note>{switchNote}</p>
        {/if}
      </section>

      <button class="text-link" type="button" onclick={openFlight}>
        <Icon name="arrow-left" size={14} />
        {t('session.back')}
      </button>
    </aside>
  </div>
{/if}
