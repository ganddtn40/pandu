<script lang="ts">
  import Icon from '../Icon.svelte';
  import { ACCENTS, accentFor } from '../design/accents';
  import { openAppearance } from '../design/appearance.svelte';
  import { designState, resetDesign } from '../design/design.svelte';
  import { LANGUAGES, RADII, SURFACE_STYLES, THEME_MODES } from '../design/types';
  import { toast } from '../toast-store.svelte';

  const design = $derived(designState.value);
  const accent = $derived(accentFor(design.accent, design.theme));
  const themeLabel = $derived(THEME_MODES.find((entry) => entry.id === design.theme)?.label ?? 'Dark');
  const surfaceLabel = $derived(
    SURFACE_STYLES.find((entry) => entry.id === design.surface)?.label ?? 'Hybrid',
  );
  const radiusLabel = $derived(RADII[design.radius].label);
  const accentLabel = $derived(
    ACCENTS.find((entry) => entry.id === design.accent)?.label ?? design.accent,
  );
  const languageLabel = $derived(
    LANGUAGES.find((entry) => entry.id === design.language)?.label ?? 'English',
  );

  function reset(): void {
    resetDesign();
    toast('Appearance reset to the Cockpit default.');
  }
</script>

<div class="screen-head">
  <div>
    <p class="kicker">Settings</p>
    <h1>Make it yours</h1>
    <p class="screen-lede">
      Appearance, privacy, and platform support. Everything is stored on this device.
    </p>
  </div>
  <div class="screen-actions">
    <button class="btn btn--primary" type="button" onclick={openAppearance}>
      <Icon name="palette" size={16} />
      Open appearance
    </button>
  </div>
</div>

<div class="settings-grid">
  <section class="card settings-card settings-card--wide" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon" style={`--swatch: ${accent.base}`}>
        <Icon name="palette" size={19} />
      </span>
      <div>
        <h2>Appearance</h2>
        <p>Changes preview live. Nothing reloads.</p>
      </div>
      <button class="btn btn--small btn--ghost" type="button" onclick={openAppearance}>Edit</button>
    </div>
    <dl class="summary-list">
      <div><dt>Theme</dt><dd>{themeLabel}</dd></div>
      <div><dt>Surface</dt><dd>{surfaceLabel}</dd></div>
      <div><dt>Accent</dt><dd><span class="swatch-dot" style={`background: ${accent.base}`}></span>{accentLabel}</dd></div>
      <div><dt>Corners</dt><dd>{radiusLabel}</dd></div>
      <div><dt>Language</dt><dd>{languageLabel}</dd></div>
    </dl>
    <div class="settings-card__foot">
      <button class="text-link" type="button" onclick={reset}>
        <Icon name="rotate" size={14} />
        Reset appearance
      </button>
    </div>
  </section>

  <section class="card settings-card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon"><Icon name="shield" size={19} /></span>
      <div>
        <h2>Data and privacy</h2>
        <p>Local by default, always.</p>
      </div>
    </div>
    <ul class="check-list">
      <li><Icon name="check" size={15} /> No account, cloud, or telemetry</li>
      <li><Icon name="check" size={15} /> Flights stay in local SQLite</li>
      <li><Icon name="check" size={15} /> No TLS interception or credential capture</li>
    </ul>
    <button class="text-link" type="button" onclick={() => toast('The privacy guide arrives in Phase 12.')}>
      Read the privacy guide
      <Icon name="arrow-right" size={14} />
    </button>
  </section>

  <section class="card settings-card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon"><Icon name="globe" size={19} /></span>
      <div>
        <h2>Platforms</h2>
        <p>Supported today and planned.</p>
      </div>
    </div>
    <dl class="summary-list summary-list--tight">
      <div><dt>Today</dt><dd>Web (PWA), Android, Windows</dd></div>
      <div><dt>Planned</dt><dd>macOS, iOS, Linux</dd></div>
    </dl>
    <p class="settings-card__note">
      Only the three supported platforms are built and released. Planned platforms are not
      advertised as working.
    </p>
  </section>

  <section class="card settings-card" data-glass data-glass-layer="card" data-glass-depth="2">
    <div class="settings-card__head">
      <span class="settings-card__icon"><Icon name="info" size={19} /></span>
      <div>
        <h2>About</h2>
        <p>Cockpit 0.2.0 rewrite</p>
      </div>
    </div>
    <p class="settings-card__note">
      Your agent's remote control, flight recorder and safety net. The daemon connection,
      onboarding tour, and updates arrive in the next phases.
    </p>
    <div class="button-row">
      <a class="btn btn--small btn--ghost" href="/welcome" data-route>
        <Icon name="play" size={14} />
        Preview onboarding
      </a>
      <button class="btn btn--small btn--ghost" type="button" onclick={() => toast('Update checks arrive in Phase 10.')}>
        Check for updates
      </button>
    </div>
  </section>
</div>
