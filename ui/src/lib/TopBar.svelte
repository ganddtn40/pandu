<script lang="ts">
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import { activeSessions, daemonState, inboxAttentionCount } from './api/daemon.svelte';
  import { openAppearance } from './design/appearance.svelte';
  import { t } from './i18n/i18n.svelte';
  import { openQuickPrompt } from './quick-prompt.svelte';
  import { navigate } from './router.svelte';

  const activeCount = $derived(
    daemonState.overview?.stats.activeSessionCount ?? activeSessions().length,
  );
  const pendingCount = $derived(inboxAttentionCount());
  const demo = $derived(daemonState.health?.demoMode === true);
</script>

<header class="topbar float" data-glass data-glass-layer="float" data-glass-depth="1" data-glass-clip="none" data-glass-neutral>
  <a class="brand" href="/" data-route aria-label="Cockpit home">
    <Logo size={30} />
    <span class="brand__name">Cockpit</span>
  </a>

  <button class="search" type="button" onclick={openQuickPrompt} aria-label={t('topbar.search')}>
    <Icon name="sparkles" size={17} />
    <span class="search__text">{t('topbar.search')}</span>
    <kbd>Ctrl K</kbd>
  </button>

  <span
    class="status-pill topbar__status"
    class:status-pill--live={daemonState.status === 'online' && activeCount > 0}
    class:status-pill--danger={daemonState.status === 'offline'}
  >
    <span
      class="dot"
      class:dot--live={daemonState.status === 'online' && activeCount > 0}
      class:dot--danger={daemonState.status === 'offline'}
      class:dot--warn={daemonState.status === 'connecting'}
    ></span>
    {#if daemonState.status === 'offline'}
      {t('common.offline')}
    {:else if daemonState.status === 'connecting'}
      {t('common.connecting')}
    {:else if activeCount > 0}
      {t('topbar.activeFlights', { count: activeCount })}
    {:else}
      {t('topbar.idle')}
    {/if}
  </span>

  {#if demo}
    <span class="status-pill status-pill--demo">{t('topbar.demo')}</span>
  {/if}

  <div class="topbar__actions">
    <button class="icon-button" type="button" aria-label={t('topbar.appearance')} onclick={openAppearance}>
      <Icon name="palette" size={19} />
    </button>
    <button
      class="icon-button"
      type="button"
      aria-label={pendingCount > 0 ? `${t('topbar.notifications')} (${pendingCount})` : t('topbar.notifications')}
      onclick={() => navigate('/inbox')}
    >
      <Icon name="bell" size={19} />
      {#if pendingCount > 0}
        <span class="icon-button__dot" aria-hidden="true"></span>
      {/if}
    </button>
    <button
      class="avatar"
      type="button"
      aria-label={t('topbar.account')}
      onclick={() => navigate('/settings')}
    >
      <Icon name="user" size={18} />
    </button>
  </div>
</header>
