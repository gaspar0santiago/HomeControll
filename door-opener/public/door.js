'use strict';

// Street door entry page.
//
// The browser collects characters and posts them. It never sees a hash, it
// never sees a pass id, and it decides nothing: every verdict below comes
// back from the Edge Function. Reading this file tells an attacker the
// shape of the API and nothing else.

// Same alphabet as tools/make-pass.js. No 0, O, 1 or I, so there is no
// character on this keypad that can be confused with another.
var ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
var COLUMNS = 6;
var MAX_LENGTH = 64;

// Longest run the readout shows in full. Past this it keeps the tail, so
// the characters you just pressed stay visible.
var READOUT_CHARS = 14;

// A dead network should not leave the spinner turning at a street door.
var REQUEST_TIMEOUT_MS = 15000;

var CONFIG = window.DOOR_CONFIG || {};
var RELEASE_MS = Math.max(2, Number(CONFIG.releaseSeconds) || 6) * 1000;
var FALLBACK = CONFIG.fallbackText || 'Use the intercom instead.';

var el = {
  readout: document.getElementById('readout'),
  readoutText: document.getElementById('readout-text'),
  status: document.getElementById('status'),
  keys: document.getElementById('keys'),
  open: document.getElementById('open'),
  typed: document.getElementById('typed'),
  modeToggle: document.getElementById('mode-toggle'),
  takeover: document.getElementById('takeover'),
  takeoverTitle: document.getElementById('takeover-title'),
  takeoverSub: document.getElementById('takeover-sub'),
  takeoverFill: document.getElementById('takeover-fill')
};

var entry = '';
var busy = false;
var typingMode = false;
var releaseTimer = null;

// ── Copy ──────────────────────────────────────────────────────
// Plain language, and every one of them says what to do next. Nobody
// standing at a door at night wants a status code.
function failureText(data) {
  var reason = data && data.reason;

  if (reason === 'expired') {
    return 'That pass has expired' + since(data.valid_until) + '. Ask for a new one.';
  }
  if (reason === 'not_yet_valid') {
    return 'That pass does not start until ' + when(data.valid_from) + '.';
  }
  if (reason === 'revoked') {
    return 'That pass has been turned off. Ask for a new one.';
  }
  if (reason === 'used_up') {
    return 'That pass has already been used. Ask for a new one.';
  }
  if (reason === 'locked_out') {
    return 'Too many wrong tries. Wait 15 minutes, then try again. ' + FALLBACK;
  }
  if (reason === 'throttled') {
    return 'The door is turning away a lot of wrong tries right now. Wait a few minutes. ' + FALLBACK;
  }
  if (reason === 'network') {
    return 'No connection. Check your signal and try again.';
  }
  if (reason === 'error') {
    return 'Something went wrong at our end. ' + FALLBACK;
  }
  // Everything unmatched reads the same as a pass that does not exist. The
  // page has no way to tell those apart, and neither should anyone else.
  return 'Not recognised. Check the characters and try again.';
}

// Weekday and clock time alone are ambiguous: a pass that ran out last
// Sunday reads exactly like one that ran out this morning. The date is
// worth the extra few characters.
function when(iso) {
  if (!iso) return 'later';
  var date = new Date(iso);
  if (isNaN(date.getTime())) return 'later';
  try {
    return date.toLocaleString([], {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit'
    });
  } catch (e) {
    return date.toString();
  }
}

function since(iso) {
  if (!iso) return '';
  var date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  return ' (it ran out ' + when(iso) + ')';
}

// ── Readout ───────────────────────────────────────────────────
function renderEntry() {
  var shown = entry.length > READOUT_CHARS
    ? '…' + entry.slice(entry.length - (READOUT_CHARS - 1))
    : entry;
  el.readoutText.textContent = shown;
  el.readout.classList.toggle('filled', entry.length > 0);
  el.open.disabled = busy || entry.length === 0;
}

function setEntry(next) {
  entry = next.slice(0, MAX_LENGTH);
  el.readout.classList.remove('error');
  if (el.typed.value !== entry) el.typed.value = entry;
  renderEntry();
}

function append(character) {
  if (busy) return;
  if (entry.length >= MAX_LENGTH) return;
  clearStatus();
  setEntry(entry + character);
  buzz(8);
}

function backspace() {
  if (busy || entry.length === 0) return;
  clearStatus();
  setEntry(entry.slice(0, -1));
  buzz(8);
}

function clearAll() {
  if (busy) return;
  clearStatus();
  setEntry('');
  buzz(14);
}

// ── Status line ───────────────────────────────────────────────
function setStatus(text, tone) {
  el.status.textContent = text;
  el.status.className = 'status' + (tone ? ' ' + tone : '');
}

function clearStatus() {
  el.status.textContent = ' ';
  el.status.className = 'status';
}

function buzz(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (e) { /* not every browser allows it */ }
  }
}

// ── Keypad ────────────────────────────────────────────────────
// Built from ALPHABET rather than written out in the HTML, so the keypad
// and the generator cannot drift apart.
function buildKeypad() {
  var frag = document.createDocumentFragment();

  ALPHABET.split('').forEach(function (character) {
    var key = document.createElement('button');
    key.type = 'button';
    key.className = 'key';
    key.textContent = character;
    key.setAttribute('aria-label', character);
    key.addEventListener('click', function () { append(character); });
    frag.appendChild(key);
  });

  frag.appendChild(wideKey(
    'Delete last character',
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M9 5.4h9.4A2.2 2.2 0 0 1 20.6 7.6v8.8a2.2 2.2 0 0 1-2.2 2.2H9L3.4 12z"/>' +
      '<path d="M11.6 9.6l4.8 4.8M16.4 9.6l-4.8 4.8"/></svg>',
    backspace
  ));

  frag.appendChild(wideKey('Clear everything', 'CLEAR', clearAll));

  el.keys.appendChild(frag);

  // ALPHABET is 32 characters and the two wide keys take two columns each,
  // so the grid fills exactly. If someone changes the alphabet, say so
  // rather than shipping a ragged last row.
  if ((ALPHABET.length + 4) % COLUMNS !== 0) {
    console.warn('Keypad does not fill its grid: ' + ALPHABET.length + ' characters over ' + COLUMNS + ' columns');
  }
}

function wideKey(label, html, action) {
  var key = document.createElement('button');
  key.type = 'button';
  key.className = 'key key-wide';
  key.innerHTML = html;
  key.setAttribute('aria-label', label);
  key.addEventListener('click', action);
  return key;
}

// ── Typing ────────────────────────────────────────────────────
// Passes contain letters, so tapping cannot be the only way in. A hardware
// keyboard works at any time; the toggle swaps the keypad for a real input
// so the phone's own keyboard can be used instead.
function setTypingMode(on) {
  typingMode = on;
  el.keys.hidden = on;
  el.typed.hidden = !on;
  el.modeToggle.setAttribute('aria-pressed', String(on));
  el.modeToggle.textContent = on ? 'Use keypad' : 'Type instead';
  if (on) {
    el.typed.value = entry;
    el.typed.focus();
  } else {
    el.typed.blur();
  }
}

function normalise(raw) {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

// ── Submit ────────────────────────────────────────────────────
function setBusy(on) {
  busy = on;
  el.open.classList.toggle('busy', on);
  el.readout.classList.toggle('busy', on);
  el.open.disabled = on || entry.length === 0;
  el.typed.disabled = on;
}

function submit() {
  if (busy || entry.length === 0) return;

  setBusy(true);
  setStatus('Checking...', 'busy');

  var controller = new AbortController();
  var timeout = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);

  fetch(CONFIG.openUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pass: entry }),
    cache: 'no-store',
    signal: controller.signal
  })
    .then(function (response) {
      return response.json().catch(function () { return { ok: false, reason: 'error' }; });
    })
    .then(function (data) {
      if (data && data.ok) succeed();
      else refuse(data);
    })
    .catch(function () {
      refuse({ reason: 'network' });
    })
    .then(function () {
      clearTimeout(timeout);
    });
}

function succeed() {
  setBusy(false);
  setEntry('');
  clearStatus();
  buzz([40, 70, 140]);

  el.takeover.classList.remove('fail');
  el.takeoverTitle.textContent = 'DOOR OPEN';
  el.takeoverSub.textContent = 'Push the door now';
  el.takeover.hidden = false;

  // Counts the window down rather than sitting there, so nobody is left
  // wondering whether it is still worth pushing.
  el.takeoverFill.style.transition = 'none';
  el.takeoverFill.style.transform = 'scaleX(1)';
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      el.takeoverFill.style.transition = 'transform ' + RELEASE_MS + 'ms linear';
      el.takeoverFill.style.transform = 'scaleX(0)';
    });
  });

  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(function () {
    el.takeover.hidden = true;
    if (typingMode) el.typed.focus();
  }, RELEASE_MS);
}

function refuse(data) {
  setBusy(false);
  setStatus(failureText(data), 'fail');
  buzz([120, 60, 120]);

  // Clear the entry. A wrong pass gives no clue which character was wrong,
  // so leaving it there only invites the same mistake again.
  setEntry('');
  el.readout.classList.add('error');
  if (typingMode) el.typed.focus();
}

// ── Wiring ────────────────────────────────────────────────────
buildKeypad();
renderEntry();
clearStatus();

el.open.addEventListener('click', submit);
el.modeToggle.addEventListener('click', function () { setTypingMode(!typingMode); });

el.typed.addEventListener('input', function () {
  setEntry(normalise(el.typed.value));
  clearStatus();
});

el.typed.addEventListener('keydown', function (event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    submit();
  }
});

// A hardware or Bluetooth keyboard works without switching modes.
document.addEventListener('keydown', function (event) {
  if (typingMode) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === 'Enter') { event.preventDefault(); submit(); return; }
  if (event.key === 'Backspace') { event.preventDefault(); backspace(); return; }
  if (event.key === 'Escape') { event.preventDefault(); clearAll(); return; }

  if (event.key.length === 1) {
    var character = event.key.toUpperCase();
    if (ALPHABET.indexOf(character) !== -1) {
      event.preventDefault();
      append(character);
    }
  }
});

// Coming back to a page left open in a pocket should not resume someone
// else's half typed pass.
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden' && !busy) {
    setEntry('');
    clearStatus();
  }
});

if (!CONFIG.openUrl || CONFIG.openUrl.indexOf('YOUR-PROJECT-REF') !== -1) {
  setStatus('This page is not configured yet. Set openUrl in config.js.', 'fail');
  el.open.disabled = true;
}
