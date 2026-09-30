#!/usr/bin/env node
// Generates the Ed25519 manifest signing key pair and the OTP pepper.
//  - private key -> apps/server/.env  (MANIFEST_SIGNING_KEY)
//  - public key  -> apps/desktop/.env (MAIN_VITE_MANIFEST_PUBKEYS), embedded at build time
// Usage: node scripts/gen-keys.mjs [--force] [--print]
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const printOnly = process.argv.includes('--print');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const b64 = (u) => Buffer.from(u, 'base64url').toString('base64');
const pub = b64(publicKey.export({ format: 'jwk' }).x);
const priv = b64(privateKey.export({ format: 'jwk' }).d);

if (printOnly) {
  console.log(`MANIFEST_SIGNING_KEY=${priv}`);
  console.log(`MAIN_VITE_MANIFEST_PUBKEYS=${pub}`);
  process.exit(0);
}

function upsertEnv(file, example, entries) {
  if (!existsSync(file)) {
    if (example && existsSync(example)) copyFileSync(example, file);
    else writeFileSync(file, '');
  }
  let text = readFileSync(file, 'utf8');
  for (const [k, v, overwrite] of entries) {
    const re = new RegExp(`^${k}=(.*)$`, 'm');
    const m = re.exec(text);
    if (m && m[1].trim() && !(overwrite || force)) continue;
    if (m) text = text.replace(re, `${k}=${v}`);
    else text += `${text.endsWith('\n') || text === '' ? '' : '\n'}${k}=${v}\n`;
  }
  writeFileSync(file, text);
}

const serverEnv = resolve(root, 'apps/server/.env');
const serverText = existsSync(serverEnv) ? readFileSync(serverEnv, 'utf8') : '';
const hasKey = /^MANIFEST_SIGNING_KEY=\S+/m.test(serverText);
if (hasKey && !force) {
  console.log('apps/server/.env already has MANIFEST_SIGNING_KEY (use --force to rotate).');
} else {
  upsertEnv(serverEnv, resolve(root, 'apps/server/.env.example'), [
    ['MANIFEST_SIGNING_KEY', priv, true],
  ]);
  upsertEnv(resolve(root, 'apps/desktop/.env'), resolve(root, 'apps/desktop/.env.example'), [
    ['MAIN_VITE_MANIFEST_PUBKEYS', pub, true],
  ]);
  console.log('Wrote manifest signing key (server) and public key (desktop).');
}
upsertEnv(serverEnv, resolve(root, 'apps/server/.env.example'), [
  ['OTP_PEPPER', randomBytes(32).toString('base64url'), false],
]);
