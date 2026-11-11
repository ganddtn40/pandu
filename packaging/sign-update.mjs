#!/usr/bin/env node
// Build and sign the Pandu update manifest.
//
// The private key is a Minisign secret key and must stay offline. This script
// reads it only through the `minisign` binary; it never prints or copies it.
//
// Usage:
//   node packaging/sign-update.mjs --version 0.3.0 --notes dist/notes.md \
//     --artifact windows-x86_64=dist/pandu.exe \
//     --artifact linux-x86_64=dist/pandu \
//     --key /secure/pandu-updater.key --out dist/pandu-update.json
//
// `--artifact` may be repeated. The target is the value `pandu update` looks
// up, which is `<os>-<arch>` from `std::env::consts` (for example
// `windows-x86_64` or `macos-aarch64`).
//
// The manifest carries one Minisign signature per artifact plus a signature
// over the canonical JSON payload. The canonical payload is compact JSON with
// a fixed field order and artifact targets sorted by key, matching
// `pandu_core::update::manifest_signing_payload`.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = JSON.parse(fs.readFileSync(path.join(repoRoot, 'brand.json'), 'utf8'));

function fail(message) {
  console.error(`sign-update: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage: node packaging/sign-update.mjs [options]

  --version <semver>       Release version, for example 0.3.0
  --notes <file>           Release notes as plain text or Markdown
  --artifact <target=file> Artifact to sign. Repeat for each platform.
  --key <file>             Minisign secret key, kept offline
  --out <file>             Output path (default: dist/${brand.update.manifestAsset})
  --channel <name>         Channel (default: ${brand.update.channel})
  --key-id <id>            Manifest key id (default: ${brand.update.keyId})
  --published-at <rfc3339> Optional publication timestamp
  --base-url <url>         Override the release download base URL
  --minisign <file>        Minisign binary (default: minisign)
  --help                   Show this help

The output is the signed JSON asset that belongs on the GitHub release as
${brand.update.manifestAsset}.`);
}

function parseArgs(argv) {
  const options = {
    artifacts: [],
    channel: brand.update.channel,
    keyId: brand.update.keyId,
    out: path.join(repoRoot, 'dist', brand.update.manifestAsset),
    minisign: 'minisign',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${arg} needs a value.`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--version':
        options.version = next();
        break;
      case '--notes':
        options.notesFile = next();
        break;
      case '--artifact':
        options.artifacts.push(next());
        break;
      case '--key':
        options.key = next();
        break;
      case '--out':
        options.out = next();
        break;
      case '--channel':
        options.channel = next();
        break;
      case '--key-id':
        options.keyId = next();
        break;
      case '--published-at':
        options.publishedAt = next();
        break;
      case '--base-url':
        options.baseUrl = next();
        break;
      case '--minisign':
        options.minisign = next();
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function normalizeVersion(value) {
  const version = String(value ?? '').trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`\`${value}\` is not a SemVer version such as 1.2.3.`);
  }
  return version;
}

function readArtifactSpec(spec) {
  const separator = spec.indexOf('=');
  if (separator <= 0 || separator === spec.length - 1) {
    fail(`--artifact must be <target>=<file> (got \`${spec}\`).`);
  }
  const target = spec.slice(0, separator).trim();
  const file = spec.slice(separator + 1);
  if (!target || target.length > 80) {
    fail(`The artifact target must be between 1 and 80 characters.`);
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail(`The artifact does not exist: ${file}`);
  }
  return { target, file };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function signFile(options, file, signaturePath) {
  try {
    execFileSync(
      options.minisign,
      ['-S', '-s', options.key, '-m', file, '-x', signaturePath],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(
        'The minisign binary was not found. Install Minisign, or pass --minisign <file>.',
      );
    }
    fail(`minisign could not sign ${path.basename(file)}.`);
  }
  if (!fs.existsSync(signaturePath)) {
    fail(`minisign did not write a signature for ${path.basename(file)}.`);
  }
  return fs.readFileSync(signaturePath, 'utf8').trim();
}

/**
 * The exact bytes the manifest signature covers. Keep this in sync with
 * `ManifestPayload` in crates/pandu-core/src/update.rs.
 */
export function canonicalPayload(manifest) {
  const artifacts = {};
  for (const target of Object.keys(manifest.artifacts).sort()) {
    const artifact = manifest.artifacts[target];
    const entry = { url: artifact.url, sha256: artifact.sha256 };
    if (artifact.size !== undefined) entry.size = artifact.size;
    entry.signature = artifact.signature;
    artifacts[target] = entry;
  }
  const payload = {
    schema: manifest.schema,
    channel: manifest.channel,
    version: manifest.version,
    keyId: manifest.keyId,
    notes: manifest.notes,
  };
  if (manifest.publishedAt) payload.publishedAt = manifest.publishedAt;
  payload.artifacts = artifacts;
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.version) fail('--version is required.');
  if (!options.notesFile) fail('--notes is required.');
  if (!options.key) fail('--key is required. The private key never belongs in the repository.');
  if (options.artifacts.length === 0) fail('At least one --artifact is required.');
  if (!fs.existsSync(options.notesFile)) {
    fail(`The notes file does not exist: ${options.notesFile}`);
  }

  const version = normalizeVersion(options.version);
  const notes = fs.readFileSync(options.notesFile, 'utf8').trimEnd();
  if ([...notes].length > 12_000) {
    fail('The release notes must be 12,000 characters or fewer.');
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pandu-update-'));
  try {
    const artifacts = {};
    for (const spec of options.artifacts) {
      const { target, file } = readArtifactSpec(spec);
      if (artifacts[target]) fail(`Duplicate artifact target: ${target}`);
      const signature = signFile(options, file, path.join(temporary, `${target}.minisig`));
      const url =
        options.baseUrl?.replace(/\/$/, '') ??
        `${brand.repository}/releases/download/v${version}`;
      artifacts[target] = {
        url: `${url}/${encodeURIComponent(path.basename(file))}`,
        sha256: sha256(file),
        size: fs.statSync(file).size,
        signature,
      };
    }

    const manifest = {
      schema: 1,
      channel: options.channel,
      version,
      keyId: options.keyId,
      notes,
      ...(options.publishedAt ? { publishedAt: options.publishedAt } : {}),
      artifacts,
      signature: '',
    };

    const payloadPath = path.join(temporary, 'payload.json');
    fs.writeFileSync(payloadPath, canonicalPayload(manifest));
    manifest.signature = signFile(options, payloadPath, path.join(temporary, 'payload.minisig'));

    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
    const digest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(options.out))
      .digest('hex');
    console.log(`Wrote ${options.out}`);
    console.log(`Channel ${manifest.channel}, version ${manifest.version}, key ${manifest.keyId}`);
    console.log(`SHA-256 ${digest}`);
    console.log(`Upload this file as the release asset named ${path.basename(options.out)}.`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
