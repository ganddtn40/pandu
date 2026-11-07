import type { DemoSeedResponse } from '@cockpit/core';
import type { CockpitConfig } from '@cockpit/daemon';

import { dashboardUrl } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { startDetached } from './start.js';

export interface DemoCommandResult {
  seed: DemoSeedResponse;
  dashboardUrl: string;
  sessionUrl: string;
  reused: boolean;
  url: string;
  databasePath: string;
}

export async function runDemo(config: CockpitConfig): Promise<DemoCommandResult> {
  const started = await startDetached(config, { env: { COCKPIT_DEMO: '1' } });
  const client = new DaemonClient(started.url);
  const seed = await client.seedDemo();

  return {
    seed,
    dashboardUrl: started.dashboardUrl,
    sessionUrl: dashboardUrl(started.url, seed.sessionId),
    reused: started.reused,
    url: started.url,
    databasePath: config.databasePath,
  };
}

export function formatDemoResult(result: DemoCommandResult, json = false): string {
  if (json) {
    return `${JSON.stringify(
      {
        ...result.seed,
        dashboardUrl: result.dashboardUrl,
        sessionUrl: result.sessionUrl,
        daemonUrl: result.url,
        reused: result.reused,
      },
      null,
      2,
    )}\n`;
  }

  const count = result.seed.sessions.length;
  const noun = count === 1 ? 'flight' : 'flights';
  const lines = [
    result.seed.created ? 'Cockpit demo seeded.' : 'Cockpit demo was already seeded.',
    '',
    `Dashboard: ${result.dashboardUrl}`,
    `Flight:    ${result.sessionUrl}`,
    '',
    `${count} demo ${noun} in ${result.seed.workspacePath}`,
    `${result.seed.totals.steps} steps, ${result.seed.totals.toolCalls} tool calls, ${result.seed.totals.guardEvents} guard events`,
    result.reused
      ? `Using the Cockpit daemon already running at ${result.url}.`
      : `Cockpit daemon started at ${result.url}.`,
    '',
    'Everything is local. No agent, provider, or telemetry service was contacted.',
    `Demo data lives in ${result.databasePath}. Delete that file to remove it.`,
  ];
  return `${lines.join('\n')}\n`;
}
