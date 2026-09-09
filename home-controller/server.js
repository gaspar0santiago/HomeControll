require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── SCREEN CONTROL ────────────────────────────────────────────
let screenIsOff = false;
let screenAction = null;
let screenActionTimestamp = 0;

function runPs1(script) {
  spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, script)], { windowsHide: true });
}

function turnOffScreens() {
  screenIsOff = true; screenAction = 'off'; screenActionTimestamp = Date.now();
  runPs1('screen-off.ps1'); console.log('Screens off');
}

function wakeScreens() {
  if (!screenIsOff) return;
  screenIsOff = false; screenAction = 'wake'; screenActionTimestamp = Date.now();
  runPs1('screen-on.ps1'); console.log('Screens waking from motion');
}

app.post('/screen/off',  (req, res) => { turnOffScreens(); res.sendStatus(200); });
app.post('/screen/wake', (req, res) => { wakeScreens(); res.sendStatus(200); });
app.get('/screen/state', (req, res) => res.json({ action: screenAction, timestamp: screenActionTimestamp }));

// ── MOTION DETECTION ──────────────────────────────────────────
let prevFrameSum = 0;
const MOTION_THRESHOLD = 0.02;

// Every light command bumps this. The detector compares whole-frame
// brightness, so our own light changes look exactly like motion -- ignore
// frames for a moment after we touch anything, and while the party cycle
// is running, or the screens would wake themselves every time a bulb moves.
const MOTION_LIGHT_COOLDOWN_MS = 5000;
let lastLightCommandAt = 0;

function noteLightCommand() {
  lastLightCommandAt = Date.now();
}

function motionSuppressed() {
  if (partyInterval) return true;
  return Date.now() - lastLightCommandAt < MOTION_LIGHT_COOLDOWN_MS;
}

function detectMotion(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 20) sum += frame[i];
  if (motionSuppressed()) { prevFrameSum = sum; return; }
  if (prevFrameSum > 0 && screenIsOff) {
    const diff = Math.abs(sum - prevFrameSum) / Math.max(prevFrameSum, 1);
    if (diff > MOTION_THRESHOLD) wakeScreens();
  }
  prevFrameSum = sum;
}

// ── LIGHT STATE ───────────────────────────────────────────────
const lightState = {
  globalScene: null,
  globalBrightness: 80,
  zones: {
    'Living Room':      { on: false, mode: null, brightness: 80 },
    'Living Room Plus': { on: false, mode: null, brightness: 80 },
    'Balcony':          { on: false, mode: null, brightness: 80 },
    'Bar':              { on: false, mode: null, brightness: 80 }
  },
  plugs: { disco: false, spotlight: false, spotlight2: false }
};

app.get('/lights/state', (req, res) => res.json(lightState));

app.post('/lights/state', (req, res) => {
  const { zone, on, mode, brightness, globalScene, globalBrightness } = req.body;
  if (globalScene !== undefined)      lightState.globalScene = globalScene;
  if (globalBrightness !== undefined) lightState.globalBrightness = globalBrightness;
  if (zone && lightState.zones[zone]) {
    if (on !== undefined)         lightState.zones[zone].on = on;
    if (mode !== undefined)       lightState.zones[zone].mode = mode;
    if (brightness !== undefined) lightState.zones[zone].brightness = brightness;
  }
  checkPartyCycle();
  res.sendStatus(200);
});

// ── PARTY COLOR CYCLING ───────────────────────────────────────
const PARTY_ZONES = {
  'Living Room':      ['192.168.68.61','192.168.68.68','192.168.68.63','192.168.68.71','192.168.68.53','192.168.68.69'],
  'Living Room Plus': ['192.168.68.75','192.168.68.78'],
  'Balcony':          ['192.168.68.50','192.168.68.51','192.168.68.52']
};

const currentHues = {}, targetHues = {};
let partyStep = 0, partyInterval = null;
const PARTY_STEPS = 10, PARTY_STEP_MS = 30000;

function getSpreadHues(count) {
  const baseHue = Math.floor(Math.random() * 360);
  const hues = [];
  for (let i = 0; i < count; i++) {
    const variation = (Math.random() - 0.5) * 15;
    hues.push(Math.round(((baseHue + i * (360 / count) + variation) + 360) % 360));
  }
  return hues.sort(() => Math.random() - 0.5);
}

function initPartyHues() {
  const allIps = Object.values(PARTY_ZONES).flat();
  const hues = getSpreadHues(allIps.length);
  allIps.forEach((ip, i) => { currentHues[ip] = Math.floor(Math.random() * 360); targetHues[ip] = hues[i]; });
  partyStep = 0;
}

function partyTick() {
  partyStep++;
  const t = partyStep / PARTY_STEPS;
  Object.entries(PARTY_ZONES).forEach(([zone, ips]) => {
    if (lightState.zones[zone]?.mode !== 'party' || !lightState.zones[zone]?.on) return;
    ips.forEach(ip => {
      let diff = targetHues[ip] - currentHues[ip];
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      const hue = Math.round(((currentHues[ip] + diff * t) + 360) % 360);
      controlTapo(ip, { hue, saturation: 90, brightness: lightState.zones[zone].brightness }).catch(() => {});
    });
  });
  if (partyStep >= PARTY_STEPS) {
    const allIps = Object.values(PARTY_ZONES).flat();
    const newHues = getSpreadHues(allIps.length);
    allIps.forEach((ip, i) => { currentHues[ip] = targetHues[ip]; targetHues[ip] = newHues[i]; });
    partyStep = 0;
  }
}

function startPartyCycle() {
  if (partyInterval) return;
  initPartyHues();
  partyInterval = setInterval(partyTick, PARTY_STEP_MS);
  console.log('Party color cycle started');
}

function stopPartyCycle() {
  if (partyInterval) { clearInterval(partyInterval); partyInterval = null; }
  console.log('Party color cycle stopped');
}

function checkPartyCycle() {
  const anyParty = Object.keys(PARTY_ZONES).some(z =>
    lightState.zones[z]?.mode === 'party' && lightState.zones[z]?.on === true
  );
  if (anyParty && !partyInterval) startPartyCycle();
  if (!anyParty && partyInterval)  stopPartyCycle();
}

// ── TAPO ──────────────────────────────────────────────────────
function controlTapo(ip, payload) {
  // A read changes nothing, so it must not arm the motion cooldown or the
  // door opener's flash would blind the detector every time it looks.
  if (payload.action !== 'read') noteLightCommand();
  return new Promise((resolve, reject) => {
    const args = JSON.stringify({ email: process.env.TAPO_EMAIL, password: process.env.TAPO_PASSWORD, ip, ...payload });
    const proc = spawn('python', [path.join(__dirname, 'tapo_helper.py'), args], { cwd: __dirname, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('Python stderr: ' + err + ' | stdout: ' + out));
      try { const r = JSON.parse(out); if (r.error) return reject(new Error(r.error)); resolve(r); }
      catch(e) { reject(new Error('Bad response: ' + out)); }
    });
  });
}

app.post('/tapo/control', async (req, res) => {
  const { ip, on, brightness, color_temp, hue, saturation, effect } = req.body;
  try {
    const payload = {};
    if (on !== undefined)         payload.on = on;
    if (brightness !== undefined) payload.brightness = brightness;
    if (color_temp !== undefined) payload.color_temp = color_temp;
    if (hue !== undefined)        payload.hue = hue;
    if (saturation !== undefined) payload.saturation = saturation;
    if (effect !== undefined)     payload.effect = effect;
    await controlTapo(ip, payload);
    res.sendStatus(200);
  } catch (e) {
    console.error('Tapo error for', ip, ':', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── FAIRY LIGHTS ──────────────────────────────────────────────
function controlFairy(mac, payload) {
  noteLightCommand();
  return new Promise((resolve, reject) => {
    const args = JSON.stringify({ mac, ...payload });
    const proc = spawn('python', [path.join(__dirname, 'fairy_helper.py'), args], { cwd: __dirname, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err || out));
      try { const r = JSON.parse(out); if (r.error) return reject(new Error(r.error)); resolve(r); }
      catch(e) { reject(new Error('Bad response: ' + out)); }
    });
  });
}

app.post('/fairy/control', async (req, res) => {
  const { mac, on, hue, saturation, brightness, white, music, sensitivity, effect, speed } = req.body;
  try {
    const payload = {};
    if (on !== undefined)          payload.on = on;
    if (hue !== undefined)         payload.hue = hue;
    if (saturation !== undefined)  payload.saturation = saturation;
    if (brightness !== undefined)  payload.brightness = brightness;
    if (white !== undefined)       payload.white = white;
    if (music !== undefined)       payload.music = music;
    if (sensitivity !== undefined) payload.sensitivity = sensitivity;
    if (effect !== undefined)      payload.effect = effect;
    if (speed !== undefined)       payload.speed = speed;
    await controlFairy(mac, payload);
    res.sendStatus(200);
  } catch(e) {
    console.error('Fairy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CAMERAS ──────────────────────────────────────
// A camera with no IP in .env is not started and not advertised to the
// frontend, so an unplugged camera costs nothing and comes back by filling
// its variable in again.
const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const CAMERA_RETRY_MIN_MS = 5000;
const CAMERA_RETRY_MAX_MS = 60000;

// Which camera drives the motion-wake detector. Defaults to the first
// configured one, so it follows along if camera 1 is out.
const MOTION_CAMERA_ID = parseInt(process.env.MOTION_CAMERA || '', 10);

function createCamera({ id, ip, path: streamPath }) {
  const cam = {
    id, ip, path: streamPath,
    proc: null, latestFrame: null, clients: new Set(),
    retryMs: CAMERA_RETRY_MIN_MS, driveMotion: false
  };

  cam.start = function start() {
    if (cam.proc) return;
    const url = `rtsp://${process.env.CAMERA_USERNAME}:${process.env.CAMERA_PASSWORD}@${ip}:554/stream1`;
    cam.proc = spawn(FFMPEG, [
      '-fflags', 'nobuffer', '-flags', 'low_delay',
      '-rtsp_transport', 'tcp', '-i', url,
      '-vf', 'scale=1280:720', '-f', 'mjpeg', '-q:v', '3', '-r', '25', '-'
    ], { windowsHide: true });

    let buf = Buffer.alloc(0);
    cam.proc.stdout.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        let start = -1, end = -1;
        for (let i = 0; i < buf.length - 1; i++) {
          if (buf[i] === 0xFF && buf[i + 1] === 0xD8) start = i;
          if (start >= 0 && buf[i] === 0xFF && buf[i + 1] === 0xD9) { end = i + 2; break; }
        }
        if (start >= 0 && end > start) {
          cam.latestFrame = buf.slice(start, end);
          buf = buf.slice(end);
          cam.retryMs = CAMERA_RETRY_MIN_MS;   // a real frame means it is healthy again
          if (cam.driveMotion) detectMotion(cam.latestFrame);
          cam.clients.forEach(res => {
            try {
              res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${cam.latestFrame.length}\r\n\r\n`);
              res.write(cam.latestFrame); res.write('\r\n');
            } catch (e) { cam.clients.delete(res); }
          });
        } else break;
      }
    });

    cam.proc.stderr.on('data', () => {});
    cam.proc.on('error', () => {});
    cam.proc.on('close', () => {
      cam.proc = null;
      const wait = cam.retryMs;
      // Back off instead of hammering a camera that is unplugged or dead.
      cam.retryMs = Math.min(cam.retryMs * 2, CAMERA_RETRY_MAX_MS);
      console.log(`Camera ${id} stream ended, retrying in ${wait / 1000}s`);
      setTimeout(cam.start, wait);
    });
  };

  return cam;
}

const cameras = [
  { id: 1, ip: process.env.CAMERA_IP,  path: '/camera/stream'  },
  { id: 2, ip: process.env.CAMERA2_IP, path: '/camera2/stream' }
].filter(c => c.ip && c.ip.trim()).map(createCamera);

// Pick the motion camera: the one named in .env if it is configured,
// otherwise whichever camera we do have.
const motionCam = cameras.find(c => c.id === MOTION_CAMERA_ID) || cameras[0];
if (motionCam) motionCam.driveMotion = true;

// Tells the kiosk pages which camera tiles to render.
app.get('/cameras', (req, res) =>
  res.json(cameras.map(c => ({ id: c.id, path: c.path, motion: c.driveMotion })))
);

cameras.forEach(cam => {
  app.get(cam.path, (req, res) => {
    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    cam.clients.add(res);
    if (cam.latestFrame) {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${cam.latestFrame.length}\r\n\r\n`);
      res.write(cam.latestFrame); res.write('\r\n');
    }
    req.on('close', () => cam.clients.delete(res));
  });
});

// ── PAGES ─────────────────────────────────────────────────────
app.get('/lights', (req, res) => res.sendFile(path.join(__dirname, 'public', 'lights.html')));

// ── START ─────────────────────────────────────────────────────
if (cameras.length === 0) console.log('No cameras configured (set CAMERA_IP / CAMERA2_IP in .env)');
cameras.forEach(cam => {
  console.log(`Camera ${cam.id} at ${cam.ip}${cam.driveMotion ? ' (drives motion wake)' : ''}`);
  cam.start();
});

// ── DISCO PLUG ────────────────────────────────────────────────
function controlPlug(payload) {
  noteLightCommand();
  return new Promise((resolve, reject) => {
    const args = JSON.stringify(payload);
    const proc = spawn('python', [path.join(__dirname, 'plug_helper.py'), args], { cwd: __dirname, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(err || out));
      try { const r = JSON.parse(out); resolve(r); }
      catch(e) { reject(new Error('Bad response: ' + out)); }
    });
  });
}

app.post('/plug/control', async (req, res) => {
  const { device, on } = req.body;
  try {
    await controlPlug({ device: device || 'disco', on });
    if (on !== undefined) lightState.plugs[device || 'disco'] = on;
    res.sendStatus(200);
  } catch(e) {
    console.error('Plug error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DOOR OPENER (READ ONLY) ──────────────────────────────────
// Mirrors the street door's attempt log onto the kiosk and flashes a bulb
// when it opens.
//
// Read only, deliberately. This server does not claim door commands and
// must never learn how: the ESP32 claims them, and a second claimer would
// win roughly half the races and silently swallow those presses. The key
// below only reaches door-events, which cannot claim anything.
//
// The door does not depend on any of this. Turn the server off, redeploy
// it, unplug it, and the page and the ESP32 carry on without it.
const DOOR_EVENTS_URL    = (process.env.DOOR_EVENTS_URL || '').trim();
const DOOR_DASHBOARD_KEY = (process.env.DOOR_DASHBOARD_KEY || '').trim();
// 60s, not the kiosks' 3s. The kiosk still polls this server every 3
// seconds; that is local and free. What costs money is this server polling
// Supabase, and at 3s that was 864,000 Edge Function invocations a month
// against a free tier of 500,000. At 60s it is 43,200.
//
// The log being up to a minute stale is fine. The bulb flash is what needs
// to be prompt, and that no longer waits on this poll: the ESP32 posts to
// /door/opened over the LAN the moment it pulses the relay.
const DOOR_POLL_MS       = parseInt(process.env.DOOR_POLL_MS || '60000', 10);
const DOOR_EVENT_LIMIT   = 10;
const DOOR_FETCH_TIMEOUT_MS = 8000;

const DOOR_FLASH_IP         = (process.env.DOOR_FLASH_IP || '').trim();
const DOOR_FLASH_HUE        = parseInt(process.env.DOOR_FLASH_HUE || '120', 10);
const DOOR_FLASH_SATURATION = parseInt(process.env.DOOR_FLASH_SATURATION || '90', 10);
const DOOR_FLASH_BRIGHTNESS = parseInt(process.env.DOOR_FLASH_BRIGHTNESS || '100', 10);
const DOOR_FLASH_MS         = parseInt(process.env.DOOR_FLASH_MS || '2500', 10);

// Ten seconds. Two people arriving together are one arrival, and a bulb
// that strobes on every press is worse than no bulb.
const DOOR_FLASH_DEBOUNCE_MS = 10000;

// Empty means never quiet. Both are HH:MM and the window may cross
// midnight, which is the interesting case.
const DOOR_QUIET_FROM = (process.env.DOOR_QUIET_FROM || '').trim();
const DOOR_QUIET_TO   = (process.env.DOOR_QUIET_TO   || '').trim();

let doorEvents = [];
let doorLastEventId = 0;
let doorPrimed = false;
let doorLastFlashAt = 0;
let doorFlashBusy = false;
let doorError = null;

const doorConfigured = Boolean(DOOR_EVENTS_URL && DOOR_DASHBOARD_KEY);

function hhmmToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const hours = parseInt(m[1], 10), minutes = parseInt(m[2], 10);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function inQuietHours(now = new Date()) {
  const from = hhmmToMinutes(DOOR_QUIET_FROM);
  const to   = hhmmToMinutes(DOOR_QUIET_TO);
  if (from === null || to === null) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  // 23:00 to 07:00 wraps past midnight, so the two halves are an OR.
  return from <= to ? (mins >= from && mins < to) : (mins >= from || mins < to);
}

// Rebuilds the payload that puts the bulb back exactly where it was.
// color_temp is 0 while a Tapo bulb is in colour mode, which is how the
// two modes are told apart.
function restoreTapo(ip, state) {
  const payload = {};
  if (state.color_temp > 0) {
    payload.color_temp = state.color_temp;
  } else if (state.hue !== null && state.saturation !== null) {
    payload.hue = state.hue;
    payload.saturation = state.saturation;
  }
  if (state.brightness !== null) payload.brightness = state.brightness;
  // Every setter in tapo_helper.py switches the bulb on first, so off is
  // restored by asking for it last, which the helper already does when
  // `on` is false. Without this, arriving at 1am leaves the lounge lit
  // until morning.
  payload.on = state.device_on === true;
  return controlTapo(ip, payload);
}

async function flashDoorBulb() {
  if (!DOOR_FLASH_IP || doorFlashBusy) return;
  if (Date.now() - doorLastFlashAt < DOOR_FLASH_DEBOUNCE_MS) return;
  if (inQuietHours()) {
    console.log('Door opened, flash skipped (quiet hours)');
    return;
  }

  doorFlashBusy = true;
  doorLastFlashAt = Date.now();
  let before = null;

  try {
    const read = await controlTapo(DOOR_FLASH_IP, { action: 'read' });
    before = read.state;
    await controlTapo(DOOR_FLASH_IP, {
      hue: DOOR_FLASH_HUE,
      saturation: DOOR_FLASH_SATURATION,
      brightness: DOOR_FLASH_BRIGHTNESS,
      on: true
    });
    await new Promise(resolve => setTimeout(resolve, DOOR_FLASH_MS));
  } catch (e) {
    console.error('Door flash failed:', e.message);
  }

  // Restore runs even when the flash half failed, or the bulb sits on the
  // flash colour until somebody notices.
  try {
    if (before) await restoreTapo(DOOR_FLASH_IP, before);
  } catch (e) {
    console.error('Door flash restore failed:', e.message);
  }

  doorFlashBusy = false;
}

async function fetchDoorEvents() {
  const res = await fetch(`${DOOR_EVENTS_URL}?limit=${DOOR_EVENT_LIMIT}`, {
    headers: { 'x-dashboard-key': DOOR_DASHBOARD_KEY },
    signal: AbortSignal.timeout(DOOR_FETCH_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return Array.isArray(data.events) ? data.events : [];
}

async function doorTick() {
  try {
    const events = await fetchDoorEvents();
    doorError = null;
    doorEvents = events;

    const newestId = events.reduce((max, e) => Math.max(max, e.id || 0), 0);

    // The first fetch records where we are and triggers nothing. Without
    // it a restart replays the last ten events and flashes the lounge for
    // an open that happened hours ago, at whatever hour the server came
    // back up.
    if (!doorPrimed) {
      doorPrimed = true;
      doorLastEventId = newestId;
      console.log(`Door panel primed at event ${newestId} (${events.length} shown)`);
      return;
    }

    const fresh = events.filter(e => e.id > doorLastEventId);
    doorLastEventId = Math.max(doorLastEventId, newestId);

    // Normally the ESP32's /door/opened notify has already flashed and
    // armed the debounce, so this does nothing. It is the fallback for an
    // open the notify missed, which is the whole reason it still runs.
    if (fresh.some(e => e.outcome === 'opened')) {
      // Not awaited: a slow or unreachable bulb must not hold up the next
      // poll, and every failure inside is already swallowed.
      flashDoorBulb();
    }
  } catch (e) {
    // Kept, not thrown. The panel shows the door as unreachable and the
    // next tick tries again; nothing else on the kiosk is affected.
    doorError = e.message;
  }
}

// The ESP32 posts here over the LAN right after it pulses the relay, so
// the bulb flashes now rather than up to a minute later when the next
// Supabase poll notices.
//
// This is not in the door's path and cannot be: by the time it arrives the
// door has already opened. Nothing here can open anything, and the same
//10 second debounce applies, so a duplicate from the poll below is a no-op.
// Unauthenticated, like every other endpoint on this server, because the
// worst it can do is flash a light in the lounge.
app.post('/door/opened', (req, res) => {
  flashDoorBulb();
  res.sendStatus(204);
});

// What the kiosk polls. Same shape as /cameras: it says whether the
// feature is configured at all, so the panel can hide itself.
app.get('/door/events', (req, res) => res.json({
  configured: doorConfigured,
  error: doorError,
  events: doorEvents
}));

if (doorConfigured) {
  console.log('Door panel polling ' + DOOR_EVENTS_URL);
  if (DOOR_FLASH_IP) {
    console.log(`Door flash on ${DOOR_FLASH_IP}` +
      (hhmmToMinutes(DOOR_QUIET_FROM) !== null && hhmmToMinutes(DOOR_QUIET_TO) !== null
        ? `, quiet ${DOOR_QUIET_FROM} to ${DOOR_QUIET_TO}` : ''));
  }
  doorTick();
  setInterval(doorTick, DOOR_POLL_MS);
} else {
  console.log('Door panel disabled (set DOOR_EVENTS_URL and DOOR_DASHBOARD_KEY in .env)');
}

app.listen(process.env.PORT, () => {
  console.log(`Home controller running at http://127.0.0.1:${process.env.PORT}`);
});
