import { runCli } from './cli.js';

try {
  await runCli();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cockpit: ${message}\n`);
  process.exitCode = 1;
}
