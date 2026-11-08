<script lang="ts">
  import Icon from './Icon.svelte';
  import { openAddAgent } from './add-agent.svelte';
  import { pendingGuards } from './api/daemon.svelte';
  import { t, type MessageKey } from './i18n/i18n.svelte';
  import { routeState } from './router.svelte';

  interface NavItem {
    key: MessageKey;
    icon: string;
    href: string;
  }

  const items: NavItem[] = [
    { key: 'nav.home', icon: 'home', href: '/' },
    { key: 'nav.inbox', icon: 'inbox', href: '/inbox' },
    { key: 'nav.flights', icon: 'plane', href: '/flights' },
    { key: 'nav.market', icon: 'market', href: '/market' },
    { key: 'nav.settings', icon: 'settings', href: '/settings' },
  ];

  const pendingCount = $derived(pendingGuards().length);
</script>

<aside class="rail float" data-glass data-glass-layer="float" data-glass-depth="1" data-glass-clip="none">
  <nav class="rail__nav" aria-label="Primary">
    {#each items as item}
      <a
        class="rail__item"
        class:is-active={routeState.path === item.href}
        href={item.href}
        data-route
        data-tooltip={t(item.key)}
        aria-label={t(item.key)}
        aria-current={routeState.path === item.href ? 'page' : undefined}
      >
        <Icon name={item.icon} size={21} />
        {#if item.href === '/inbox' && pendingCount > 0}
          <span class="rail__badge" aria-hidden="true">{pendingCount > 9 ? '9+' : pendingCount}</span>
        {/if}
      </a>
    {/each}
  </nav>

  <button
    class="rail__plus"
    type="button"
    data-tooltip={t('rail.addAgent')}
    aria-label={t('rail.addAgent')}
    onclick={openAddAgent}
  >
    <Icon name="plus" size={20} />
  </button>
</aside>
