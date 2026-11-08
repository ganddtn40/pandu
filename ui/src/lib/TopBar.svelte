<script lang="ts">
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';
  import { openAppearance } from './design/appearance.svelte';
  import { openQuickPrompt } from './quick-prompt.svelte';
  import { toast } from './toast-store.svelte';
</script>

<header class="topbar float" data-glass data-glass-layer="float" data-glass-depth="1" data-glass-clip="none">
  <a class="brand" href="/" data-route aria-label="Cockpit home">
    <Logo size={36} />
    <span class="brand__name">Cockpit</span>
  </a>

  <button class="search" type="button" onclick={openQuickPrompt} aria-label="Open quick prompt">
    <Icon name="sparkles" size={17} />
    <span class="search__text">Ask your agent anything</span>
    <kbd>Ctrl K</kbd>
  </button>

  <span class="status-pill status-pill--live topbar__status">
    <span class="dot dot--live"></span>
    3 agents
  </span>

  <div class="topbar__actions">
    <button class="icon-button" type="button" aria-label="Appearance" onclick={openAppearance}>
      <Icon name="palette" size={19} />
    </button>
    <button
      class="icon-button"
      type="button"
      aria-label="Notifications"
      onclick={() => toast('Inbox notifications arrive in Phase 5.')}
    >
      <Icon name="bell" size={19} />
      <span class="icon-button__dot" aria-hidden="true"></span>
    </button>
    <button
      class="avatar"
      type="button"
      aria-label="Account"
      onclick={() => toast('Accounts stay local. Remote access arrives in Phase 7.')}
    >
      G
    </button>
  </div>
</header>
