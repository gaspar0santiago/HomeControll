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

function detectMotion(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 20) sum += frame[i];
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

// ── CAMERA 1 ──────────────────────────────────────────────────
let cameraProc = null, latestFrame = null;
const cameraClients = new Set();

function startCamera() {
  if (cameraProc) return;
  const url = `rtsp://${process.env.CAMERA_USERNAME}:${process.env.CAMERA_PASSWORD}@${process.env.CAMERA_IP}:554/stream1`;
  cameraProc = spawn('C:\\ffmpeg\\bin\\ffmpeg.exe', [
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-rtsp_transport', 'tcp', '-i', url,
    '-vf', 'scale=1280:720', '-f', 'mjpeg', '-q:v', '3', '-r', '25', '-'
  ], { windowsHide: true });

  let buf = Buffer.alloc(0);
  cameraProc.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      let start = -1, end = -1;
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0xFF && buf[i+1] === 0xD8) start = i;
        if (start >= 0 && buf[i] === 0xFF && buf[i+1] === 0xD9) { end = i + 2; break; }
      }
      if (start >= 0 && end > start) {
        latestFrame = buf.slice(start, end);
        buf = buf.slice(end);
        detectMotion(latestFrame);
        cameraClients.forEach(res => {
          try {
            res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`);
            res.write(latestFrame); res.write('\r\n');
          } catch(e) { cameraClients.delete(res); }
        });
      } else break;
    }
  });
  cameraProc.stderr.on('data', () => {});
  cameraProc.on('close', () => { cameraProc = null; setTimeout(startCamera, 5000); });
}

app.get('/camera/stream', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  cameraClients.add(res);
  if (latestFrame) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`);
    res.write(latestFrame); res.write('\r\n');
  }
  req.on('close', () => cameraClients.delete(res));
});

// ── CAMERA 2 ──────────────────────────────────────────────────
let cameraProc2 = null, latestFrame2 = null;
const cameraClients2 = new Set();

function startCamera2() {
  if (cameraProc2) return;
  const url = `rtsp://${process.env.CAMERA_USERNAME}:${process.env.CAMERA_PASSWORD}@${process.env.CAMERA2_IP}:554/stream1`;
  cameraProc2 = spawn('C:\\ffmpeg\\bin\\ffmpeg.exe', [
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-rtsp_transport', 'tcp', '-i', url,
    '-vf', 'scale=1280:720', '-f', 'mjpeg', '-q:v', '3', '-r', '25', '-'
  ], { windowsHide: true });

  let buf = Buffer.alloc(0);
  cameraProc2.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      let start = -1, end = -1;
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0xFF && buf[i+1] === 0xD8) start = i;
        if (start >= 0 && buf[i] === 0xFF && buf[i+1] === 0xD9) { end = i + 2; break; }
      }
      if (start >= 0 && end > start) {
        latestFrame2 = buf.slice(start, end);
        buf = buf.slice(end);
        cameraClients2.forEach(res => {
          try {
            res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame2.length}\r\n\r\n`);
            res.write(latestFrame2); res.write('\r\n');
          } catch(e) { cameraClients2.delete(res); }
        });
      } else break;
    }
  });
  cameraProc2.stderr.on('data', () => {});
  cameraProc2.on('close', () => { cameraProc2 = null; setTimeout(startCamera2, 5000); });
}

app.get('/camera2/stream', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  cameraClients2.add(res);
  if (latestFrame2) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame2.length}\r\n\r\n`);
    res.write(latestFrame2); res.write('\r\n');
  }
  req.on('close', () => cameraClients2.delete(res));
});

// ── PAGES ─────────────────────────────────────────────────────
app.get('/lights', (req, res) => res.sendFile(path.join(__dirname, 'public', 'lights.html')));

// ── START ─────────────────────────────────────────────────────
startCamera();
startCamera2();

// ── DISCO PLUG ────────────────────────────────────────────────
function controlPlug(payload) {
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

app.listen(process.env.PORT, () => {
  console.log(`Home controller running at http://127.0.0.1:${process.env.PORT}`);
});
