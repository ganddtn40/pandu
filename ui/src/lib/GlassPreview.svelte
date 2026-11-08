<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { toast } from './toast-store.svelte';
  import { applyGlassPattern, readGlassPattern, type GlassPattern } from './glass-pattern';

  function storedPerformance(): boolean {
    try {
      return localStorage.getItem('cockpit.performance') === '1';
    } catch {
      return false;
    }
  }

  const forcedFallback =
    new URLSearchParams(window.location.search).get('glass') === 'off' || storedPerformance();

  let guardOn = $state(true);
  let pattern = $state<GlassPattern>(readGlassPattern(window.location.search));
  let stats = $state({
    mode: forcedFallback ? ('fallback' as const) : ('webgl' as const),
    shapes: 0,
    fps: 0,
    redrawsPerSecond: 0,
    redrawsTotal: 0,
  });

  const shaderLabel = $derived(stats.mode === 'webgl' ? 'On · WebGL2' : 'Off · CSS');
  const fpsLabel = $derived(stats.fps === 0 ? '0 · idle' : String(stats.fps));

  onMount(() => {
    applyGlassPattern(pattern, false);
    const timer = window.setInterval(() => {
      const next = window.__cockpitGlassStats;
      if (next) stats = { ...next };
    }, 500);
    return () => window.clearInterval(timer);
  });

  function reload(params: { glass?: string | null; perf?: string | null }): void {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    url.searchParams.set('pattern', pattern);
    window.location.assign(url.toString());
  }

  function useFallback(): void {
    reload({ glass: 'off', perf: null });
  }

  function useWebgl(): void {
    try {
      localStorage.removeItem('cockpit.performance');
    } catch {
      // Storage is optional.
    }
    reload({ glass: null, perf: null });
  }

  function togglePerformance(): void {
    try {
      localStorage.setItem('cockpit.performance', storedPerformance() ? '0' : '1');
    } catch {
      // Storage is optional.
    }
    reload({ perf: storedPerformance() ? '1' : null, glass: null });
  }

  function togglePattern(): void {
    pattern = pattern === 'checker' ? 'smoky' : 'checker';
    applyGlassPattern(pattern);
  }
</script>

<div class="preview-head">
  <p class="kicker">Glass preview</p>
  <h1>Surfaces, controls, and type.</h1>
  <p class="preview-lede">
    A visual test page for the shell. Switch the appearance in the top bar, or compare the
    WebGL2 renderer with the CSS fallback below.
  </p>
</div>

<div class="preview-grid">
  <section class="preview-card glass" data-glass data-glass-depth="2">
    <h3>Surfaces</h3>
    <div class="swatch-row">
      <div class="swatch swatch--1"><span>Panel</span><span>radius 38</span></div>
      <div class="swatch swatch--2"><span>Tile</span><span>radius 26</span></div>
      <div class="swatch swatch--3"><span>Inset</span><span>radius 18</span></div>
    </div>
  </section>

  <section class="preview-card glass" data-glass data-glass-depth="2">
    <h3>Controls</h3>
    <div class="control-row">
      <button class="btn btn--primary" type="button" onclick={() => toast('Primary action')}>
        Primary
      </button>
      <button class="btn btn--accent" type="button" onclick={() => toast('Approve')}>Approve</button>
      <button class="btn btn--ghost" type="button" onclick={() => toast('Deny')}>Deny</button>
    </div>
    <div class="control-row" style="margin-top: 14px">
      <button
        class="toggle"
        type="button"
        aria-pressed={guardOn}
        onclick={() => (guardOn = !guardOn)}
      >
        <span class="toggle__track" aria-hidden="true"></span>
        Guards {guardOn ? 'on' : 'off'}
      </button>
    </div>
  </section>

  <section class="preview-card glass" data-glass data-glass-depth="2">
    <h3>Type</h3>
    <div class="type-scale">
      <span class="type-display">Live flight</span>
      <span class="type-title">Waiting for an agent</span>
      <span class="type-body">Every request, tool call, and file change, on your machine.</span>
      <span class="type-caption">Captured 2 minutes ago · Recorded via proxy</span>
    </div>
  </section>

  <section class="preview-card glass" data-glass data-glass-depth="2">
    <h3>Status</h3>
    <div class="status-row">
      <span class="status-pill status-pill--accent"><span class="dot dot--live"></span> Live</span>
      <span class="status-pill">Recorded via proxy</span>
      <span class="status-pill status-pill--ok"><span class="dot dot--ok"></span> Approved</span>
      <span class="status-pill status-pill--danger"><span class="dot dot--warn"></span> Blocked</span>
    </div>
  </section>

  <section class="preview-card glass" data-glass data-glass-depth="2">
    <h3>Numbers</h3>
    <div class="number-list">
      <div class="number-row"><span>Today</span><strong>$12.48</strong></div>
      <div class="number-row"><span>Tokens</span><strong>184,320</strong></div>
      <div class="number-row"><span>Cache hit</span><strong>92%</strong></div>
    </div>
  </section>

  <section class="preview-card glass" data-glass data-glass-depth="2">
    <h3>Renderer</h3>
    <p class="type-body" style="margin-bottom: 14px">
      Current: <strong>{stats.mode === 'webgl' ? 'WebGL2' : 'CSS fallback'}</strong>. The fallback
      uses the same wallpaper gradients and CSS backdrop blur.
    </p>
    <div class="control-row">
      <button class="btn btn--small btn--ghost" type="button" onclick={useFallback}>
        <Icon name="refresh" size={15} />
        Use CSS fallback
      </button>
      <button class="btn btn--small btn--ghost" type="button" onclick={useWebgl}>
        Use WebGL2
      </button>
      <button class="btn btn--small btn--ghost" type="button" onclick={togglePerformance}>
        Performance mode
      </button>
    </div>
  </section>

  <section class="preview-card preview-card--wide glass" data-glass data-glass-depth="2">
    <h3>Refraction test</h3>
    <div class="refraction-layout">
      <div class="refraction-sample" aria-hidden="true">
        <div class="refraction-sample__glass glass" data-glass data-glass-depth="2">
          <span class="refraction-sample__label">Glass over checker</span>
        </div>
      </div>
      <div class="refraction-copy">
        <p>
          Switch the wallpaper to a high-contrast checker with warm and cool bands. The glass
          rim bends the pattern, and the three colour channels sample at slightly different
          offsets, so chromatic aberration becomes easy to see.
        </p>
        <div class="control-row">
          <button
            class="btn btn--small btn--ghost"
            type="button"
            aria-pressed={pattern === 'checker'}
            onclick={togglePattern}
          >
            <Icon name="check" size={15} />
            {pattern === 'checker' ? 'Use smoky wallpaper' : 'Use checker wallpaper'}
          </button>
          <span class="type-caption">Current: {pattern}</span>
        </div>
      </div>
    </div>
  </section>
</div>

<div class="preview-foot">
  <small>
    Every surface is drawn by one WebGL2 pass, with a CSS fallback. The debug readout stays out
    of the render loop, so an idle canvas reports zero redraws.
  </small>
</div>

<aside class="debug-overlay" data-glass-debug aria-label="Glass renderer diagnostics">
  <span class="debug-overlay__head">Glass diagnostics</span>
  <span>Shader</span><span>{shaderLabel}</span>
  <span>Shapes</span><span>{stats.shapes}</span>
  <span>FPS</span><span>{fpsLabel}</span>
  <span>Redraws</span><span>{stats.redrawsPerSecond}/s</span>
</aside>
