#!/usr/bin/env node
'use strict';

// Pass generator.
//
//   node tools/make-pass.js resident --label "Santi"
//   node tools/make-pass.js guest --label "Sat party" \
//        --from "2026-09-12T20:00" --until "2026-09-13T02:00" --max-uses 1
//
// Prints the plaintext once, then the SQL to store it. The plaintext is
// never written anywhere and cannot be recovered afterwards; a lost pass
// is regenerated, not looked up.
//
// There is no admin UI on purpose. This plus the SQL editor is the whole
// management surface.

const crypto = require('crypto');

// PBKDF2-SHA256. Must match supabase/functions/_shared/door.ts exactly, or
// nothing generated here will ever match.
const ITERATIONS = 120000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

// No 0, O, 1 or I. Read out over a noisy hallway or typed at 1am, those
// four cost more failed attempts than the extra bit of entropy is worth.
// 32 characters, and 256 divides by 32 exactly, so a random byte masked to
// 5 bits is uniform with no rejection sampling.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// 32^8 is about 2^40. The per IP lockout caps online guessing at 5 tries
// per 15 minutes, and the global limiter caps it at 30 even across rotated
// IPs, so this is far past the point where guessing is the weak link.
const DEFAULT_LENGTH = 8;

function usage(message) {
  if (message) console.error('\n  ' + message);
  console.error(`
  Usage:
    node tools/make-pass.js resident --label "<name>" [--length 8]
    node tools/make-pass.js guest    --label "<name>" --until "<when>"
                                     [--from "<when>"] [--max-uses N] [--length 8]

  Options:
    --label      What this pass is called. Shows on the kiosk door panel.
    --from       When it starts working. Defaults to now.
    --until      When it stops working. Required for a guest pass.
    --max-uses   Cap the number of opens. Omit for unlimited.
    --length     Characters in the pass. Default ${DEFAULT_LENGTH}.

  Times are read in this machine's local timezone. Both
  "2026-09-12T20:00" and "2026-09-12 20:00" work.
`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { kind: argv[0], label: null, from: null, until: null, maxUses: null, length: DEFAULT_LENGTH };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--label':    out.label = value; i++; break;
      case '--from':     out.from = value; i++; break;
      case '--until':    out.until = value; i++; break;
      case '--max-uses': out.maxUses = value; i++; break;
      case '--length':   out.length = value; i++; break;
      default: usage(`Unknown option "${flag}".`);
    }
    if (value === undefined) usage(`"${flag}" needs a value.`);
  }
  return out;
}

function parseWhen(text, flag) {
  // A space instead of a T is what people actually type.
  const date = new Date(String(text).trim().replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) usage(`Could not read ${flag} "${text}" as a date and time.`);
  return date;
}

function generate(length) {
  const bytes = crypto.randomBytes(length);
  let pass = '';
  for (let i = 0; i < length; i++) pass += ALPHABET[bytes[i] & 31];
  return pass;
}

/**
 * The Edge Function upper cases and strips anything that is not a letter
 * or digit before hashing, so that a pass written down as ABCD-EFGH still
 * matches. Hash the same normalised form here.
 */
function normalise(pass) {
  return pass.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Groups of four, so it can be read aloud without losing your place. */
function pretty(pass) {
  return (pass.match(/.{1,4}/g) || [pass]).join('-');
}

function sqlText(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function sqlTimestamp(date) {
  return date === null ? 'null' : sqlText(date.toISOString());
}

function localAndUtc(date) {
  return `${date.toString()}\n                     (${date.toISOString()} UTC)`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.kind !== 'resident' && args.kind !== 'guest') {
    usage('First argument must be "resident" or "guest".');
  }
  if (!args.label || !args.label.trim()) {
    usage('--label is required. It is what shows on the kiosk door panel.');
  }

  const length = parseInt(args.length, 10);
  if (!Number.isInteger(length) || length < 6 || length > 32) {
    usage('--length must be a whole number between 6 and 32.');
  }

  // The one refusal that matters. A guest pass with no end date is a
  // permanent key sitting in a group chat, and group chats outlive
  // parties, flatmates and phones.
  if (args.kind === 'guest' && !args.until) {
    usage(
      'A guest pass must expire. Pass --until "2026-09-13T02:00".\n' +
      '  If you want a key with no end date, that is a resident pass, and it\n' +
      '  should go to one person rather than into a group chat.'
    );
  }

  const from = args.from ? parseWhen(args.from, '--from') : null;
  const until = args.until ? parseWhen(args.until, '--until') : null;

  if (until && until.getTime() <= Date.now()) {
    usage('--until is in the past, so the pass would be dead on arrival.');
  }
  if (from && until && from.getTime() >= until.getTime()) {
    usage('--from is not before --until.');
  }

  let maxUses = null;
  if (args.maxUses !== null) {
    maxUses = parseInt(args.maxUses, 10);
    if (!Number.isInteger(maxUses) || maxUses < 1) usage('--max-uses must be 1 or more.');
  }

  const pass = generate(length);
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(normalise(pass), salt, ITERATIONS, KEY_BYTES, 'sha256');

  const insert = [
    'insert into door_passes',
    '  (label, kind, salt, hash, iterations, valid_from, valid_until, max_uses)',
    'values',
    `  (${sqlText(args.label.trim())}, ${sqlText(args.kind)},`,
    `   ${sqlText(salt.toString('hex'))},`,
    `   ${sqlText(hash.toString('hex'))},`,
    `   ${ITERATIONS}, ${sqlTimestamp(from)}, ${sqlTimestamp(until)}, ${maxUses === null ? 'null' : maxUses});`,
  ].join('\n');

  console.log(`
  ${args.kind === 'guest' ? 'GUEST' : 'RESIDENT'} PASS: ${args.label.trim()}
  ${'='.repeat(58)}

      ${pretty(pass)}

  ${'='.repeat(58)}

  This is the only time it is shown. It is not stored anywhere in
  plaintext and cannot be recovered. Lose it and generate another.

  Dashes and spaces are ignored on entry, so "${pretty(pass)}"
  and "${pass}" both work.

  Starts:   ${from ? localAndUtc(from) : 'immediately'}
  Expires:  ${until ? localAndUtc(until) : 'never'}
  Uses:     ${maxUses === null ? 'unlimited' : maxUses}

  Run this in the Supabase SQL editor:

${insert.split('\n').map((line) => '    ' + line).join('\n')}

  To turn it off later:

    update door_passes set revoked_at = now()
     where label = ${sqlText(args.label.trim())};

  To see what is live right now:

    select * from door_pass_status order by state, label;
`);
}

main();
