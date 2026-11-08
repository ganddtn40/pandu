<script lang="ts">
  import { onMount } from 'svelte';
  import AddAgent from './lib/AddAgent.svelte';
  import AppearanceSheet from './lib/AppearanceSheet.svelte';
  import BottomTabs from './lib/BottomTabs.svelte';
  import GlassPreview from './lib/GlassPreview.svelte';
  import HomePreview from './lib/HomePreview.svelte';
  import OnboardingPreview from './lib/OnboardingPreview.svelte';
  import QuickPrompt from './lib/QuickPrompt.svelte';
  import SideRail from './lib/SideRail.svelte';
  import Toast from './lib/Toast.svelte';
  import TopBar from './lib/TopBar.svelte';
  import { initDaemon } from './lib/api/daemon.svelte';
  import FlightsScreen from './lib/screens/FlightsScreen.svelte';
  import InboxScreen from './lib/screens/InboxScreen.svelte';
  import MarketScreen from './lib/screens/MarketScreen.svelte';
  import SessionScreen from './lib/screens/SessionScreen.svelte';
  import SettingsScreen from './lib/screens/SettingsScreen.svelte';
  import { openQuickPrompt } from './lib/quick-prompt.svelte';
  import { routeLabel } from './lib/router';
  import { initRouter, routeState } from './lib/router.svelte';
  import { initGlass, type GlassController } from './glass/engine';

  let canvas = $state<HTMLCanvasElement | null>(null);
  let glass: GlassController | undefined;

  const isWelcome = $derived(routeState.path === '/welcome');
  const dev = import.meta.env.DEV;
  const forcedFallback = new URLSearchParams(window.location.search).get('glass') === 'off';

  function onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openQuickPrompt();
    }
  }

  onMount(() => {
    const cleanupRouter = initRouter();
    const cleanupDaemon = initDaemon();
    if (canvas) {
      glass = initGlass(canvas, forcedFallback);
    }
    return () => {
      cleanupRouter();
      cleanupDaemon();
      glass?.destroy();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
  <title>{routeLabel(routeState.path)} · Cockpit</title>
</svelte:head>

<canvas bind:this={canvas} class="glass-canvas" aria-hidden="true"></canvas>

{#if isWelcome}
  <OnboardingPreview />
{:else}
  <div class="app-shell">
    <TopBar />

    <div class="workspace">
      <SideRail />
      <main class="panel" aria-label="Cockpit">
        {#if dev && routeState.path === '/glass-preview'}
          <GlassPreview />
        {:else if routeState.path === '/inbox'}
          <InboxScreen />
        {:else if routeState.path === '/flights'}
          <FlightsScreen />
        {:else if routeState.path === '/market'}
          <MarketScreen />
        {:else if routeState.path === '/settings'}
          <SettingsScreen />
        {:else if routeState.path === '/session'}
          <SessionScreen />
        {:else}
          <HomePreview />
        {/if}
      </main>
    </div>

    <BottomTabs />
  </div>
{/if}

<AppearanceSheet />
<AddAgent />
<QuickPrompt />
<Toast />
