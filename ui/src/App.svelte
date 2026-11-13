<script lang="ts">
  import type { Component } from 'svelte';
  import { onMount } from 'svelte';
  import BottomTabs from './lib/BottomTabs.svelte';
  import InstallPrompt from './lib/InstallPrompt.svelte';
  import Lazy from './lib/Lazy.svelte';
  import RemoteBanner from './lib/RemoteBanner.svelte';
  import SideRail from './lib/SideRail.svelte';
  import Toast from './lib/Toast.svelte';
  import TopBar from './lib/TopBar.svelte';
  import { addAgentState } from './lib/add-agent.svelte';
  import { initDaemon } from './lib/api/daemon.svelte';
  import { startRemoteHostWatch } from './lib/api/remote-host.svelte';
  import { appearanceState } from './lib/design/appearance.svelte';
  import { openQuickPrompt, quickPromptState } from './lib/quick-prompt.svelte';
  import { t } from './lib/i18n/i18n.svelte';
  import { routeLabel } from './lib/router';
  import { initRouter, routeState } from './lib/router.svelte';
  import { initGlass, type GlassController } from './glass/engine';
  import { PRODUCT_NAME } from './lib/brand';

  type Loader = () => Promise<{ default: Component }>;

  /**
   * Every screen is a route chunk. Market, Flights (which owns the replay and
   * snapshot/diff views), Settings, Inbox, Session, and Home are fetched only
   * when their route is opened, so a deep link to one screen does not pay for
   * the others.
   */
  const routeLoaders: Record<string, Loader> = {
    '/': () => import('./lib/HomePreview.svelte'),
    '/inbox': () => import('./lib/screens/InboxScreen.svelte'),
    '/flights': () => import('./lib/screens/FlightsScreen.svelte'),
    '/market': () => import('./lib/screens/MarketScreen.svelte'),
    '/settings': () => import('./lib/screens/SettingsScreen.svelte'),
    '/session': () => import('./lib/screens/SessionScreen.svelte'),
  };

  let canvas = $state<HTMLCanvasElement | null>(null);
  let glass: GlassController | undefined;

  const isWelcome = $derived(routeState.path === '/welcome');
  const activeLoader = $derived(routeLoaders[routeState.path] ?? null);
  const dev = import.meta.env.DEV;
  const forcedFallback = new URLSearchParams(window.location.search).get('glass') === 'off';

  // Overlays are loaded on first open and then stay mounted so their close
  // transitions still run. None of them is part of the initial route chunk.
  let appearanceMounted = $state(false);
  let addAgentMounted = $state(false);
  let quickPromptMounted = $state(false);

  $effect(() => {
    if (appearanceState.open) appearanceMounted = true;
  });
  $effect(() => {
    if (addAgentState.open) addAgentMounted = true;
  });
  $effect(() => {
    if (quickPromptState.open) quickPromptMounted = true;
  });

  function onKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openQuickPrompt();
    }
  }

  onMount(() => {
    const cleanupRouter = initRouter();
    const cleanupDaemon = initDaemon();
    const stopRemoteWatch = startRemoteHostWatch();
    if (canvas) {
      glass = initGlass(canvas, forcedFallback);
    }
    // The resource benchmark reads this timestamp over the WebView2 debugging
    // protocol. It marks the first interactive frame after the shell mounts.
    let readyFrame = requestAnimationFrame(() => {
      readyFrame = requestAnimationFrame(() => {
        document.documentElement.dataset.appReadyAt = String(
          Math.round(performance.timeOrigin + performance.now()),
        );
      });
    });
    return () => {
      cancelAnimationFrame(readyFrame);
      cleanupRouter();
      cleanupDaemon();
      stopRemoteWatch();
      glass?.destroy();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
  <title>{t(routeLabel(routeState.path))} · {PRODUCT_NAME}</title>
</svelte:head>

<canvas bind:this={canvas} class="glass-canvas" aria-hidden="true"></canvas>

{#if isWelcome}
  <Lazy load={() => import('./lib/OnboardingPreview.svelte')} label="Welcome" />
{:else}
  <div class="app-shell">
    <TopBar />
    <RemoteBanner />

    <div class="workspace">
      <SideRail />
      <main class="panel" aria-label={PRODUCT_NAME}>
        {#if dev && routeState.path === '/glass-preview'}
          <Lazy load={() => import('./lib/GlassPreview.svelte')} label="Glass preview" />
        {:else if activeLoader}
          {#key routeState.path}
            <Lazy load={activeLoader} label={t(routeLabel(routeState.path))} />
          {/key}
        {:else}
          <Lazy load={() => import('./lib/HomePreview.svelte')} label="Home" />
        {/if}
      </main>
    </div>

    <BottomTabs />
  </div>
{/if}

{#if appearanceMounted}
  <Lazy load={() => import('./lib/AppearanceSheet.svelte')} label="Appearance" />
{/if}
{#if addAgentMounted}
  <Lazy load={() => import('./lib/AddAgent.svelte')} label="Add agent" />
{/if}
{#if quickPromptMounted}
  <Lazy load={() => import('./lib/QuickPrompt.svelte')} label="Quick prompt" />
{/if}
<InstallPrompt />
<Toast />
