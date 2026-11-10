import { readGlassPattern } from '../glass-pattern';
import { lowBattery, readDeviceProfile, shouldAutoPerformance } from '../device';
import { accentFor } from './accents';
import { DESIGN_STORAGE_KEY, loadDesign, saveDesign } from './theme-json';
import {
  DEFAULT_DESIGN,
  DESIGN_SCHEMA_VERSION,
  type DesignPreferences,
  type ThemeMode,
} from './types';

const THEME_COLORS: Record<ThemeMode, string> = {
  dark: '#0b0d10',
  light: '#f3f1ec',
  frost: '#eaf1f6',
};

function readInitial(): DesignPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_DESIGN };
  try {
    return loadDesign(window.localStorage, window.location.search);
  } catch {
    return { ...DEFAULT_DESIGN };
  }
}

export const designState = $state<{ value: DesignPreferences }>({ value: readInitial() });

function updateThemeColor(theme: ThemeMode): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[theme];
}

export function applyDesign(design: DesignPreferences): void {
  const html = document.documentElement;
  html.dataset.theme = design.theme;
  html.dataset.surface = design.surface;
  html.dataset.accent = design.accent;
  html.dataset.radius = design.radius;
  html.dataset.density = design.density;
  html.dataset.font = design.font;
  html.dataset.motion = design.motion;
  html.dataset.borders = design.borders ? 'on' : 'off';
  html.dataset.wallpaper = design.wallpaper;
  html.dataset.performance = design.performance ? 'on' : 'off';
  html.dataset.designReady = 'true';
  html.style.colorScheme = design.theme === 'dark' ? 'dark' : 'light';
  html.style.setProperty('--font-scale', String(design.fontScale));
  html.style.setProperty('--glass-blur-px', `${Math.round(4 + design.glassBlur * 0.32)}px`);
  html.style.setProperty('--glass-intensity', String(design.glassIntensity / 100));
  html.style.setProperty(
    '--glass-refraction',
    String(0.25 + (design.glassRefraction / 100) * 1.5),
  );
  if (design.wallpaper === 'image' && design.wallpaperImage) {
    html.style.setProperty('--wallpaper-image', `url("${design.wallpaperImage}")`);
  } else {
    html.style.setProperty('--wallpaper-image', 'none');
  }
  updateThemeColor(design.theme);
  window.dispatchEvent(
    new CustomEvent<DesignPreferences>('pandu:design', { detail: { ...design } }),
  );
}

function persist(design: DesignPreferences): void {
  try {
    saveDesign(window.localStorage, design);
  } catch {
    // Storage can be unavailable. The live preview still works.
  }
}

export function setDesign(patch: Partial<DesignPreferences>): void {
  const next: DesignPreferences = {
    ...designState.value,
    ...patch,
    version: DESIGN_SCHEMA_VERSION,
  };
  designState.value = next;
  applyDesign(next);
  persist(next);
}

export function resetDesign(): void {
  setDesign({ ...DEFAULT_DESIGN });
}

export function setThemeMode(theme: ThemeMode): void {
  setDesign({ theme });
}

export function currentAccent(): ReturnType<typeof accentFor> {
  return accentFor(designState.value.accent, designState.value.theme);
}

/**
 * Initialize the per-device preferences once. The inline boot script already
 * applies the theme before first paint; this adds the full design and keeps
 * other tabs in sync.
 */
export function initDesign(): () => void {
  const design = designState.value;
  applyDesign(design);

  let stored = true;
  try {
    stored = window.localStorage.getItem(DESIGN_STORAGE_KEY) !== null;
  } catch {
    // Storage is optional.
  }
  if (!stored) {
    // First run only: low-end machines and data-saver mode start in
    // Performance mode. Once stored, the user's choice wins.
    if (shouldAutoPerformance(readDeviceProfile())) {
      setDesign({ performance: true });
    } else {
      // Wait for the battery hint before writing the first stored design so
      // a low battery can still switch Performance mode on. Afterwards the
      // user's explicit choice always wins.
      void lowBattery().then((low) => {
        if (low) setDesign({ performance: true });
        else persist(designState.value);
      });
    }
  }
  try {
    document.documentElement.dataset.glassPattern = readGlassPattern(window.location.search);
  } catch {
    // The renderer defaults to smoky.
  }

  const onStorage = (event: StorageEvent): void => {
    if (event.key !== DESIGN_STORAGE_KEY) return;
    try {
      const next = loadDesign(window.localStorage, '');
      designState.value = next;
      applyDesign(next);
    } catch {
      // Ignore malformed cross-tab writes.
    }
  };
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener('storage', onStorage);
  };
}
