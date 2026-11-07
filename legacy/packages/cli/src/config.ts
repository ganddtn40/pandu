import { displayHostForUrl, loadConfig, type CockpitConfig } from '@cockpit/daemon';

export interface CliConfigOverrides {
  host?: string;
  port?: number;
}

export function loadCliConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: CliConfigOverrides = {},
): CockpitConfig {
  const base = loadConfig(env);
  return {
    ...base,
    host: overrides.host ?? base.host,
    port: overrides.port ?? base.port,
  };
}

export function daemonBaseUrl(config: CockpitConfig): string {
  return `http://${displayHostForUrl(config.host)}:${config.port}`;
}

/** The browser dashboard shares an origin with the daemon API. */
export function dashboardUrl(baseUrl: string, sessionId?: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return sessionId ? `${base}/sessions/${encodeURIComponent(sessionId)}` : `${base}/`;
}
