# HomeControll

Two pieces of software that run the living room / bar smart-home setup:

| Folder | What it is |
| --- | --- |
| [`home-controller/`](home-controller) | Node.js + Python server driving the lights, plugs, fairy curtains and cameras, with two touchscreen kiosk pages |
| [`spotify-home-button/`](spotify-home-button) | Tiny Chrome extension that puts a "back to dashboard" button on Spotify, because Spotify won't load in an iframe |

Everything runs on one Windows PC (a Surface Book 2) on the home LAN. Nothing
is exposed to the internet and nothing talks to a vendor cloud at runtime.

---

## Part 1 — Home Controller

### Purpose

Two wall-mounted touchscreens control the room. One is the main kiosk
(lights plus both camera feeds), the other is a lights-only screen with
bigger touch targets and the fairy-light controls. Both poll the same
server every 3 seconds, so whatever you press on one shows up on the other.

### Architecture

```
  Kiosk 1                Kiosk 2
  public/index.html      public/lights.html
  (lights + cameras)     (lights + fairy curtains)
        |                       |
        |   HTTP, polls /lights/state every 3s
        |                       |
        +-----------+-----------+
                    |
             server.js  (Express, port 3000)
             - in-memory lightState: zones, scenes, plug states
             - party colour-cycling interval (30s steps)
             - ffmpeg RTSP -> MJPEG restream
             - motion detection on camera 1 frames
                    |
        +-----------+-----------+---------------------+
        |           |           |                     |
   spawn python  spawn python  spawn python      spawn ffmpeg / powershell
   tapo_helper   plug_helper   fairy_helper
        |           |           |                     |
     Tapo bulbs   Arlec/Tuya  Hello Fairy         RTSP cameras (0-2,
     + L920 bar   plugs       BLE curtains        each optional)
     (KLAP/LAN)   (tinytuya   (bleak, reverse-    + screen on/off
                   /LAN)       engineered)
```

The server holds no persistent state — `lightState` is a plain object that
resets on restart. Each device command is a fresh `spawn()` of a Python
script that gets its arguments as one JSON string in `argv[1]` and answers
with one JSON line on stdout. It's not fast, but it keeps three very
different device protocols out of the Node process.

### Hardware inventory

Bulb models aren't recorded per-IP anywhere in the code — `tapo_helper.py`
probes device classes in order (`l530`, `l630`, `l510`, `l610`, `l900`,
`l920`, `l930`) and uses the first that connects, so the table says what the
code can tell us.

**Tapo lights** (LAN, KLAP protocol, credentials from `.env`)

| Zone | IP | Notes |
| --- | --- | --- |
| Living Room | 192.168.68.61 | colour bulb |
| Living Room | 192.168.68.68 | colour bulb |
| Living Room | 192.168.68.63 | colour bulb — **board-game table light** |
| Living Room | 192.168.68.71 | colour bulb — **board-game table light** |
| Living Room | 192.168.68.53 | colour bulb |
| Living Room | 192.168.68.69 | colour bulb |
| Living Room Plus | 192.168.68.75 | colour bulb |
| Living Room Plus | 192.168.68.78 | colour bulb |
| Balcony | 192.168.68.50 | colour bulb |
| Balcony | 192.168.68.51 | colour bulb |
| Balcony | 192.168.68.52 | colour bulb |
| Bar | 192.168.68.80 | L920 strip — built-in effects, no per-zone scenes |

**Arlec / Tuya plugs** (LAN via `tinytuya`, local keys from `.env`)

| UI label | Internal name | IP | Tuya protocol |
| --- | --- | --- | --- |
| Disco Ball | `disco` | 192.168.68.86 | 3.3 |
| Spotlight 2 | `spotlight` | 192.168.68.88 | 3.3 |
| Spotlight 1 | `spotlight2` | 192.168.68.81 | 3.5 |

> The UI labels are crossed over relative to the internal names: the card
> labelled **Spotlight 1** drives the plug named `spotlight2`, and vice
> versa. Harmless, but confusing when you're debugging one of them.

**Hello Fairy BLE curtains** (Bluetooth LE, `bleak`)

| Curtain | MAC | Notes |
| --- | --- | --- |
| Fairy 1 | `FF:24:12:11:07:D6` | left curtain |
| Fairy 2 | `FF:24:12:11:0D:C6` | right curtain |

Write characteristic `49535343-8841-43f4-a8d4-ecbe34729bb3`, frames
`AA … BB`. Protocol was reverse-engineered from the vendor app; see
`fairy_helper.py` for the frame layouts.

**Other**

| Thing | Where | Notes |
| --- | --- | --- |
| Server host | 192.168.68.57:3000 | Surface Book 2, Windows |
| Camera 1 | `CAMERA_IP` in `.env` | RTSP `/stream1`. Leave empty to disable |
| Camera 2 | `CAMERA2_IP` in `.env` | RTSP `/stream1`. Leave empty to disable |
| ffmpeg | `C:\ffmpeg\bin\ffmpeg.exe` | override with `FFMPEG_PATH` |

Either camera can be left out. An empty IP means the stream is never
started, its route is never registered, and the kiosk hides the tile — so an
unplugged camera costs nothing, and comes back by filling the variable in
again and restarting.

### Scenes

Applied globally (all zones at once) or per-zone.

| Scene | What it does |
| --- | --- |
| **Work** | 4500K white at the current brightness |
| **Cosy** | 2700K warm white |
| **Party** | Random hue per bulb at 90% saturation, then the server cycles hues continuously |
| **Gaming** | Party everywhere *except* the two board-game table bulbs (`.63`, `.71`), which stay 2700K warm white on their own brightness slider |

Party and Gaming also switch on the fairy curtains, all three plugs, and the
bar strip's Rainbow effect. Pressing the active global scene again turns
everything off.

Party cycling lives in `server.js`, not the browser: `PARTY_ZONES` holds the
bulb IPs, and every 30s a tick interpolates each bulb one step of ten toward
a fresh set of hues spread around the wheel. It only runs while some zone is
actually in party mode.

### Files

| File | Role |
| --- | --- |
| `server.js` | Express app. All state, all REST endpoints, party interval, camera restream, child-process spawning |
| `tapo_helper.py` | Tapo bulbs and the L920 bar strip: on/off, brightness, colour temp, hue/sat, effect presets |
| `plug_helper.py` | The three Tuya plugs via `tinytuya`, local LAN control, credentials from `.env` |
| `fairy_helper.py` | BLE fairy curtains: power, HSV colour, white, five music-reactive modes |
| `public/index.html` | Main kiosk — zones, scenes, plugs, both camera feeds |
| `public/lights.html` | Second screen — same zones and scenes plus per-curtain fairy controls |
| `screen-on.ps1` / `screen-off.ps1` | Nudge the mouse to wake / send `WM_SYSCOMMAND SC_MONITORPOWER` to sleep the displays |
| `tools/` | One-off manual test scripts from setup. Not used by the server |

The repo also runs a small GitHub Actions check on every push and PR:
syntax-checks `server.js` and the Python helpers, boots the server with no
cameras configured and hits its endpoints, and fails if a `.env` or any
tinytuya artifact was ever committed.

### REST API

| Method | Path | Body / notes |
| --- | --- | --- |
| `GET` | `/lights/state` | Full `lightState` — what both kiosks poll |
| `POST` | `/lights/state` | `{ zone, on, mode, brightness, globalScene, globalBrightness }` — updates state and starts/stops party cycling |
| `POST` | `/tapo/control` | `{ ip, on, brightness, color_temp, hue, saturation, effect }` |
| `POST` | `/plug/control` | `{ device: 'disco'\|'spotlight'\|'spotlight2', on }` |
| `POST` | `/fairy/control` | `{ mac, on, hue, saturation, brightness, white, music, sensitivity }` |
| `GET` | `/cameras` | Which cameras are configured — the kiosk builds its tiles from this |
| `GET` | `/camera/stream` | MJPEG `multipart/x-mixed-replace`. Only registered when `CAMERA_IP` is set |
| `GET` | `/camera2/stream` | MJPEG `multipart/x-mixed-replace`. Only registered when `CAMERA2_IP` is set |
| `POST` | `/screen/off` | Blank both displays |
| `POST` | `/screen/wake` | Wake them |
| `GET` | `/screen/state` | Last screen action + timestamp |
| `GET` | `/lights` | Serves `public/lights.html` |

### Setup

Windows host, with Node, Python 3 and ffmpeg at `C:\ffmpeg\bin\ffmpeg.exe`.

```powershell
cd home-controller

npm install
pip install -r requirements.txt

copy .env.example .env
notepad .env          # fill in every value
```

`.env` needs:

| Group | Vars |
| --- | --- |
| Server | `PORT` |
| Tapo | `TAPO_EMAIL`, `TAPO_PASSWORD` |
| Cameras | `CAMERA_IP`, `CAMERA2_IP` (either may be empty), `CAMERA_USERNAME`, `CAMERA_PASSWORD` |
| Optional | `MOTION_CAMERA` (which camera drives motion wake), `FFMPEG_PATH` |
| Plugs | `PLUG_<DISCO\|SPOTLIGHT\|SPOTLIGHT2>_{ID,IP,KEY,VER}` |
| Fairy | `FAIRY1_MAC`, `FAIRY2_MAC` (only used by `tools/fairy_test.py`) |

Plug IDs and local keys come from the tinytuya wizard:

```powershell
python -m tinytuya wizard
```

It writes `tinytuya.json`, `devices.json`, `snapshot.json` and
`tuya-raw.json` into the working directory. **All four are gitignored** —
they hold your Tuya *cloud* API key and secret plus every plug's local key.
Copy the id/ip/key values into `.env` and leave the JSON files where they
are.

Run it under PM2 so it survives reboots:

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install

pm2 start server.js --name home-controller
pm2 save
```

For a quick foreground run while testing, `npm start`. `npm run check`
syntax-checks `server.js` without starting it.

PM2 must run it with `home-controller/` as the working directory —
`server.js` calls `require('dotenv').config()`, which resolves `.env`
relative to cwd.

Then point kiosk 1 at `http://127.0.0.1:3000/` and kiosk 2 at
`http://192.168.68.57:3000/lights`.

### Known limitations

- **No authentication, and it binds all interfaces.** Anyone on the LAN can
  hit every endpoint, including both camera streams. Fine behind a trusted
  router; don't port-forward it.
- **Fairy curtains do solid colour and the five built-in music modes only.**
  The protocol has no per-LED addressing, so no chases, gradients or
  pixel-mapped patterns — that's a device limit, not a code one.
- **BLE has no pairing or auth.** Anyone in radio range who knows the MAC
  can drive the curtains.
- **One BLE connection per command.** `fairy_helper.py` connects, writes and
  disconnects each time, so there's a visible lag and rapid slider drags are
  debounced 300ms in the UI.
- **State is in memory.** Restart the server and it thinks everything is off,
  whatever the bulbs are actually doing.
- **State is optimistic.** Nothing is read back from the devices. If a bulb
  is unreachable the UI still shows the change.
- **The kiosks assume they're the only clients.** `pushState` pauses polling
  for 2s after a press, so a change made elsewhere in that window is missed
  until the next real update.
- **The bar strip's effects are firmware presets.** They can't be synced to
  the party hue cycle or to the music modes.
- **Gaming mode's warm bulbs are hardcoded** as `192.168.68.63` and
  `192.168.68.71` in both HTML files. Move a lamp, edit both.
- **The `/screen/*` endpoints have no UI.** They work, but nothing in either
  page calls them, so motion wake never actually fires today.
- **Motion detection is crude** — it sums every 20th byte of the JPEG and
  compares frames. It ignores frames while the party cycle is running and for
  5s after any light command, so the server no longer wakes the screens with
  its own lighting changes, but it is still whole-frame brightness rather
  than real motion tracking.
- **Motion wake needs a camera.** With every camera disabled there is nothing
  to detect against, so the screens will not wake on their own.
- **Windows-only.** The display control shells out to PowerShell, and the
  ffmpeg default is a Windows path (overridable with `FFMPEG_PATH`).

---

## Part 2 — Spotify Home Button

### What it does

Spotify blocks iframes, so "Open Spotify" on the kiosk has to be a real
navigation — and once you're on `open.spotify.com` there's no way back to
the dashboard on a touchscreen with no browser chrome.

This extension injects a floating pill button, top-left over the Spotify
logo, that navigates back to `http://192.168.68.57:3000/`.

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, content script scoped to `https://open.spotify.com/*` |
| `content.js` | Injects the button; a `MutationObserver` re-adds it because Spotify is an SPA and wipes the DOM on navigation |
| `style.css` | Pill styling, `position: fixed`, `z-index: 999999` |

No build step, no secrets, no permissions beyond the host match, no network
calls of its own.

### Loading it

Not on the Chrome Web Store — it's loaded unpacked on the kiosk PC:

1. `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select `spotify-home-button/`

It survives browser restarts but Chrome will nag about developer-mode
extensions on each launch.

If the server's IP ever changes, edit `DASHBOARD_URL` at the top of
`content.js` and hit reload on the extension card.

### Known limitations

- **The dashboard URL is hardcoded.** No options page.
- **The observer only watches `document.body`'s direct children**
  (`subtree: false`). Cheap, and enough for the navigations Spotify actually
  does, but a deeper re-render could drop the button until the next one.
- **`open.spotify.com` only.** Not the desktop app, not `accounts.spotify.com`.
