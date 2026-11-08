<script lang="ts">
  import Icon from '../Icon.svelte';
  import { daemonOrigin } from '../api/client';
  import {
    daemonState,
    refreshDaemon,
    seedDemoData,
  } from '../api/daemon.svelte';
  import type { AdapterStatus } from '../api/types';
  import { openAddAgent } from '../add-agent.svelte';
  import { copyText } from '../clipboard';
  import { ACCENTS, accentFor } from '../design/accents';
  import { openAppearance } from '../design/appearance.svelte';
  import { designState, resetDesign } from '../design/design.svelte';
  import { LANGUAGES, RADII, SURFACE_STYLES, THEME_MODES } from '../design/types';
  import { formatUptime } from '../format';
  import { t } from '../i18n/i18n.svelte';
  import { navigate } from '../router.svelte';
  import { toast } from '../toast-store.svelte';

  let copiedId = $state<string | null>(null);
  let loadingDemo = $state(false);
  let checking = $state(false);

  const design = $derived(designState.value);
  const accent = $derived(accentFor(design.accent, design.theme));
  const themeLabel = $derived(THEME_MODES.find((entry) => entry.id === design.theme)?.label ?? 'Dark');
  const surfaceLabel = $derived(
    SURFACE_STYLES.find((entry) => entry.id === design.surface)?.label ?? 'Hybrid',
  );
  const radiusLabel = $derived(RADII[design.radius].label);
  const accentLabel = $derived(
    ACCENTS.find((entry) => entry.id === design.accent)?.label ?? design.accent,
  );
  const languageLabel = $derived(
    LANGUAGES.find((entry) => entry.id === design.language)?.label ?? 'English',
  );

  const health = $derived(daemonState.health);
  const online = $derived(daemonState.status === 'online');
  const demo = $derived(health?.demoMode === true);
  const installed = $derived(daemonState.adapters.filter((adapter) => adapter.installed).length);
  const settingsEntries = $derived(
    Object.entries(daemonState.settings).sort(([left], [right]) => left.localeCompare(right)),
  );

  function reset(): void {
    resetDesign();
    toast(t('settings.resetDone'));
  }

  function commandFor(adapter: AdapterStatus): string {
    return `cockpit run -- ${adapter.command}`;
  }

  async function copy(adapter: AdapterStatus): Promise<void> {
    const copied = await copyText(commandFor(adapter));
    if (!copied) {
      toast(t('common.copyFailed'));
      return;
    }
    copiedId = adapter.id;
    toast(t('settings.copyCommandDone'));
    window.setTimeout(() => {
      if (copiedId === adapter.id) copiedId = null;
    }, 1800);
  }

  async function checkNow(): Promise<void> {
    checking = true;
    try {
      await refreshDaemon();
      toast(
        daemonState.status === 'online'
          ? t('settings.reconnected')
          : t('settings.reconnectFailed'),
      );
    } finally {
      checking = false;
    }
  }

  async function loadDemo(): Promise<void> {
    loadingDemo = true;
    try {
      await seedDemoData();
      toast(t('settings.demoLoaded'));
    } catch {
      toast(t('common.offline'));
    } finally {
      loadingDemo = false;
    }
  }
</script>

<div class="screen-head">
  <div>
    <p class="kicker">{t('settings.kicker')}</p>
    <h1>{t('settings.title')}</h1>
    <p class="screen-lede">{t('settings.lede')}</p>
  </div>
  <div class="screen-actions">
    {#if demo}
      <span class="status-pill status-pill--demo">{t('topbar.demo')}</span>
    {/if}
    <button class="btn btn--primary" type="button" onclick={openAppearance}>
      <Icon name="palette" size={16} />
      {t('settings.openAppearance')}
    </button>
  </div>
</div>

<div class="settings-grid">
  <section class="settings-card settings-card--wide card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon"><Icon name="terminal" size={19} /></span>
      <div>
        <h2>{t('settings.daemon')}</h2>
        <p>{t('settings.daemonNote')}</p>
      </div>
      <span
        class="status-pill"
        class:status-pill--ok={online}
        class:status-pill--danger={!online && daemonState.status === 'offline'}
        class:status-pill--warn={daemonState.status === 'connecting'}
      >
        <span
          class="dot"
          class:dot--ok={online}
          class:dot--danger={!online && daemonState.status === 'offline'}
          class:dot--warn={daemonState.status === 'connecting'}
        ></span>
        {online
          ? t('common.online')
          : daemonState.status === 'connecting'
            ? t('common.connecting')
            : t('common.offline')}
      </span>
    </div>

    <dl class="summary-list">
      <div><dt>{t('settings.version')}</dt><dd>{health?.version ?? '—'}</dd></div>
      <div><dt>{t('settings.database')}</dt><dd>{health?.database ?? '—'}</dd></div>
      <div><dt>{t('settings.uptime')}</dt><dd>{formatUptime(health?.uptimeMs)}</dd></div>
      <div>
        <dt>{t('settings.mode')}</dt>
        <dd>{demo ? t('settings.demoOn') : t('settings.liveMode')}</dd>
      </div>
      <div>
        <dt>{t('settings.live')}</dt>
        <dd>
          <span class="dot" class:dot--ok={daemonState.liveConnected}></span>
          {daemonState.liveConnected ? t('settings.liveConnected') : t('settings.liveDisconnected')}
        </dd>
      </div>
      <div><dt>{t('settings.endpoint')}</dt><dd><code>{daemonOrigin()}</code></dd></div>
    </dl>

    <div class="settings-card__foot">
      <p class="settings-card__note">{t('settings.reconnectHint')}</p>
      <div class="button-row button-row--tight">
        <button class="btn btn--small btn--ghost" type="button" onclick={checkNow} disabled={checking}>
          <Icon name="refresh" size={15} />
          {t('settings.checkNow')}
        </button>
      </div>
    </div>
  </section>

  <section class="settings-card card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon"><Icon name="palette" size={19} /></span>
      <div>
        <h2>{t('settings.appearance')}</h2>
        <p>{t('settings.appearanceNote')}</p>
      </div>
      <button class="text-link" type="button" onclick={openAppearance}>
        {t('settings.edit')}
        <Icon name="arrow-right" size={14} />
      </button>
    </div>

    <dl class="summary-list">
      <div><dt>{t('settings.theme')}</dt><dd>{themeLabel}</dd></div>
      <div><dt>{t('settings.surface')}</dt><dd>{surfaceLabel}</dd></div>
      <div>
        <dt>{t('settings.accent')}</dt>
        <dd><span class="swatch-dot" style={`background: ${accent.base}`}></span>{accentLabel}</dd>
      </div>
      <div><dt>{t('settings.corners')}</dt><dd>{radiusLabel}</dd></div>
      <div><dt>{t('settings.language')}</dt><dd>{languageLabel}</dd></div>
    </dl>

    <div class="settings-card__foot">
      <button class="btn btn--small btn--ghost" type="button" onclick={reset}>
        <Icon name="rotate" size={15} />
        {t('settings.reset')}
      </button>
    </div>
  </section>

  <section class="settings-card card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon"><Icon name="sparkles" size={19} /></span>
      <div>
        <h2>{t('settings.adapters')}</h2>
        <p>{t('settings.adaptersNote')}</p>
      </div>
    </div>

    {#if daemonState.adapters.length === 0}
      <p class="settings-card__note">
        {online ? t('addAgent.empty') : t('addAgent.offline')}
      </p>
    {:else}
      <p class="settings-card__note">
        {t('settings.installed', { installed, total: daemonState.adapters.length })}
      </p>
      <div class="adapter-list">
        {#each daemonState.adapters as adapter (adapter.id)}
          <article class="adapter-row">
            <div class="adapter-row__main">
              <div class="adapter-row__title">
                <strong>{adapter.name}</strong>
                <span
                  class="status-pill"
                  class:status-pill--ok={adapter.installed}
                  class:status-pill--warn={!adapter.installed}
                >
                  <span class="dot" class:dot--ok={adapter.installed}></span>
                  {adapter.installed ? t('addAgent.installed') : t('addAgent.missing')}
                </span>
                {#if adapter.verified}
                  <span class="status-pill status-pill--accent">{t('addAgent.verified')}</span>
                {/if}
              </div>
              <code class="adapter-row__command">{commandFor(adapter)}</code>
            </div>
            <button class="btn btn--small btn--ghost" type="button" onclick={() => copy(adapter)}>
              <Icon name={copiedId === adapter.id ? 'check' : 'copy'} size={14} />
              {copiedId === adapter.id ? t('addAgent.copied') : t('settings.copyCommand')}
            </button>
          </article>
        {/each}
      </div>
    {/if}

    <div class="settings-card__foot">
      <button class="btn btn--small btn--ghost" type="button" onclick={openAddAgent}>
        <Icon name="plus" size={15} />
        {t('settings.addAgent')}
      </button>
    </div>
  </section>

  {#if demo}
    <section class="settings-card card" data-glass data-glass-layer="card" data-glass-depth="2">
      <div class="settings-card__head">
        <span class="settings-card__icon"><Icon name="play" size={19} /></span>
        <div>
          <h2>{t('settings.demo')}</h2>
          <p>{t('settings.demoNote')}</p>
        </div>
      </div>
      <p class="settings-card__note">{t('demo.explainer')}</p>
      <div class="settings-card__foot">
        <button class="btn btn--small btn--ghost" type="button" onclick={loadDemo} disabled={loadingDemo}>
          <Icon name="play" size={15} />
          {t('settings.loadDemo')}
        </button>
      </div>
    </section>
  {/if}

  <section class="settings-card card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon"><Icon name="lock" size={19} /></span>
      <div>
        <h2>{t('settings.data')}</h2>
        <p>{t('settings.dataNote')}</p>
      </div>
    </div>
    <ul class="check-list">
      <li><Icon name="check" size={15} /> {t('settings.privacy1')}</li>
      <li><Icon name="check" size={15} /> {t('settings.privacy2')}</li>
      <li><Icon name="check" size={15} /> {t('settings.privacy3')}</li>
    </ul>
  </section>

  <section class="settings-card card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon"><Icon name="monitor" size={19} /></span>
      <div>
        <h2>{t('settings.platforms')}</h2>
        <p>{t('settings.platformsNote')}</p>
      </div>
    </div>
    <div class="platform-groups">
      <div class="platform-group">
        <span class="platform-group__label">{t('settings.today')}</span>
        <div class="platform-chips">
          <span class="status-pill status-pill--ok"><Icon name="globe" size={13} /> Web / PWA</span>
          <span class="status-pill status-pill--ok"><Icon name="phone" size={13} /> Android</span>
          <span class="status-pill status-pill--ok"><Icon name="monitor" size={13} /> Windows</span>
        </div>
      </div>
      <div class="platform-group">
        <span class="platform-group__label">{t('settings.planned')}</span>
        <div class="platform-chips">
          <span class="status-pill">macOS</span>
          <span class="status-pill">iOS</span>
          <span class="status-pill">Linux</span>
        </div>
      </div>
    </div>
  </section>

  <section class="settings-card settings-card--wide card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon"><Icon name="info" size={19} /></span>
      <div>
        <h2>{t('settings.about')}</h2>
        <p>{t('settings.aboutNote')}</p>
      </div>
    </div>
    <div class="about-row">
      <button class="btn btn--small btn--ghost" type="button" onclick={() => navigate('/welcome')}>
        <Icon name="play" size={15} />
        {t('settings.replayTour')}
      </button>
      <div class="about-row__updates">
        <strong>{t('settings.updates')}</strong>
        <span>{t('settings.updatesNote')}</span>
      </div>
    </div>
  </section>

  {#if settingsEntries.length > 0}
    <section class="settings-card settings-card--wide card" data-glass data-glass-layer="card" data-glass-depth="2">
      <div class="settings-card__head">
        <span class="settings-card__icon"><Icon name="sliders" size={19} /></span>
        <div>
          <h2>{t('settings.settingsMap')}</h2>
          <p>{t('settings.settingsMapNote')}</p>
        </div>
      </div>
      <dl class="summary-list summary-list--tight">
        {#each settingsEntries as [key, value]}
          <div><dt><code>{key}</code></dt><dd>{value}</dd></div>
        {/each}
      </dl>
    </section>
  {/if}
</div>
