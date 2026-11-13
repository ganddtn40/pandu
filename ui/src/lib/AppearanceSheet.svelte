<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { ACCENTS, accentFor } from './design/accents';
  import { appearanceState, closeAppearance } from './design/appearance.svelte';
  import { designState, resetDesign, setDesign } from './design/design.svelte';
  import { PRODUCT_NAME, SLUG } from './brand';
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
  import {
    ACCENT_LABELS,
    DENSITY_LABELS,
    FONT_LABELS,
    LANGUAGE_NOTES,
    MOTION_LABELS,
    RADIUS_LABELS,
    SURFACE_LABELS,
    THEME_LABELS,
    WALLPAPER_LABELS,
  } from './i18n/design-labels';
  import { t } from './i18n/i18n.svelte';
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
      toast(t('appearance.shareCopied'));
    } catch {
      toast(t('appearance.shareFailed'));
    }
  }

  function exportTheme(): void {
    const theme = themeToJson(designState.value);
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${SLUG}-theme.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast(t('appearance.exported'));
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
      toast(t('appearance.imported'));
    } catch {
      toast(t('appearance.importFailed'));
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
      toast(t('appearance.wallpaperSaved'));
    } catch (error) {
      toast(error instanceof Error ? error.message : t('appearance.wallpaperFailed'));
    } finally {
      busy = false;
    }
  }

  function removeWallpaper(): void {
    setDesign({ wallpaperImage: null, wallpaper: 'procedural' });
    toast(t('appearance.wallpaperRemoved'));
  }

  function reset(): void {
    resetDesign();
    toast(t('appearance.resetDone', { product: PRODUCT_NAME }));
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
          <p class="kicker">{t('appearance.kicker')}</p>
          <h2 id="appearance-title">{t('appearance.title')}</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label={t('appearance.close')}
          onclick={closeAppearance}
        >
          <Icon name="close" size={19} />
        </button>
      </header>

      <div class="sheet__body">
        <div class="mini-preview" aria-hidden="true">
          <div class="mini-preview__copy">
            <span class="mini-preview__label">{t('appearance.previewLive')}</span>
            <span class="mini-preview__value">$0.42</span>
            <span class="mini-preview__sub">{t('appearance.previewToday', { count: 3 })}</span>
          </div>
          <div class="mini-preview__side">
            <span class="status-pill status-pill--accent"
              ><span class="dot dot--live"></span> {t('appearance.previewLivePill')}</span
            >
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
              {t('appearance.previewPrimary')}
            </span>
          </div>
        </div>

        <section class="sheet-section" aria-labelledby="appearance-theme">
          <div class="sheet-section__head">
            <h3 id="appearance-theme">{t('appearance.theme')}</h3>
            <p>{t('appearance.themeNote')}</p>
          </div>
          <div class="theme-cards" role="group" aria-label={t('appearance.theme')}>
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
                <span class="theme-card__label">{t(THEME_LABELS[option.id].label)}</span>
                <span class="theme-card__note">{t(THEME_LABELS[option.id].note)}</span>
              </button>
            {/each}
          </div>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-surface">
          <div class="sheet-section__head">
            <h3 id="appearance-surface">{t('appearance.surface')}</h3>
            <p>{t('appearance.surfaceNote')}</p>
          </div>
          <div class="seg seg--stack" role="group" aria-label={t('appearance.surface')}>
            {#each SURFACE_STYLES as option}
              <button
                class="seg__option"
                class:is-active={design.surface === option.id}
                type="button"
                aria-pressed={design.surface === option.id}
                onclick={() => setDesign({ surface: option.id })}
              >
                <strong>{t(SURFACE_LABELS[option.id].label)}</strong>
                <small>{t(SURFACE_LABELS[option.id].note)}</small>
              </button>
            {/each}
          </div>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-accent">
          <div class="sheet-section__head">
            <h3 id="appearance-accent">{t('appearance.accent')}</h3>
            <p>{t('appearance.accentNote')}</p>
          </div>
          <div class="accent-grid" role="group" aria-label={t('appearance.accentColour')}>
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
                <span class="accent-option__label">{t(ACCENT_LABELS[option.id])}</span>
              </button>
            {/each}
          </div>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-shape">
          <div class="sheet-section__head">
            <h3 id="appearance-shape">{t('appearance.shape')}</h3>
            <p>{t('appearance.shapeNote')}</p>
          </div>
          <div class="option-block">
            <span class="option-block__label">{t('appearance.corners')}</span>
            <div class="seg" role="group" aria-label={t('appearance.cornerRadius')}>
              {#each Object.keys(RADII) as id}
                <button
                  class="seg__option seg__option--compact"
                  class:is-active={design.radius === id}
                  type="button"
                  aria-pressed={design.radius === id}
                  onclick={() => setDesign({ radius: id as keyof typeof RADII })}
                >
                  <span class="corner-chip corner-chip--{id}" aria-hidden="true"></span>
                  {t(RADIUS_LABELS[id as keyof typeof RADII])}
                </button>
              {/each}
            </div>
          </div>
          <div class="option-block">
            <span class="option-block__label">{t('appearance.density')}</span>
            <div class="seg" role="group" aria-label={t('appearance.density')}>
              {#each Object.keys(DENSITIES) as id}
                <button
                  class="seg__option seg__option--compact"
                  class:is-active={design.density === id}
                  type="button"
                  aria-pressed={design.density === id}
                  onclick={() => setDesign({ density: id as keyof typeof DENSITIES })}
                >
                  {t(DENSITY_LABELS[id as keyof typeof DENSITIES])}
                </button>
              {/each}
            </div>
          </div>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-type">
          <div class="sheet-section__head">
            <h3 id="appearance-type">{t('appearance.type')}</h3>
            <p>{t('appearance.typeNote')}</p>
          </div>
          <div class="seg" role="group" aria-label={t('appearance.font')}>
            {#each FONTS as option}
              <button
                class="seg__option seg__option--compact"
                class:is-active={design.font === option.id}
                type="button"
                aria-pressed={design.font === option.id}
                onclick={() => setDesign({ font: option.id })}
              >
                {t(FONT_LABELS[option.id].label)}
              </button>
            {/each}
          </div>
          <label class="slider-row">
            <span>{t('appearance.textSize')}</span>
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
            <h3 id="appearance-glass">{t('appearance.glass')}</h3>
            <p>{glassMuted ? t('appearance.glassMuted') : t('appearance.glassNote')}</p>
          </div>
          <label class="slider-row" class:is-muted={glassMuted}>
            <span>{t('appearance.intensity')}</span>
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
            <span>{t('appearance.blur')}</span>
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
            <span>{t('appearance.refraction')}</span>
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
            <h3 id="appearance-wallpaper">{t('appearance.wallpaper')}</h3>
            <p>{t('appearance.wallpaperNote')}</p>
          </div>
          <div class="seg" role="group" aria-label={t('appearance.wallpaper')}>
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
                {t(WALLPAPER_LABELS[option.id].label)}
              </button>
            {/each}
          </div>
          <div class="wallpaper-row">
            {#if design.wallpaperImage}
              <span class="wallpaper-thumb" style={`background-image: url("${design.wallpaperImage}")`}></span>
            {/if}
            <button class="btn btn--small btn--ghost" type="button" disabled={busy} onclick={() => wallpaperInput?.click()}>
              <Icon name="upload" size={15} />
              {design.wallpaperImage ? t('appearance.replaceImage') : t('appearance.chooseImage')}
            </button>
            {#if design.wallpaperImage}
              <button class="text-link" type="button" onclick={removeWallpaper}>
                <Icon name="trash" size={14} />
                {t('appearance.remove')}
              </button>
            {/if}
          </div>
          <input
            bind:this={wallpaperInput}
            class="sr-only"
            type="file"
            accept="image/*"
            aria-label={t('appearance.chooseImageLabel')}
            onchange={importWallpaper}
          />
        </section>

        <section class="sheet-section" aria-labelledby="appearance-motion">
          <div class="sheet-section__head">
            <h3 id="appearance-motion">{t('appearance.motion')}</h3>
            <p>{t('appearance.motionNote')}</p>
          </div>
          <div class="seg" role="group" aria-label={t('appearance.motionGroup')}>
            {#each MOTIONS as option}
              <button
                class="seg__option seg__option--compact"
                class:is-active={design.motion === option.id}
                type="button"
                aria-pressed={design.motion === option.id}
                onclick={() => setDesign({ motion: option.id })}
              >
                {t(MOTION_LABELS[option.id].label)}
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
            {t('appearance.performanceMode')}
          </button>
          <button
            class="toggle"
            type="button"
            aria-pressed={design.borders}
            onclick={() => setDesign({ borders: !design.borders })}
          >
            <span class="toggle__track" aria-hidden="true"></span>
            {t('appearance.cardBorders')}
          </button>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-language">
          <div class="sheet-section__head">
            <h3 id="appearance-language">{t('appearance.language')}</h3>
            <p>{t('appearance.languageNote')}</p>
          </div>
          <label class="select-row">
            <span>{t('appearance.interfaceLanguage')}</span>
            <select
              value={design.language}
              onchange={(event) =>
                setDesign({ language: event.currentTarget.value as typeof design.language })}
            >
              {#each LANGUAGES as option}
                <option value={option.id}>{option.label} · {t(LANGUAGE_NOTES[option.id])}</option>
              {/each}
            </select>
          </label>
        </section>

        <section class="sheet-section" aria-labelledby="appearance-theme-file">
          <div class="sheet-section__head">
            <h3 id="appearance-theme-file">{t('appearance.themeFile')}</h3>
            <p>{t('appearance.themeFileNote')}</p>
          </div>
          <div class="button-row button-row--tight">
            <button class="btn btn--small btn--ghost" type="button" onclick={exportTheme}>
              <Icon name="download" size={15} />
              {t('appearance.export')}
            </button>
            <button class="btn btn--small btn--ghost" type="button" onclick={copyShareLink}>
              <Icon name="copy" size={15} />
              {t('appearance.copyShareLink')}
            </button>
            <button
              class="btn btn--small btn--ghost"
              type="button"
              disabled={busy}
              onclick={() => themeFileInput?.click()}
            >
              <Icon name="upload" size={15} />
              {t('appearance.import')}
            </button>
            <button class="btn btn--small btn--ghost" type="button" onclick={reset}>
              <Icon name="rotate" size={15} />
              {t('appearance.reset')}
            </button>
          </div>
          <input
            bind:this={themeFileInput}
            class="sr-only"
            type="file"
            accept="application/json,.json"
            aria-label={t('appearance.importLabel')}
            onchange={importTheme}
          />
        </section>
      </div>
    </div>
  </div>
{/if}
