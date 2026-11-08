<script lang="ts">
  import Icon from './Icon.svelte';
  import { openQuickPrompt } from './quick-prompt.svelte';
  import { routeState } from './router.svelte';

  interface Tab {
    id: string;
    label: string;
    icon: string;
    href: string;
  }

  const tabs: Tab[] = [
    { id: 'home', label: 'Home', icon: 'home', href: '/' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', href: '/inbox' },
    { id: 'flights', label: 'Flights', icon: 'plane', href: '/flights' },
    { id: 'market', label: 'Market', icon: 'market', href: '/market' },
    { id: 'settings', label: 'Settings', icon: 'settings', href: '/settings' },
  ];
</script>

{#if routeState.path !== '/'}
  <button
    class="quick-fab"
    type="button"
    aria-label="Quick prompt"
    onclick={openQuickPrompt}
  >
    <Icon name="sparkles" size={21} />
  </button>
{/if}

<nav
  class="tabbar float"
  aria-label="Primary"
>
  {#each tabs as tab}
    <a
      class="tabbar__item"
      class:is-active={routeState.path === tab.href}
      href={tab.href}
      data-route
      aria-label={tab.label}
      aria-current={routeState.path === tab.href ? 'page' : undefined}
    >
      <Icon name={tab.icon} size={20} />
      {#if routeState.path === tab.href}
        <span>{tab.label}</span>
      {/if}
    </a>
  {/each}
</nav>
