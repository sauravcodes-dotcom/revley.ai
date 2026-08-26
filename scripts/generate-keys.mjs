#!/usr/bin/env node
/**
 * Generate a development Ed25519 keypair for signing agent capabilities.
 *
 * Prints .env lines with newlines escaped. Nothing is written to disk: a key that the
 * tooling saves for you is a key that eventually gets committed.
 */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const esc = (pem) => pem.trim().replace(/\n/g, '\\n');

process.stdout.write(
  `CAPABILITY_PRIVATE_KEY="${esc(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())}"\n` +
  `CAPABILITY_PUBLIC_KEY="${esc(publicKey.export({ type: 'spki', format: 'pem' }).toString())}"\n`,
);
