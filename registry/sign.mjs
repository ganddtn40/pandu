#!/usr/bin/env node
// Sign the Cockpit registry index and revocation list with the maintainer key.
//
// Usage:
//   node registry/sign.mjs --key /secure/path/private.pem
//   node registry/sign.mjs --key /secure/path/private.pem --build
//
// `--build` rebuilds index.json from skills/*.yaml and mcp/*.yaml first. The
// private key is never written to the repository. The public key printed at
// the end must match REGISTRY_PUBLIC_KEY_BASE64 in
// crates/cockpit-daemon/src/market/mod.rs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`sign: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const keyIndex = args.indexOf('--key');
if (keyIndex === -1 || !args[keyIndex + 1]) {
  fail('pass --key <private.pem>');
}
const keyPath = args[keyIndex + 1];
const build = args.includes('--build');
const dirIndex = args.indexOf('--dir');
const dir = dirIndex === -1 ? 'registry' : args[dirIndex + 1];

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
const publicKeyObject = crypto.createPublicKey(privateKey);
const publicKey = publicKeyObject
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('base64');
console.log(`public key: ${publicKey}`);

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sign(payload) {
  return crypto.sign(null, Buffer.from(canonical(payload), 'utf8'), privateKey).toString('base64');
}

function payloadOf(document) {
  const { signature, ...rest } = document;
  void signature;
  return rest;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function entryField(text, field) {
  const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (!match) {
    fail(`entry is missing ${field}`);
  }
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function buildIndex() {
  const indexFile = path.join(dir, 'index.json');
  const existing = fs.existsSync(indexFile) ? readJson(indexFile) : {};
  const entries = [];
  for (const [folder, kind] of [
    ['skills', 'skill'],
    ['mcp', 'mcp'],
  ]) {
    const folderPath = path.join(dir, folder);
    if (!fs.existsSync(folderPath)) {
      continue;
    }
    for (const name of fs.readdirSync(folderPath).sort()) {
      if (!name.endsWith('.yaml')) {
        continue;
      }
      const relative = `${folder}/${name}`;
      const text = fs.readFileSync(path.join(dir, relative), 'utf8');
      const bytes = fs.readFileSync(path.join(dir, relative));
      entries.push({
        kind,
        id: entryField(text, 'id'),
        path: relative,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        version: entryField(text, 'version'),
      });
    }
  }
  const generatedAt = existing.generatedAt ?? new Date().toISOString();
  writeJson(indexFile, {
    schemaVersion: 1,
    generatedAt,
    keyId: 'cockpit-market-2026',
    entries,
    signature: '',
  });
}

if (build) {
  buildIndex();
}

for (const [file, label] of [
  ['index.json', 'index'],
  ['revoked.json', 'revocation list'],
]) {
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) {
    fail(`${filePath} does not exist`);
  }
  const document = readJson(filePath);
  if (document.keyId !== 'cockpit-market-2026') {
    fail(`${label} uses keyId ${document.keyId}`);
  }
  document.signature = sign(payloadOf(document));
  if (!crypto.verify(null, Buffer.from(canonical(payloadOf(document)), 'utf8'), publicKeyObject, Buffer.from(document.signature, 'base64'))) {
    fail(`${label} did not verify after signing`);
  }
  writeJson(filePath, document);
  console.log(`signed ${filePath}`);
}
