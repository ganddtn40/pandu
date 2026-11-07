<script lang="ts">
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import { themeState, setTheme } from './theme.svelte';
  import { toast } from './toast-store.svelte';

  let searchInput = $state<HTMLInputElement | null>(null);

  function onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchInput?.focus();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<header class="topbar glass" data-glass data-glass-depth="1" data-glass-clip="none">
  <a class="brand" href="/" data-route aria-label="Cockpit home">
    <Logo />
    <span class="brand__name">Cockpit</span>
  </a>

  <label class="search">
    <Icon name="search" size={18} />
    <input
      bind:this={searchInput}
      type="search"
      placeholder="Search flights"
      aria-label="Search flights"
      autocomplete="off"
      spellcheck="false"
    />
    <kbd>Ctrl K</kbd>
  </label>

  <div class="segmented" role="group" aria-label="Appearance">
    <button
      type="button"
      aria-pressed={themeState.value === 'light'}
      onclick={() => setTheme('light')}
    >
      <Icon name="sun" size={16} />
      <span>Light</span>
    </button>
    <button
      type="button"
      aria-pressed={themeState.value === 'dark'}
      onclick={() => setTheme('dark')}
    >
      <Icon name="moon" size={16} />
      <span>Dark</span>
    </button>
  </div>

  <button
    class="icon-button"
    type="button"
    aria-label="Approvals"
    onclick={() => toast('Approvals arrive with the next screen.')}
  >
    <Icon name="bell" size={19} />
    <span class="icon-button__dot" aria-hidden="true"></span>
  </button>
</header>
