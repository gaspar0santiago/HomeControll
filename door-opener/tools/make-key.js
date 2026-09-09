#!/usr/bin/env node
'use strict';

// Device and dashboard key generator.
//
//   node tools/make-key.js device
//   node tools/make-key.js dashboard
//
// Prints the key once, then the SQL to store its hash. The plaintext never
// goes into a SQL statement, so it never lands in the database query log,
// which is the whole reason this hashes here rather than in Postgres.
//
// These are 256 bits of randomness rather than something a person types,
// so a plain SHA-256 is the right hash. The 120000 PBKDF2 iterations on the
// pass hashes exist because humans choose those and a dictionary exists to
// stretch against. There is no dictionary for this.

const crypto = require('crypto');

const KINDS = {
  device: {
    what: 'the ESP32',
    can: 'claim one waiting command, and nothing else',
    where: 'firmware/door_opener/config.h, as DOOR_DEVICE_KEY'
  },
  dashboard: {
    what: 'the home controller',
    can: 'read the recent attempt log, without IP addresses',
    where: 'home-controller/.env, as DOOR_DASHBOARD_KEY'
  }
};

function usage(message) {
  if (message) console.error('\n  ' + message);
  console.error(`
  Usage:
    node tools/make-key.js device      key for the ESP32
    node tools/make-key.js dashboard   key for the home controller

  Two separate keys on purpose, so they rotate independently. Losing the
  dashboard key leaks a list of times and labels. Losing the device key
  gets someone the ability to swallow commands, which is why the board is
  the only thing that ever holds it.
`);
  process.exit(1);
}

const kind = process.argv[2];
if (!kind || !KINDS[kind]) usage(kind ? `Unknown key kind "${kind}".` : null);

const key = crypto.randomBytes(32).toString('base64url');
const hash = crypto.createHash('sha256').update(key).digest('hex');
const meta = KINDS[kind];

console.log(`
  ${kind.toUpperCase()} KEY, for ${meta.what}
  ${'='.repeat(58)}

      ${key}

  ${'='.repeat(58)}

  Shown once. Only its hash is stored, so this cannot be recovered.
  Lose it and generate another, then re-run the SQL below.

  It can:  ${meta.can}
  Goes in: ${meta.where}

  Run this in the Supabase SQL editor:

    insert into door_keys (name, hash)
    values ('${kind}', '${hash}')
    on conflict (name) do update set hash = excluded.hash;

  To rotate later, generate a new one and run that same statement. The
  old key stops working the moment it commits.
`);
