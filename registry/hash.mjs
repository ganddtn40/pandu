#!/usr/bin/env node
// Print the normalized content hash Pandu uses for source.content_sha256.
//
// Usage:
//   node registry/hash.mjs path/to/skill-directory
//
// The hash covers every regular file under the directory, sorted by relative
// path. For each file it feeds the SHA-256 hasher:
//   - the path length as an unsigned 64-bit big-endian integer,
//   - the UTF-8 path,
//   - the byte length as an unsigned 64-bit big-endian integer,
//   - the file bytes.
// Empty directories are ignored. Symlinks are refused. This mirrors
// tree_hash() in crates/pandu-daemon/src/market/archive.rs, so the output
// must match the hash Pandu verifies after downloading a pinned tarball.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`hash: ${message}`);
  process.exit(1);
}

const target = process.argv[2];
if (!target) {
  fail('usage: node registry/hash.mjs <directory>');
}
const root = path.resolve(target);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  fail(`${root} is not a directory`);
}

const files = [];
function walk(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    if (name === '.git') {
      continue;
    }
    const full = path.join(directory, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      fail(`refusing to hash a symlink: ${full}`);
    }
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }
    if (!stat.isFile()) {
      fail(`refusing to hash an unsupported entry: ${full}`);
    }
    files.push({
      relative: path.relative(root, full).split(path.sep).join('/'),
      bytes: fs.readFileSync(full),
    });
  }
}
walk(root);

if (files.length === 0) {
  fail('the directory contains no files');
}

files.sort((left, right) => (left.relative < right.relative ? -1 : 1));

const hasher = crypto.createHash('sha256');
for (const file of files) {
  const pathBytes = Buffer.from(file.relative, 'utf8');
  const pathLength = Buffer.alloc(8);
  pathLength.writeBigUInt64BE(BigInt(pathBytes.length));
  const byteLength = Buffer.alloc(8);
  byteLength.writeBigUInt64BE(BigInt(file.bytes.length));
  hasher.update(pathLength);
  hasher.update(pathBytes);
  hasher.update(byteLength);
  hasher.update(file.bytes);
}

console.log(hasher.digest('hex'));
