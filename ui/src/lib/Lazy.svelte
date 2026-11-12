<script lang="ts">
  import type { Component } from 'svelte';
  import { t } from './i18n/i18n.svelte';

  /**
   * Load a screen or overlay only when it is first needed. The module import
   * starts during component setup, so the caller can mount this component the
   * moment a route or overlay becomes active without an extra effect tick.
   */
  let {
    load,
    label = 'Loading',
  }: {
    load: () => Promise<{ default: Component }>;
    label?: string;
  } = $props();

  let Loaded = $state<Component | null>(null);
  let failed = $state(false);
  let started = false;

  $effect(() => {
    if (started) return;
    started = true;
    void load()
      .then((module) => {
        Loaded = module.default;
      })
      .catch(() => {
        failed = true;
      });
  });
</script>

{#if Loaded}
  <Loaded />
{:else if failed}
  <div class="lazy-state lazy-state--error" role="alert">
    {t('lazy.failed', { label })}
  </div>
{:else}
  <div class="lazy-state" role="status" aria-label={label}>
    <span class="lazy-state__dot"></span>
  </div>
{/if}

<style>
  .lazy-state {
    display: grid;
    place-items: center;
    min-height: 8rem;
    padding: 1.5rem;
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }

  .lazy-state--error {
    color: var(--danger, #ff8a8a);
  }

  .lazy-state__dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    background: var(--accent);
    animation: lazy-pulse 900ms ease-in-out infinite alternate;
  }

  @keyframes lazy-pulse {
    from {
      opacity: 0.25;
      transform: scale(0.85);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .lazy-state__dot {
      animation: none;
      opacity: 1;
    }
  }
</style>
