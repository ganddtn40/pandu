<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { ACCENTS, accentFor } from './design/accents';
  import { appearanceState, closeAppearance } from './design/appearance.svelte';
  import { designState, resetDesign, setDesign } from './design/design.svelte';
  import {
    designFromTheme,
    parseThemeText,
    themeShareUrl,
    themeToJson,
  } from './design/theme-json';
  import {
    DENSITIES,
    FONTS,
    LANGUAGES,
    MOTIONS,
    RADII,
    SURFACE_STYLES,
    THEME_MODES,
    WALLPAPERS,
  } from './design/types';
  import { readWallpaperFile } from './design/wallpaper';
  import { toast } from './toast-store.svelte';

  let sheet = $state<HTMLElement | null>(null);
  let themeFileInput = $state<HTMLInputElement | null>(null);
  let wallpaperInput = $state<HTMLInputElement | null>(null);
  let busy = $state(false);

  const design = $derived(designState.value);
  const accent = $derived(accentFor(design.accent, design.theme));
  const glassMuted = $derived(design.surface === 'matte');

  $effect(() => {
    if (!appearanceState.open) return;
    void tick().then(() => {
      sheet?.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
    });
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !appearanceState.open) return;
    event.preventDefault();
    closeAppearance();
  }

  async function copyShareLink(): Promise<void> {
    const url = themeShareUrl(themeToJson(designState.value), window.location.origin);
    try {
      await navigator.clipboard.writeText(url);
      toast('Share link copied. It carries the look, never your wallpaper.');
    } catch {
      toast('Clipboard unavailable. Use Export theme instead.');
    }
  }

  function exportTheme(): void {
    const theme = themeToJson(designState.value);
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'pandu-theme.json';
    anchor.click();
    URL.revokeObjectURL(url);
    toast('Theme exported as JSON.');
  }

  async function importTheme(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    busy = true;
    try {
      const parsed = parseThemeText(await file.text());
      if (!parsed.ok) {
        toast(parsed.error);
        return;
      }
      setDesign(designFromTheme(parsed.value, designState.value));
      toast('Theme imported. Wallpaper and performance stay on this device.');
    } catch {
      toast('Could not read that theme file.');
    } finally {
      busy = false;
    }
  }

  async function importWallpaper(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    busy = true;
    try {
      const image = await readWallpaperFile(file);
      setDesign({ wallpaperImage: image, wallpaper: 'image' });
      toast('Wallpaper saved on this device only.');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not read that image.');
    } finally {
      busy = false;
    }
  }

  function removeWallpaper(): void {
    setDesign({ wallpaperImage: null, wallpaper: 'procedural' });
    toast('Wallpaper removed.');
  }

  function reset(): void {
    resetDesign();
    toast('Appearance reset to the Pandu default.');
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if appearanceState.open}
  <div
    class="sheet-scrim"
    role="presentation"
    onclick={closeAppearance}
    onkeydown={(event) => {
      if (event.key === 'Escape') closeAppearance();
    }}
  >
    <div
      bind:this={sheet}
      class="sheet sheet--appearance float"
      role="dialog"
      aria-modal="true"
      aria-labelledby="appearance-title"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
      onkeydown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeAppearance();
        }
        event.stopPropagation();
      }}
    >
      <header class="sheet__head">
        <div>
          <p class="kicker">Settings</p>
          <h2 id="appearance-title">Appearance</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close appearance" onclick={closeAppearance}>
          <Icon name="close" size={19} />
        </button>
      </header>

      <div class="sheet__body">
        <div class="mini-preview" aria-hidden="true">
          <div class="mini-preview__copy">
            <span class="mini-preview__label">Live preview</span>
            <span class="mini-preview__value">$0.42</span>
            <span class="mini-preview__sub">Today · 3 flights</span>
          </div>
          <div class="mini-preview__side">
            <span class="status-pill status-pill--accent"><span class="dot dot--live"></span> Live</span>
            <svg class="mini-preview__spark" viewBox="0 0 120 34" aria-hidden="true">
              <path
                d="M2 27 18 24 34 26 50 17 66 20 82 11 98 14 118 6"
                fill="none"
                stroke="var(--accent)"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            <span class="mini-preview__pill" style={`background: ${accent.base}; color: ${accent.contrast}`}>
              Primary
            </span>
          </div>
        </div>

        <section class="sheet-section" aria-labelledby="appearance-theme">
          <div class="sheet-section__head">
            <h3 id="appearance-theme">Theme</h3>
            <p>Dark is the default. Light and Frost stay soft, never stark white.</p>
          </div>
          <div class="theme-cards" role="group" aria-label="Theme">
            {#each THEME_MODES as option}
              <button
                class="theme-card"
                class:is-active={design.theme === option.id}
                type="button"
                aria-pressed={design.theme === option.id}
                onclick={() => setDesign({ theme: option.id })}
              >
                <span class="theme-card__preview theme-card__preview--{option.id}" aria-hidden="true">
                  <span class="theme-card__bar"></span>
                  <span class="theme-card__tile"></span>
                  <span class="theme-card__dot" style={`background: ${accentFor(design.accent, option.id).base}`}></span>
                </span>
                <span class="theme-card__label">{option.label}</span>
                <span class="theme-card__note">{option.note}</span>
              </button>
            {/each}
          </div>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-surface">
          <div class="sheet-section__head">
            <h3 id="appearance-surface">Surface</h3>
            <p>Matte is fastest. Glass refracts the wallpaper. Hybrid floats glass over matte cards.</p>
          </div>
          <div class="seg seg--stack" role="group" aria-label="Surface style">
            {#each SURFACE_STYLES as option}
              <button
                class="seg__option"
                class:is-active={design.surface === option.id}
                type="button"
                aria-pressed={design.surface === option.id}
                onclick={() => setDesign({ surface: option.id })}
              >
                <strong>{option.label}</strong>
                <small>{option.note}</small>
              </button>
            {/each}
          </div>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-accent">
          <div class="sheet-section__head">
            <h3 id="appearance-accent">Accent</h3>
            <p>One accent at a time. Status colours stay separate and meaningful.</p>
          </div>
          <div class="accent-grid" role="group" aria-label="Accent colour">
            {#each ACCENTS as option}
              {@const swatch = option[design.theme]}
              <button
                class="accent-option"
                class:is-active={design.accent === option.id}
                type="button"
                aria-pressed={design.accent === option.id}
                onclick={() => setDesign({ accent: option.id })}
              >
                <span class="accent-option__dot" style={`background: ${swatch.base}`}></span>
                <span class="accent-option__label">{option.label}</span>
              </button>
            {/each}
          </div>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-shape">
          <div class="sheet-section__head">
            <h3 id="appearance-shape">Shape and density</h3>
            <p>Corner radius and spacing apply everywhere, including sheets and cards.</p>
          </div>
          <div class="option-block">
            <span class="option-block__label">Corners</span>
            <div class="seg" role="group" aria-label="Corner radius">
              {#each Object.entries(RADII) as [id, value]}
                <button
                  class="seg__option seg__option--compact"
                  class:is-active={design.radius === id}
                  type="button"
                  aria-pressed={design.radius === id}
                  onclick={() => setDesign({ radius: id as keyof typeof RADII })}
                >
                  <span class="corner-chip corner-chip--{id}" aria-hidden="true"></span>
                  {value.label}
                </button>
              {/each}
            </div>
          </div>
          <div class="option-block">
            <span class="option-block__label">Density</span>
            <div class="seg" role="group" aria-label="Density">
              {#each Object.entries(DENSITIES) as [id, value]}
                <button
                  class="seg__option seg__option--compact"
                  class:is-active={design.density === id}
                  type="button"
                  aria-pressed={design.density === id}
                  onclick={() => setDesign({ density: id as keyof typeof DENSITIES })}
                >
                  {value.label}
                </button>
              {/each}
            </div>
          </div>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-type">
          <div class="sheet-section__head">
            <h3 id="appearance-type">Type</h3>
            <p>System is fastest. Mono changes code only, never labels.</p>
          </div>
          <div class="seg" role="group" aria-label="Font">
            {#each FONTS as option}
              <button
                class="seg__option seg__option--compact"
                class:is-active={design.font === option.id}
                type="button"
                aria-pressed={design.font === option.id}
                onclick={() => setDesign({ font: option.id })}
              >
                {option.label}
              </button>
            {/each}
          </div>
          <label class="slider-row">
            <span>Text size</span>
            <output>{Math.round(design.fontScale * 100)}%</output>
            <input
              class="slider"
              type="range"
              min="0.85"
              max="1.3"
              step="0.05"
              value={design.fontScale}
              oninput={(event) => setDesign({ fontScale: Number(event.currentTarget.value) })}
            />
          </label>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-glass">
          <div class="sheet-section__head">
            <h3 id="appearance-glass">Glass</h3>
            <p>
              {glassMuted
                ? 'Matte is active, so these values are saved for the next glass surface.'
                : 'Tune the floating layers. The renderer updates without a reload.'}
            </p>
          </div>
          <label class="slider-row" class:is-muted={glassMuted}>
            <span>Intensity</span>
            <output>{design.glassIntensity}%</output>
            <input
              class="slider"
              type="range"
              min="0"
              max="100"
              step="1"
              value={design.glassIntensity}
              oninput={(event) => setDesign({ glassIntensity: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="slider-row" class:is-muted={glassMuted}>
            <span>Blur</span>
            <output>{design.glassBlur}%</output>
            <input
              class="slider"
              type="range"
              min="0"
              max="100"
              step="1"
              value={design.glassBlur}
              oninput={(event) => setDesign({ glassBlur: Number(event.currentTarget.value) })}
            />
          </label>
          <label class="slider-row" class:is-muted={glassMuted}>
            <span>Refraction</span>
            <output>{design.glassRefraction}%</output>
            <input
              class="slider"
              type="range"
              min="0"
              max="100"
              step="1"
              value={design.glassRefraction}
              oninput={(event) => setDesign({ glassRefraction: Number(event.currentTarget.value) })}
            />
          </label>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-wallpaper">
          <div class="sheet-section__head">
            <h3 id="appearance-wallpaper">Wallpaper</h3>
            <p>Your own image stays on this device and is never exported with a theme.</p>
          </div>
          <div class="seg" role="group" aria-label="Wallpaper">
            {#each WALLPAPERS as option}
              <button
                class="seg__option seg__option--compact"
                class:is-active={design.wallpaper === option.id}
                type="button"
                aria-pressed={design.wallpaper === option.id}
                onclick={() => {
                  if (option.id === 'image' && !design.wallpaperImage) {
                    wallpaperInput?.click();
                    return;
                  }
                  setDesign({ wallpaper: option.id });
                }}
              >
                {option.label}
              </button>
            {/each}
          </div>
          <div class="wallpaper-row">
            {#if design.wallpaperImage}
              <span class="wallpaper-thumb" style={`background-image: url("${design.wallpaperImage}")`}></span>
            {/if}
            <button class="btn btn--small btn--ghost" type="button" disabled={busy} onclick={() => wallpaperInput?.click()}>
              <Icon name="upload" size={15} />
              {design.wallpaperImage ? 'Replace image' : 'Choose image'}
            </button>
            {#if design.wallpaperImage}
              <button class="text-link" type="button" onclick={removeWallpaper}>
                <Icon name="trash" size={14} />
                Remove
              </button>
            {/if}
          </div>
          <input
            bind:this={wallpaperInput}
            class="sr-only"
            type="file"
            accept="image/*"
            aria-label="Choose a wallpaper image"
            onchange={importWallpaper}
          />
        </section>

        <section class="sheet-section" aria-labelledby="appearance-motion">
          <div class="sheet-section__head">
            <h3 id="appearance-motion">Motion and performance</h3>
            <p>Reduced motion removes parallax. Performance mode turns off WebGL and blur.</p>
          </div>
          <div class="seg" role="group" aria-label="Motion">
            {#each MOTIONS as option}
              <button
                class="seg__option seg__option--compact"
                class:is-active={design.motion === option.id}
                type="button"
                aria-pressed={design.motion === option.id}
                onclick={() => setDesign({ motion: option.id })}
              >
                {option.label}
              </button>
            {/each}
          </div>
          <button
            class="toggle"
            type="button"
            aria-pressed={design.performance}
            onclick={() => setDesign({ performance: !design.performance })}
          >
            <span class="toggle__track" aria-hidden="true"></span>
            Performance mode
          </button>
          <button
            class="toggle"
            type="button"
            aria-pressed={design.borders}
            onclick={() => setDesign({ borders: !design.borders })}
          >
            <span class="toggle__track" aria-hidden="true"></span>
            Card borders
          </button>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-language">
          <div class="sheet-section__head">
            <h3 id="appearance-language">Language</h3>
            <p>English is complete. The other catalogs are drafts and marked as such.</p>
          </div>
          <label class="select-row">
            <span>Interface language</span>
            <select
              value={design.language}
              onchange={(event) =>
                setDesign({ language: event.currentTarget.value as typeof design.language })}
            >
              {#each LANGUAGES as option}
                <option value={option.id}>{option.label} · {option.note}</option>
              {/each}
            </select>
          </label>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-theme-file">
          <div class="sheet-section__head">
            <h3 id="appearance-theme-file">Theme file</h3>
            <p>Versioned JSON. Import validates every field and never runs code.</p>
          </div>
          <div class="button-row button-row--tight">
            <button class="btn btn--small btn--ghost" type="button" onclick={exportTheme}>
              <Icon name="download" size={15} />
              Export
            </button>
            <button class="btn btn--small btn--ghost" type="button" onclick={copyShareLink}>
              <Icon name="copy" size={15} />
              Copy share link
            </button>
            <button
              class="btn btn--small btn--ghost"
              type="button"
              disabled={busy}
              onclick={() => themeFileInput?.click()}
            >
              <Icon name="upload" size={15} />
              Import
            </button>
            <button class="btn btn--small btn--ghost" type="button" onclick={reset}>
              <Icon name="rotate" size={15} />
              Reset
            </button>
          </div>
          <input
            bind:this={themeFileInput}
            class="sr-only"
            type="file"
            accept="application/json,.json"
            aria-label="Import a theme file"
            onchange={importTheme}
          />
        </section>
      </div>
    </div>
  </div>
{/if}
