import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Android connects to a daemon on the local network over plain HTTP, so the
 * WebView itself runs on http://localhost rather than https://localhost. That
 * keeps requests to the daemon from being blocked as mixed content.
 */
const config: CapacitorConfig = {
  appId: 'dev.cockpit.mobile',
  appName: 'Cockpit',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
