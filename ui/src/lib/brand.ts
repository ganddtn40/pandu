/**
 * The single source of truth for every brand string in the UI.
 *
 * Values come from `brand.json` at the repository root, the same file the Rust
 * crates compile in through `pandu-core/build.rs`. Import these constants
 * instead of writing the product name, identifiers, storage keys, or titles by
 * hand.
 */
import brand from '../../../brand.json' with { type: 'json' };

export const PRODUCT_NAME = brand.name;
export const SLUG = brand.slug;
export const WORDMARK = brand.wordmark;
export const TAGLINE = brand.tagline;
export const DISAMBIGUATION = brand.disambiguation;
export const CLI_COMMAND = brand.cli.command;
export const ENV_PREFIX = brand.envPrefix;
export const DATA_DIR = brand.dataDir;
export const DATABASE_FILE = brand.databaseFile;
export const APP_ID = brand.appId;
export const ANDROID_PACKAGE = brand.androidPackage;
export const URL_SCHEME = brand.urlScheme;
export const REPOSITORY = brand.repository;
export const REGISTRY_URL = brand.registry.url;
export const UPDATE_API_URL = brand.update.apiUrl;
export const UPDATE_RELEASES_URL = brand.update.releasesUrl;
export const UPDATE_CHANNEL = brand.update.channel;
export const UPDATE_MANIFEST_ASSET = brand.update.manifestAsset;
export const UPDATE_INTERVAL_HOURS = brand.update.intervalHours;
export const THEME_SCHEMA = brand.themeSchema;
export const STORAGE_PREFIX = brand.storagePrefix;
export const WINDOW_TITLE = brand.windowTitle;
export const TRAY_TOOLTIP = brand.trayTooltip;
export const NOTIFICATION_TITLE = brand.notificationTitle;
export const LOGO_ARIA_LABEL = brand.logoAriaLabel;

/** CSRF header shared with the daemon. */
export const CSRF_HEADER = `x-${SLUG}-csrf`;
/** Rotated bearer-token header shared with the daemon. */
export const TOKEN_HEADER = `x-${SLUG}-token`;
/** Marks a response as coming from the remote listener. */
export const REMOTE_HEADER = `x-${SLUG}-remote`;
/** WebSocket ticket subprotocol prefix. */
export const WS_SUBPROTOCOL_PREFIX = `${SLUG}.`;

/** Build a browser storage key with the product prefix. */
export function storageKey(name: string): string {
  return `${STORAGE_PREFIX}${name}`;
}
