import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'apps', 'web', 'dist');

if (!existsSync(path.join(source, 'index.html'))) {
  console.error(
    'copy-web: apps/web/dist is missing. Run "pnpm --filter @cockpit/web build" first.',
  );
  process.exit(1);
}

const targets = [
  path.join(root, 'packages', 'daemon', 'dist', 'web'),
  path.join(root, 'packages', 'cli', 'dist', 'web'),
];

for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  console.log(`copy-web: ${path.relative(root, source)} -> ${path.relative(root, target)}`);
}
