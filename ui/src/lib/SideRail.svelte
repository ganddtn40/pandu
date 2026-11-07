<script lang="ts">
  import Icon from './Icon.svelte';
  import { toast } from './toast-store.svelte';

  interface NavItem {
    id: string;
    label: string;
    icon: string;
    active: boolean;
  }

  const items: NavItem[] = [
    { id: 'home', label: 'Home', icon: 'home', active: true },
    { id: 'flights', label: 'Flights', icon: 'plane', active: false },
    { id: 'approvals', label: 'Approvals', icon: 'approvals', active: false },
    { id: 'settings', label: 'Settings', icon: 'settings', active: false },
  ];

  function go(item: NavItem, event: MouseEvent): void {
    if (item.active) return;
    event.preventDefault();
    toast(`${item.label} arrives with the next screen.`);
  }
</script>

<aside class="rail glass" data-glass data-glass-depth="1" data-glass-clip="none">
  <nav class="rail__nav" aria-label="Primary">
    {#each items as item}
      <a
        class="rail__item"
        class:is-active={item.active}
        href="/"
        data-route={item.active ? '' : undefined}
        aria-label={item.label}
        aria-current={item.active ? 'page' : undefined}
        onclick={(event) => go(item, event)}
      >
        <Icon name={item.icon} size={21} />
      </a>
    {/each}
  </nav>

  <button
    class="rail__plus"
    type="button"
    aria-label="New flight"
    onclick={() => toast('Start an agent to create a flight.')}
  >
    <Icon name="plus" size={20} />
  </button>
</aside>
