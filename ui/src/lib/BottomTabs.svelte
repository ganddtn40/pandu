<script lang="ts">
  import Icon from './Icon.svelte';
  import { toast } from './toast-store.svelte';

  interface Tab {
    id: string;
    label: string;
    icon: string;
    active: boolean;
  }

  const tabs: Tab[] = [
    { id: 'home', label: 'Home', icon: 'home', active: true },
    { id: 'flights', label: 'Flights', icon: 'plane', active: false },
    { id: 'approvals', label: 'Approvals', icon: 'approvals', active: false },
    { id: 'settings', label: 'Settings', icon: 'settings', active: false },
  ];

  function go(tab: Tab, event: MouseEvent): void {
    if (tab.active) return;
    event.preventDefault();
    toast(`${tab.label} arrives with the next screen.`);
  }
</script>

<nav class="tabbar glass" data-glass data-glass-depth="1" data-glass-clip="none" aria-label="Primary">
  {#each tabs as tab}
    <a
      class="tabbar__item"
      class:is-active={tab.active}
      href="/"
      data-route={tab.active ? '' : undefined}
      aria-label={tab.label}
      aria-current={tab.active ? 'page' : undefined}
      onclick={(event) => go(tab, event)}
    >
      <Icon name={tab.icon} size={20} />
      {#if tab.active}
        <span>{tab.label}</span>
      {/if}
    </a>
  {/each}

  <button
    class="tabbar__plus"
    type="button"
    aria-label="New flight"
    onclick={() => toast('Start an agent to create a flight.')}
  >
    <Icon name="plus" size={20} />
  </button>
</nav>
