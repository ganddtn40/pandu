#!/usr/bin/env node
/**
 * Audit the JavaScript licenses that ship inside the built UI.
 *
 * `pnpm licenses list --json` groups packages by the license they declare.
 * Every group must be on the allowlist below; an unknown group fails the gate
 * so a human reviews it instead of silently shipping it.
 *
 * The Tauri CLI in `app/` is a build tool and is not redistributed, so it is
 * not part of this audit. Rust crates are audited by `cargo deny check`.
 *
 *   node packaging/check-licenses.mjs
 */
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Keep this list aligned with `deny.toml`. A new license needs a deliberate
// decision, not an automatic pass.
const allowed = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MPL-2.0',
  'Unlicense',
]);

let report;
try {
  report = JSON.parse(
    execSync('pnpm --dir ui licenses list --json', {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
} catch (error) {
  console.error('Could not read the UI license report. Run `pnpm --dir ui install` first.');
  console.error(error.message);
  process.exit(1);
}

const packages = [];
for (const [license, entries] of Object.entries(report)) {
  for (const entry of entries) {
    packages.push({
      name: entry.name,
      version: (entry.versions ?? []).join(', '),
      license: entry.license ?? license,
    });
  }
}

if (packages.length === 0) {
  console.error('The UI license report is empty. Refusing to pass an empty audit.');
  process.exit(1);
}

const failures = [];
for (const pkg of packages) {
  if (!pkg.license || pkg.license === 'NO LICENSE DECLARED') {
    failures.push(`${pkg.name}@${pkg.version} declares no license`);
    continue;
  }
  if (!allowed.has(pkg.license)) {
    failures.push(`${pkg.name}@${pkg.version} uses ${pkg.license}`);
  }
}

const counts = new Map();
for (const pkg of packages) {
  counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
}

console.log(`Audited ${packages.length} JavaScript packages in the shipped UI.`);
for (const [license, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${license}: ${count}`);
}

if (failures.length > 0) {
  console.error('\nLicense audit failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error('\nAdd the license to this allowlist and to deny.toml only after review.');
  process.exit(1);
}

console.log('Every shipped JavaScript package uses an allowed license.');
