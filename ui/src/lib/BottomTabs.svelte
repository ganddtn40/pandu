<script lang="ts">
  import Icon from './Icon.svelte';
  import { pendingGuards } from './api/daemon.svelte';
  import { t, type MessageKey } from './i18n/i18n.svelte';
  import { openQuickPrompt } from './quick-prompt.svelte';
  import { routeState } from './router.svelte';

  interface Tab {
    key: MessageKey;
    icon: string;
    href: string;
  }

  const tabs: Tab[] = [
    { key: 'nav.home', icon: 'home', href: '/' },
    { key: 'nav.inbox', icon: 'inbox', href: '/inbox' },
    { key: 'nav.flights', icon: 'plane', href: '/flights' },
    { key: 'nav.market', icon: 'market', href: '/market' },
    { key: 'nav.settings', icon: 'settings', href: '/settings' },
  ];

  const pendingCount = $derived(pendingGuards().length);
</script>

{#if routeState.path !== '/'}
  <button
    class="quick-fab"
    type="button"
    aria-label={t('home.quickPrompt')}
    onclick={openQuickPrompt}
  >
    <Icon name="sparkles" size={21} />
  </button>
{/if}

<nav class="tabbar" aria-label="Primary">
  {#each tabs as tab}
    <a
      class="tabbar__item"
      class:is-active={routeState.path === tab.href}
      href={tab.href}
      data-route
      aria-label={t(tab.key)}
      aria-current={routeState.path === tab.href ? 'page' : undefined}
    >
      <span class="tabbar__icon">
        <Icon name={tab.icon} size={20} />
        {#if tab.href === '/inbox' && pendingCount > 0}
          <span class="tabbar__badge" aria-hidden="true">{pendingCount > 9 ? '9+' : pendingCount}</span>
        {/if}
      </span>
      {#if routeState.path === tab.href}
        <span>{t(tab.key)}</span>
      {/if}
    </a>
  {/each}
</nav>
