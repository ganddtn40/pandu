<script lang="ts">
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import { routeState } from './router.svelte';
  import { toast } from './toast-store.svelte';

  interface NavItem {
    id: string;
    label: string;
    icon: string;
    href: string;
  }

  const items: NavItem[] = [
    { id: 'home', label: 'Home', icon: 'home', href: '/' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', href: '/inbox' },
    { id: 'flights', label: 'Flights', icon: 'plane', href: '/flights' },
    { id: 'market', label: 'Market', icon: 'market', href: '/market' },
    { id: 'settings', label: 'Settings', icon: 'settings', href: '/settings' },
  ];
</script>

<aside class="rail float" data-glass data-glass-layer="float" data-glass-depth="1" data-glass-clip="none">
  <a class="rail__brand" href="/" data-route aria-label="Cockpit home">
    <Logo size={30} />
  </a>

  <nav class="rail__nav" aria-label="Primary">
    {#each items as item}
      <a
        class="rail__item"
        class:is-active={routeState.path === item.href}
        href={item.href}
        data-route
        data-tooltip={item.label}
        aria-label={item.label}
        aria-current={routeState.path === item.href ? 'page' : undefined}
      >
        <Icon name={item.icon} size={21} />
      </a>
    {/each}
  </nav>

  <button
    class="rail__plus"
    type="button"
    data-tooltip="New flight"
    aria-label="New flight"
    onclick={() => toast('Start an agent to create a flight.')}
  >
    <Icon name="plus" size={20} />
  </button>
</aside>
