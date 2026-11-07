<script lang="ts">
  import { onMount } from 'svelte';
  import BottomTabs from './lib/BottomTabs.svelte';
  import GlassPreview from './lib/GlassPreview.svelte';
  import ShellPreview from './lib/ShellPreview.svelte';
  import SideRail from './lib/SideRail.svelte';
  import Toast from './lib/Toast.svelte';
  import TopBar from './lib/TopBar.svelte';
  import { readPreferences } from './lib/preferences';
  import { initRouter, routeState } from './lib/router.svelte';
  import { initGlass, type GlassController } from './glass/engine';

  let canvas = $state<HTMLCanvasElement | null>(null);
  let glass: GlassController | undefined;

  function storedPerformance(): boolean {
    try {
      return localStorage.getItem('cockpit.performance') === '1';
    } catch {
      return false;
    }
  }

  const preferences = readPreferences(window.location.search, storedPerformance());

  onMount(() => {
    const cleanupRouter = initRouter();
    if (canvas) {
      glass = initGlass(canvas, preferences.forceFallback);
    }
    return () => {
      cleanupRouter();
      glass?.destroy();
    };
  });
</script>

<svelte:head>
  <title>{routeState.path === '/glass-preview' ? 'Glass preview · Cockpit' : 'Cockpit'}</title>
</svelte:head>

<canvas bind:this={canvas} class="glass-canvas" aria-hidden="true"></canvas>

<div class="app-shell">
  <TopBar />

  <div class="workspace">
    <SideRail />
    <main class="panel glass" data-glass data-glass-depth="1" aria-label="Cockpit">
      {#if routeState.path === '/glass-preview'}
        <GlassPreview />
      {:else}
        <ShellPreview />
      {/if}
    </main>
  </div>

  <BottomTabs />
</div>

<Toast />
