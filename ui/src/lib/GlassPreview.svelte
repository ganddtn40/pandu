<script lang="ts">
  import Icon from './Icon.svelte';
  import { toast } from './toast-store.svelte';
  import { themeState, setTheme } from './theme.svelte';

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
  let renderer = forcedFallback ? 'CSS fallback' : 'WebGL2';

  function reload(params: { glass?: string | null; perf?: string | null }): void {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
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
      Current: <strong>{renderer}</strong>. The fallback uses CSS backdrop blur and keeps every
      screen readable.
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
</div>

<div class="preview-foot">
  <div class="segmented segmented--small" role="group" aria-label="Appearance">
    <button
      type="button"
      aria-pressed={themeState.value === 'light'}
      onclick={() => setTheme('light')}
    >
      <Icon name="sun" size={15} />
      <span>Light</span>
    </button>
    <button
      type="button"
      aria-pressed={themeState.value === 'dark'}
      onclick={() => setTheme('dark')}
    >
      <Icon name="moon" size={15} />
      <span>Dark</span>
    </button>
  </div>
  <small>Every surface is drawn by one WebGL2 pass, with a CSS fallback.</small>
</div>
