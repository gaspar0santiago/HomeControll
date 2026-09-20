'use strict';

// Pass manager for the people who live here.
//
// Served from the same site as the door page so it works from a phone,
// anywhere, with nothing installed. What keeps it shut is the manager key:
// the page is public, everything it can do is not, and door-admin checks
// the key server side on every single call.
//
// It never learns a pass either. The characters are made here, hashed here,
// and only the salt and the hash are sent. The list that comes back has no
// hash in it and never has had, so a pass can be replaced but never read.
//
// tools/manage.html is the same idea for a desktop, kept because it works
// from a file:// URL with no site deployed at all.

// ── Must match tools/make-pass.js ─────────────────────────────
// CI fails if these drift. A mismatch means every pass made here is
// refused at the door as "Not recognised", with nothing to explain why.
var ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
var ITERATIONS = 120000;
var SALT_BYTES = 16;
var KEY_BITS = 256;
var DEFAULT_LENGTH = 8;

// What makes a chosen pass safe is not its length but the window it is
// given: the door lets through about this many wrong tries an hour across
// everyone, so a pass that dies at 3am only ever faces the tries that fit
// before then.
var GUESSES_PER_HOUR = 120;
var MAX_GUESS_ODDS = 0.10;
var MIN_CHOSEN = 3;
var NO_EXPIRY_HOURS = 24 * 365 * 10;

// Tried first, always, whatever the arithmetic below says. A pass on the
// first page of every guesser's list is not protected by the shortness of
// its window: it falls on try one, not on try ten thousand.
var OBVIOUS = ['0000', '1111', '1212', '1234', '12345', '123456', '2222', '2580',
  '4321', '6969', '7777', '9999', 'ABC', 'ABCD', 'ABCDE', 'ASDF', 'DOOR', 'ENTER',
  'HELLO', 'HOME', 'LOVE', 'OPEN', 'PASS', 'PLEASE', 'QWERTY', 'TEST'];

// The characters the door's keypad has. A pass with anything else in it
// could never be typed at the door.
var KEYPAD = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

var REFRESH_MS = 6000;
var STORE = 'doorPasses';

var el = function (id) { return document.getElementById(id); };
var cfg = (window.DOOR_CONFIG || {});

var conn = { url: '', key: '' };
var state = { span: 'tonight', source: 'random' };
var passes = [];
var made = null;
var one = null;
var timer = null;

// ── small helpers ─────────────────────────────────────────────
function normalise(s) { return s.toUpperCase().replace(/[^0-9A-Z]/g, ''); }
function pretty(p) { return (p.match(/.{1,4}/g) || [p]).join('-'); }
function big(n) { return Math.round(n).toLocaleString('en-GB'); }

function hex(bytes) {
  return Array.prototype.map.call(bytes, function (b) {
    return b.toString(16).padStart(2, '0');
  }).join('');
}

function readable(d) {
  try {
    return d.toLocaleString([], {
      weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'
    });
  } catch (e) { return d.toString(); }
}

function toInputValue(d) {
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function fromInputValue(value) {
  if (!value) return null;
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function show(node, on) { node.hidden = !on; }

// ── how strong is strong enough ───────────────────────────────
function combinations(pass) {
  // Assume the worst about the guesser: that they know the length, and
  // that they can see the shape. All digits is a keypad of ten, not of
  // thirty-six. Four numbers is 10,000 tries, not 1.7 million, and scoring
  // it the generous way would sell a PIN a window it cannot hold.
  if (/^[0-9]+$/.test(pass)) return Math.pow(10, pass.length);
  return Math.pow(/[0-9]/.test(pass) ? 36 : 26, pass.length);
}

function tooObvious(pass) { return OBVIOUS.indexOf(pass) !== -1; }

function hoursUntil(until) { return until ? (until.getTime() - Date.now()) / 3600000 : Infinity; }

function guessOdds(pass, until) {
  var hours = Math.min(hoursUntil(until), NO_EXPIRY_HOURS);
  if (hours <= 0) return 0;
  return Math.min(1, (hours * GUESSES_PER_HOUR) / combinations(pass));
}

/** The longest window this pass can carry before the odds rule refuses. */
function affordableHours(pass) { return (combinations(pass) * MAX_GUESS_ODDS) / GUESSES_PER_HOUR; }

function describeHours(h) {
  if (h < 1) return Math.round(h * 60) + ' minutes';
  if (h < 48) return Math.round(h) + ' hours';
  if (h < 24 * 60) return Math.round(h / 24) + ' days';
  if (h < 24 * 730) return Math.round(h / 24 / 30) + ' months';
  return big(h / 24 / 365) + ' years';
}

/** Identical derivation to make-pass.js, or nothing made here would open. */
async function derive(pass) {
  var salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  var key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(normalise(pass)), 'PBKDF2', false, ['deriveBits']);
  var bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: ITERATIONS }, key, KEY_BITS);
  return { salt: hex(salt), hash: hex(new Uint8Array(bits)) };
}

function generate(n) {
  var bytes = crypto.getRandomValues(new Uint8Array(n));
  var out = '';
  // 256 divides by 32 exactly, so masking to 5 bits is uniform.
  for (var i = 0; i < n; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

// ── talking to door-admin ─────────────────────────────────────
async function api(action, payload) {
  if (!conn.url || !conn.key) throw new Error('No key yet.');

  var res;
  try {
    res = await fetch(conn.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': conn.key },
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    });
  } catch (e) {
    // A bad host, no signal, or the function not deployed all land here:
    // the browser will not say which for a cross origin request.
    throw new Error('Cannot reach the door. Check your signal.');
  }

  var data = null;
  try { data = await res.json(); } catch (e) { /* handled next */ }

  if (res.status === 401) throw new Error('That key was refused. Check you pasted all of it.');
  if (!data) throw new Error('The door answered oddly (HTTP ' + res.status + ').');
  if (!data.ok && data.reason) throw new Error(friendly(data.detail || data.reason));
  return data;
}

/** Postgres and the function speak in codes. People do not. */
function friendly(message) {
  if (/guest.*expire|valid_until/i.test(message)) {
    return 'A guest pass has to have an end time.';
  }
  if (/label_required/.test(message)) return 'Give it a name first.';
  if (/label_too_long/.test(message)) return 'That name is too long.';
  return message;
}

// ── the list ──────────────────────────────────────────────────
var PILL = {
  'live': 'live', 'revoked': 'revoked', 'expired': 'expired',
  'used up': 'usedup', 'not yet valid': 'notyet'
};

var SAID = {
  'live': 'works now', 'revoked': 'turned off', 'expired': 'ran out',
  'used up': 'used up', 'not yet valid': 'starts later'
};

function left(iso) {
  if (!iso) return '';
  var ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms) || ms <= 0) return '';
  var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (h >= 48) return Math.round(h / 24) + ' days left';
  if (h >= 1) return h + 'h ' + m + 'm left';
  return m + ' minutes left';
}

function sub(p) {
  var bits = [];
  if (p.state === 'live' && p.valid_until) bits.push(left(p.valid_until));
  else if (p.state === 'live' && !p.valid_until) bits.push('no end date');
  else if (p.state === 'expired' && p.valid_until) bits.push('ran out ' + readable(new Date(p.valid_until)));
  else if (p.state === 'not yet valid' && p.valid_from) bits.push('from ' + readable(new Date(p.valid_from)));
  else bits.push(SAID[p.state] || p.state);
  bits.push(p.use_count === 1 ? 'used once' : 'used ' + p.use_count + ' times');
  return bits.join(' · ');
}

function render() {
  var list = el('rows');
  list.textContent = '';
  show(el('empty'), passes.length === 0);

  passes.forEach(function (p) {
    var li = document.createElement('li');
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';

    var main = document.createElement('div');
    main.className = 'row-main';

    var label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = p.label;

    var line = document.createElement('div');
    line.className = 'row-sub';
    line.textContent = sub(p);

    var pill = document.createElement('span');
    pill.className = 'pill ' + (PILL[p.state] || '');
    pill.textContent = SAID[p.state] || p.state;

    main.appendChild(label);
    main.appendChild(line);
    row.appendChild(main);
    row.appendChild(pill);
    row.addEventListener('click', function () { openOne(p); });
    li.appendChild(row);
    list.appendChild(li);
  });
}

async function refresh(quiet) {
  try {
    var data = await api('list');
    passes = data.passes || [];
    if (one) {
      var still = passes.filter(function (p) { return p.id === one.id; })[0];
      if (still) { one = still; paintOne(); } else { closeOne(); }
    }
    render();
    el('dot').className = 'dot on';
    el('live-text').textContent = 'live';
    show(el('list-error'), false);
  } catch (e) {
    el('dot').className = 'dot off';
    el('live-text').textContent = 'not updating';
    if (!quiet) {
      el('list-error').textContent = e.message;
      show(el('list-error'), true);
    }
  }
}

function startAuto() {
  stopAuto();
  timer = setInterval(function () { if (!document.hidden) refresh(true); }, REFRESH_MS);
}
function stopAuto() { if (timer) { clearInterval(timer); timer = null; } }

// ── unlocking ─────────────────────────────────────────────────
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(conn)); } catch (e) { /* private window: works, just not remembered */ }
}

function load() {
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { /* as above */ }

  // A key handed over in the link fragment, which browsers never send to a
  // server and Netlify therefore never logs. Taken once and wiped from the
  // address bar, so it does not sit in the tab for the next person.
  var frag = /[#&]k=([^&]+)/.exec(location.hash);
  if (frag) {
    saved.key = decodeURIComponent(frag[1]);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { location.hash = ''; }
  }

  conn.url = saved.url || cfg.adminUrl || '';
  conn.key = saved.key || '';
  el('url').value = conn.url;
  el('key').value = conn.key;
  // Nothing to change if the site already knows its own door.
  show(el('url-wrap'), !cfg.adminUrl || !!saved.url);
}

async function unlock() {
  conn.url = el('url').value.trim() || cfg.adminUrl || '';
  conn.key = el('key').value.trim();
  show(el('gate-error'), false);

  if (!conn.url) {
    el('gate-error').textContent = 'This page has no door set. Open "Another door" and paste the door-admin URL.';
    return show(el('gate-error'), true);
  }
  if (!conn.key) {
    el('gate-error').textContent = 'Paste the manager key first.';
    return show(el('gate-error'), true);
  }

  el('unlock').disabled = true;
  try {
    var data = await api('list');
    passes = data.passes || [];
    save();
    enter();
  } catch (e) {
    el('gate-error').textContent = e.message;
    show(el('gate-error'), true);
  }
  el('unlock').disabled = false;
}

function enter() {
  show(el('gate'), false);
  show(el('app'), true);
  show(el('lock'), true);
  render();
  el('dot').className = 'dot on';
  el('live-text').textContent = 'live';
  startAuto();
}

function lock() {
  try { localStorage.removeItem(STORE); } catch (e) { /* nothing to do */ }
  stopAuto();
  conn.key = '';
  passes = [];
  made = null;
  one = null;
  el('key').value = '';
  closeOne();
  show(el('sheet-new'), false);
  show(el('sheet-made'), false);
  show(el('app'), false);
  show(el('lock'), false);
  show(el('gate'), true);
}

// ── how long ──────────────────────────────────────────────────
/** Returns {from, until} for a preset, both possibly null. */
function span(which) {
  var now = new Date(), until = new Date(now), from = null;

  if (which === 'forever') return { from: null, until: null };

  if (which === 'tonight') {
    // The end of the night, not the end of the day: a party at 1am is
    // still tonight, and a pass that dies at midnight is no use at all.
    until.setDate(until.getDate() + (now.getHours() < 3 ? 0 : 1));
    until.setHours(3, 0, 0, 0);
  } else if (which === 'day') {
    until.setDate(until.getDate() + 1);
  } else if (which === 'weekend') {
    // Friday evening to Monday morning. Asked for on the Saturday it means
    // the weekend already happening, not the next one, so the start drops
    // away once the weekend has begun.
    var day = now.getDay();
    if (day !== 0 && day !== 6) {
      from = new Date(now);
      from.setDate(from.getDate() + ((5 - day) + 7) % 7);
      from.setHours(18, 0, 0, 0);
      if (from.getTime() <= now.getTime()) from = null;
    }
    var anchor = from || now;
    until = new Date(anchor);
    until.setDate(until.getDate() + (((8 - until.getDay()) % 7) || 7));
    until.setHours(6, 0, 0, 0);
  } else if (which === 'week') {
    until.setDate(until.getDate() + 7);
  } else if (which === 'month') {
    until.setMonth(until.getMonth() + 1);
  }
  return { from: from, until: until };
}

/** What the form is actually asking for, presets and overrides together. */
function wanted() {
  var picked = span(state.span);
  var from = fromInputValue(el('from').value) || picked.from;
  var until = fromInputValue(el('until').value) || picked.until;
  return { from: from, until: until };
}

function chosen() {
  return state.source === 'random' ? '' : normalise(el('custom').value);
}

function paintSpan() {
  var w = wanted();
  el('span-hint').textContent = w.until
    ? 'Stops working ' + readable(w.until) + (w.from ? ', starts ' + readable(w.from) : '')
    : 'Never stops working. For someone who lives here.';
}

function paintWord() {
  var p = chosen();
  show(el('word-hint'), state.source !== 'random' && p.length > 0);
  if (state.source === 'random' || !p.length) return;

  var bad = [];
  for (var i = 0; i < p.length; i++) {
    if (KEYPAD.indexOf(p[i]) === -1 && bad.indexOf(p[i]) === -1) bad.push(p[i]);
  }

  var hint = el('word-hint');
  if (bad.length) {
    hint.className = 'hint fail';
    hint.textContent = 'The door keypad has no ' + bad.join(', ') + '.';
    return;
  }

  if (tooObvious(p)) {
    hint.className = 'hint fail';
    hint.textContent = '"' + p + '" is one of the first things anyone tries. Pick another.';
    return;
  }

  var covers = describeHours(affordableHours(p));
  var w = wanted();
  var odds = guessOdds(p, w.until);
  var shape = /^[0-9]+$/.test(p) ? p.length + ' numbers' : p.length + ' letters';

  if (odds > MAX_GUESS_ODDS) {
    hint.className = 'hint fail';
    hint.textContent = shape + ' can cover about ' + covers + ', which is less than you asked for. '
      + 'Shorten the time, or add a character.';
  } else {
    hint.className = 'hint';
    hint.textContent = big(combinations(p)) + ' possible, so ' + shape
      + ' can safely cover about ' + covers + '.';
  }
}

// ── making one ────────────────────────────────────────────────
function problems() {
  var out = [];
  var w = wanted();
  var p = chosen();

  if (!el('label').value.trim()) out.push('Say who it is for.');

  if (state.source !== 'random') {
    if (p.length < MIN_CHOSEN) out.push('Type at least ' + MIN_CHOSEN + ' characters.');
    for (var i = 0; i < p.length; i++) {
      if (KEYPAD.indexOf(p[i]) === -1) { out.push('The door keypad has no ' + p[i] + '.'); break; }
    }
    if (tooObvious(p)) out.push('"' + p + '" is one of the first things anyone tries.');
    if (p.length >= MIN_CHOSEN && !tooObvious(p) && guessOdds(p, w.until) > MAX_GUESS_ODDS) {
      out.push('"' + p + '" can only cover about ' + describeHours(affordableHours(p))
        + '. Shorten the time, or add a character.');
    }
  }

  if (w.until && w.until.getTime() <= Date.now()) out.push('That end time has already gone past.');
  if (w.from && w.until && w.from.getTime() >= w.until.getTime()) out.push('It would end before it starts.');
  return out;
}

function validate() {
  var p = problems();
  el('new-problem').textContent = p.join(' ');
  show(el('new-problem'), p.length > 0);
  el('create').disabled = p.length > 0;
}

async function create() {
  var w = wanted();
  var pass = state.source === 'random' ? generate(DEFAULT_LENGTH) : chosen();

  el('create').disabled = true;
  el('create').textContent = 'Making it…';
  try {
    var d = await derive(pass);
    await api('create', {
      label: el('label').value.trim(),
      // A pass with no end is a resident pass by definition: the database
      // refuses a guest one without an end time, and rightly.
      kind: (!w.until || el('lives-here').checked) ? 'resident' : 'guest',
      salt: d.salt,
      hash: d.hash,
      valid_from: w.from ? w.from.toISOString() : null,
      valid_until: w.until ? w.until.toISOString() : null,
      max_uses: el('once').checked ? 1 : null
    });

    made = { pass: pass, until: w.until };
    show(el('sheet-new'), false);
    el('made-pass').textContent = pretty(pass);
    el('made-when').textContent = w.until
      ? 'Works until ' + readable(w.until) : 'No end date.';
    show(el('said'), false);
    show(el('sheet-made'), true);
    resetNew();
    await refresh();
  } catch (e) {
    el('new-problem').textContent = e.message;
    show(el('new-problem'), true);
  }
  el('create').textContent = 'Create pass';
  validate();
}

/** Back to the state the sheet opens in. Called when it opens, not only
    after a pass is made: a half filled form left over from a sheet that
    was closed is how you hand somebody last week's window. */
function resetNew() {
  el('label').value = '';
  el('custom').value = '';
  el('from').value = '';
  el('until').value = '';
  el('once').checked = false;
  el('lives-here').checked = false;

  state.span = 'tonight';
  state.source = 'random';
  press('how-long', 'span', 'tonight');
  press('source', 'source', 'random');
  show(el('custom'), false);
  show(el('word-hint'), false);
  show(el('new-problem'), false);
}

/** Marks one button in a group as the chosen one. */
function press(group, name, value) {
  Array.prototype.forEach.call(el(group).querySelectorAll('button'), function (b) {
    b.setAttribute('aria-pressed', String(b.dataset[name] === value));
  });
}

/** The whole point of a phone: hand it straight to whoever needs it. */
function shareText() {
  if (!made) return '';
  var lines = ['Street door pass: ' + pretty(made.pass)];
  lines.push('Open the door here: ' + new URL('.', location.href).href);
  lines.push(made.until ? 'Works until ' + readable(made.until) + '.' : 'No end date.');
  return lines.join('\n');
}

// ── one pass ──────────────────────────────────────────────────
function openOne(p) {
  one = p;
  paintOne();
  show(el('one-note'), false);
  show(el('sheet-one'), true);
}

function closeOne() {
  one = null;
  show(el('sheet-one'), false);
}

function fact(dl, name, value) {
  var div = document.createElement('div');
  var dt = document.createElement('dt');
  var dd = document.createElement('dd');
  dt.textContent = name;
  dd.textContent = value;
  div.appendChild(dt);
  div.appendChild(dd);
  dl.appendChild(div);
}

function paintOne() {
  if (!one) return;
  el('one-title').textContent = one.label;

  var dl = el('one-facts');
  dl.textContent = '';
  fact(dl, 'State', SAID[one.state] || one.state);
  fact(dl, 'Kind', one.kind === 'guest' ? 'guest' : 'lives here');
  fact(dl, 'Starts', one.valid_from ? readable(new Date(one.valid_from)) : 'straight away');
  fact(dl, 'Ends', one.valid_until ? readable(new Date(one.valid_until)) : 'never');
  fact(dl, 'Opened the door', one.use_count + (one.max_uses ? ' of ' + one.max_uses : '') + '×');

  show(el('one-off'), one.state !== 'revoked');
  show(el('one-on'), one.state === 'revoked');
}

function note(message, kind) {
  el('one-note').textContent = message;
  el('one-note').className = 'note ' + (kind || '');
  show(el('one-note'), !!message);
}

async function act(action, payload, said) {
  var target = one;
  if (!target) return;
  try {
    await api(action, Object.assign({ id: target.id }, payload || {}));
    note(said, 'ok');
    await refresh();
  } catch (e) {
    note(e.message, 'fail');
  }
}

// ── wiring ────────────────────────────────────────────────────
el('unlock').addEventListener('click', unlock);
el('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
el('lock').addEventListener('click', lock);

el('new').addEventListener('click', function () {
  resetNew();
  paintSpan();
  paintWord();
  validate();
  show(el('sheet-new'), true);
  el('label').focus();
});

el('new-close').addEventListener('click', function () { show(el('sheet-new'), false); });
el('made-close').addEventListener('click', function () { show(el('sheet-made'), false); });
el('one-close').addEventListener('click', closeOne);

// A tap on the dimmed area behind a sheet closes it, the way every other
// sheet on a phone does.
['sheet-new', 'sheet-made', 'sheet-one'].forEach(function (id) {
  el(id).addEventListener('click', function (e) {
    if (e.target === el(id)) show(el(id), false);
  });
});

el('how-long').addEventListener('click', function (e) {
  var b = e.target.closest('button');
  if (!b) return;
  state.span = b.dataset.span;
  press('how-long', 'span', state.span);
  // A preset and a typed end time would fight. The preset wins, because it
  // is the one just tapped.
  el('from').value = '';
  el('until').value = '';
  paintSpan();
  paintWord();
  validate();
});

el('source').addEventListener('click', function (e) {
  var b = e.target.closest('button');
  if (!b) return;
  state.source = b.dataset.source;
  press('source', 'source', state.source);

  var custom = el('custom');
  show(custom, state.source !== 'random');
  if (state.source === 'digits') {
    custom.inputMode = 'numeric';
    custom.placeholder = '4729';
  } else {
    custom.inputMode = 'text';
    custom.placeholder = 'DIA';
  }
  if (state.source !== 'random') custom.focus();
  paintWord();
  validate();
});

el('custom').addEventListener('input', function () { paintWord(); validate(); });
el('label').addEventListener('input', validate);
el('once').addEventListener('change', validate);
el('lives-here').addEventListener('change', validate);

['from', 'until'].forEach(function (id) {
  el(id).addEventListener('input', function () { paintSpan(); paintWord(); validate(); });
});

el('create').addEventListener('click', create);

el('copy').addEventListener('click', function () {
  if (!made) return;
  navigator.clipboard.writeText(made.pass).then(function () {
    show(el('said'), true);
    setTimeout(function () { show(el('said'), false); }, 1600);
  }, function () { /* a browser that refuses the clipboard: the pass is on screen anyway */ });
});

el('share').addEventListener('click', function () {
  var text = shareText();
  if (navigator.share) {
    navigator.share({ text: text }).catch(function () { /* they backed out */ });
  } else {
    navigator.clipboard.writeText(text).then(function () {
      show(el('said'), true);
      setTimeout(function () { show(el('said'), false); }, 1600);
    }, function () { /* as above */ });
  }
});

el('one-off').addEventListener('click', function () {
  act('revoke', { off: true }, 'Turned off. Nothing was deleted, so you can turn it back on.');
});

el('one-on').addEventListener('click', function () {
  act('revoke', { off: false }, 'Back on. If its time has already run out it stays run out.');
});

el('one-extend').addEventListener('click', function (e) {
  var b = e.target.closest('button');
  if (!b || !one) return;
  var which = b.dataset.extend;

  if (which === 'forever') {
    return act('window', { valid_from: one.valid_from, valid_until: null }, 'No end date now.');
  }

  // Extend from whichever is later: now, or the end it already has. Adding
  // a week to an end that passed on Tuesday would put it in the past.
  var base = new Date(Math.max(Date.now(), one.valid_until ? new Date(one.valid_until).getTime() : 0));
  if (which === 'day') base.setDate(base.getDate() + 1);
  else if (which === 'week') base.setDate(base.getDate() + 7);
  else base.setMonth(base.getMonth() + 1);

  act('window', { valid_from: one.valid_from, valid_until: base.toISOString() },
    'Now works until ' + readable(base) + '.');
});

el('one-del').addEventListener('click', async function () {
  if (!one) return;
  if (!confirm('Delete "' + one.label + '" for good?\n\nTurning it off does the same job and can be undone.')) return;
  await act('delete', {}, 'Deleted.');
  closeOne();
});

document.addEventListener('visibilitychange', function () {
  if (!document.hidden && conn.key && !el('app').hidden) refresh(true);
});

// ── start ─────────────────────────────────────────────────────
load();
paintSpan();
validate();
if (conn.url && conn.key) unlock();
