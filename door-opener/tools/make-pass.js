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
// The other three ways to do this: tools/make-pass.html, which is this in a
// form and hands you the same SQL; tools/manage.html, which calls door-admin
// from a desktop; and public/passes.html, which does it from a phone. This
// one needs nothing deployed and holds no key, so it is the one that still
// works when the rest is off.

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

// A chosen pass is a different animal from a generated one. It is a word
// somebody picked, so it is short, guessable and memorable by design, and
// none of those can be argued out of it.
//
// What makes it safe is the window. The global limiter allows about 120
// wrong tries an hour across everyone, so a pass that dies at 4am only
// ever faces the tries that fit before then. That turns "is this pass
// strong enough" into one number: the tries the window admits, over the
// combinations the pass has. Refuse above MAX_GUESS_ODDS and both halves
// take care of themselves, because a longer pass simply earns a longer
// window. DIA gets about fourteen hours. A passphrase gets centuries.
const MIN_CHOSEN = 3;
const GUESSES_PER_HOUR = 120;
const MAX_GUESS_ODDS = 0.10;

// A pass with no end time is not guessed in infinite time, it is guessed
// in however long the space takes to grind through, so scoring it against
// an infinite window would refuse every permanent pass however strong.
// Ten years is the horizon a resident key is measured against instead.
const NO_EXPIRY_HOURS = 24 * 365 * 10;

// Tried first, always, whatever the arithmetic below says. A pass on the
// first page of every guesser's list is not protected by the shortness of
// its window: it falls on try one, not on try ten thousand.
const OBVIOUS = ['0000', '1111', '1212', '1234', '12345', '123456', '2222', '2580',
  '4321', '6969', '7777', '9999', 'ABC', 'ABCD', 'ABCDE', 'ASDF', 'DOOR', 'ENTER',
  'HELLO', 'HOME', 'LOVE', 'OPEN', 'PASS', 'PLEASE', 'QWERTY', 'TEST'];

function tooObvious(pass) { return OBVIOUS.indexOf(pass) !== -1; }

// Matches MAX_PASS_LENGTH in the Edge Function. Anything longer is
// rejected there before it is ever hashed, so it could never open a door.
const MAX_CHOSEN = 64;

function usage(message) {
  if (message) console.error('\n  ' + message);
  console.error(`
  Usage:
    node tools/make-pass.js resident --label "<name>" [--length 8]
    node tools/make-pass.js guest    --label "<name>" --until "<when>"
                                     [--from "<when>"] [--max-uses N] [--length 8]

  Choose the pass yourself, for a party people have to remember:
    node tools/make-pass.js guest --label "Sat party" --pass DIA \
         --from "2026-09-12T20:00" --until "2026-09-13T04:00"

  Options:
    --label      What this pass is called. Shows on the kiosk door panel.
    --pass       Use this exact pass instead of a random one. Case and
                 punctuation are ignored, ${MIN_CHOSEN}-${MAX_CHOSEN} characters. A short
                 one needs a short --until: it will tell you how short.
    --from       When it starts working. Defaults to now.
    --until      When it stops working. Required for a guest pass.
    --max-uses   Cap the number of opens. Omit for unlimited.
    --length     Characters in the pass. Default ${DEFAULT_LENGTH}. Not with --pass.

  Times are read in this machine's local timezone. Both
  "2026-09-12T20:00" and "2026-09-12 20:00" work.
`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { kind: argv[0], label: null, pass: null, from: null, until: null, maxUses: null, length: null };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--label':    out.label = value; i++; break;
      case '--pass':     out.pass = value; i++; break;
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

/**
 * What a guesser actually faces, assuming the worst about them: that they
 * know the length, and that a chosen pass means letters rather than the
 * full 36 character keypad -- or, when it is all digits, ten.
 */
function combinations(pass) {
  // Assume the worst about the guesser: that they know the length, and
  // that they can see the shape. All digits is a keypad of ten, not of
  // thirty-six. Four numbers is 10,000 tries, not 1.7 million, and scoring
  // it the generous way would sell a PIN a window it cannot hold.
  if (/^[0-9]+$/.test(pass)) return Math.pow(10, pass.length);
  return Math.pow(/[0-9]/.test(pass) ? 36 : 26, pass.length);
}

function hoursUntil(until) {
  return until ? (until.getTime() - Date.now()) / 3600000 : Infinity;
}

/** Odds the window lets a guesser through. 1 means near certain. */
function guessOdds(pass, until) {
  const hours = Math.min(hoursUntil(until), NO_EXPIRY_HOURS);
  if (hours <= 0) return 0;
  return Math.min(1, (hours * GUESSES_PER_HOUR) / combinations(pass));
}

/** The longest window this pass can carry and stay under the threshold. */
function affordableHours(pass) {
  return (combinations(pass) * MAX_GUESS_ODDS) / GUESSES_PER_HOUR;
}

function describeHours(hours) {
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  if (hours < 24 * 730) return `${Math.round(hours / 24).toLocaleString('en-GB')} days`;
  return `${Math.round(hours / 24 / 365).toLocaleString('en-GB')} years`;
}

function strengthLine(pass, until) {
  const combos = combinations(pass).toLocaleString('en-GB');
  const hours = hoursUntil(until);

  if (!Number.isFinite(hours)) {
    const years = combinations(pass) / GUESSES_PER_HOUR / 24 / 365;
    return `${combos} combinations and no end time, so it stands on its length alone: `
      + `about ${describeHours(combinations(pass) / GUESSES_PER_HOUR)} of sustained guessing `
      + `to exhaust${years > 1000 ? ', which is as permanent as anything here gets' : ''}.`;
  }
  if (hours <= 0) return `${combos} combinations, and a window that has already closed.`;

  const odds = guessOdds(pass, until);
  const tries = Math.round(hours * GUESSES_PER_HOUR).toLocaleString('en-GB');
  const chance = odds >= 1 ? 'near certain'
    : odds < 0.001 ? 'under 0.1%'
    : 'about ' + (odds * 100).toFixed(1) + '%';
  return `${combos} combinations, and the limiter allows about ${tries} tries `
    + `before it expires (${chance}).`;
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

  // Both given means one is being ignored, and quietly ignoring either is
  // how you hand out a pass that is not the one you thought you made.
  if (args.pass !== null && args.length !== null) {
    usage('--pass and --length cannot both be given. A pass you chose is already the length it is.');
  }

  let length = DEFAULT_LENGTH;
  if (args.pass === null) {
    length = parseInt(args.length === null ? DEFAULT_LENGTH : args.length, 10);
    if (!Number.isInteger(length) || length < 6 || length > 32) {
      usage('--length must be a whole number between 6 and 32.');
    }
  }

  let chosen = null;
  if (args.pass !== null) {
    chosen = normalise(args.pass);
    if (chosen.length < MIN_CHOSEN || chosen.length > MAX_CHOSEN) {
      usage(
        `--pass must be ${MIN_CHOSEN} to ${MAX_CHOSEN} characters once case and punctuation are\n` +
        `  stripped. "${args.pass}" comes out as "${chosen}", which is ${chosen.length}.`
      );
    }
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

  // The second refusal that matters, and the reason a three letter pass is
  // allowed at all. Length is not what protects a word somebody picked;
  // the window is. So this does not ask how long the pass is, it asks what
  // the window it was given would let through, which is the question that
  // actually decides whether the pass holds.
  if (chosen && tooObvious(chosen)) {
    usage(`"${chosen}" is one of the first things anyone tries, so no window is short\n` +
      '  enough to make it safe. Pick another.');
  }

  if (chosen && guessOdds(chosen, until) > MAX_GUESS_ODDS) {
    const fits = describeHours(affordableHours(chosen));
    usage(
      `"${chosen}" cannot carry ${until ? 'a window that long' : 'a pass with no end time'}.\n\n` +
      `  ${strengthLine(chosen, until)}\n\n` +
      `  At ${chosen.length} characters it can cover about ${fits} before guessing it\n` +
      `  becomes likelier than ${Math.round(MAX_GUESS_ODDS * 100)}%. Either ${until ? 'shorten' : 'set'} the window with\n` +
      `  --until, or add a character: every one you add multiplies what it can\n` +
      `  carry by ${/^[0-9]+$/.test(chosen) ? 10 : 26}.`
    );
  }

  let maxUses = null;
  if (args.maxUses !== null) {
    maxUses = parseInt(args.maxUses, 10);
    if (!Number.isInteger(maxUses) || maxUses < 1) usage('--max-uses must be 1 or more.');
  }

  const pass = chosen === null ? generate(length) : chosen;
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

  ${chosen === null
    ? `This is the only time it is shown. It is not stored anywhere in
  plaintext and cannot be recovered. Lose it and generate another.`
    : `Only the hash is stored, so nothing here can tell you this pass
  later. You chose it, so write it down where you keep the others.`}

  Dashes and spaces are ignored on entry, so "${pretty(pass)}"
  and "${pass}" both work.

  Starts:   ${from ? localAndUtc(from) : 'immediately'}
  Expires:  ${until ? localAndUtc(until) : 'never'}
  Uses:     ${maxUses === null ? 'unlimited' : maxUses}${chosen === null ? '' : `
  Guessing: ${strengthLine(pass, until)}`}

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
