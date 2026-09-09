# Door Opener

A web page you can open on your phone, or send to a guest, where you type a
pass and the street door opens.

The intercom in the hallway has a physical button that releases the door.
An ESP32 with an opto isolated relay sits across that button's contacts, so
a claimed command is indistinguishable from a finger on the button, and the
button keeps working whether this system is up, down, or halfway through a
redeploy.

Nothing forwards a port into the flat.

---

## Architecture

```
  phone / guest's phone
  public/index.html on Netlify
         |
         |  POST { pass }
         v
  door-open   (Supabase Edge Function)
    checks the pass against every stored hash, server side
    checks the IP lockout and the global limiter
    door_consume(): window and use count under one row lock,
                    in the same transaction that increments the counter
         |
         |  inserts a row, expires_at = now() + 30s
         v
  door_commands   (Postgres, RLS on, no policies)
         ^
         |  door_claim(): SELECT ... FOR UPDATE SKIP LOCKED
         |  every 2 seconds, over outbound HTTPS
         |
  door-poll   (Supabase Edge Function, x-device-key)
         ^
         |
      ESP32  ---> relay ---> across the intercom's release button


  door-events (Edge Function, x-dashboard-key, read only, no IP column)
         ^
         |  every 3 seconds
  home-controller/server.js  --->  kiosk door panel + a Tapo bulb flash
```

Three separate keys, three separate blast radii:

| Key | Held by | What it can do | What it cannot do |
| --- | --- | --- | --- |
| service role | the Edge Functions only | everything | leave Supabase |
| `DOOR_DEVICE_KEY` | the ESP32 | claim one waiting command | read passes, read the log, queue an open |
| `DOOR_DASHBOARD_KEY` | the home controller | read the last 50 attempts, without IPs | claim anything, open anything |

Rotate any one of them without touching the others.

### What actually drives the relay

One wire, GPIO26, and three lines of firmware:

```c
digitalWrite(RELAY_PIN, RELAY_ON);
delay(PULSE_MS);            // one second
digitalWrite(RELAY_PIN, RELAY_OFF);
```

The pin swings between 0V and 3.3V. That is the whole control signal. It
drives the LED inside the module's optocoupler, the phototransistor on the
other side of that LED switches the coil, the coil closes the contacts, and
the contacts are what sits across the intercom's button.

So there are three electrically separate stages between the firmware and
the door: the ESP32 side never shares a connection with the coil side, and
the coil side never shares one with the contacts. Nothing the software can
do puts a voltage on the intercom, and nothing the intercom does can reach
the ESP32.

**No computer is involved in opening the door.** The Surface Book is not in
the path, and neither is any machine on the LAN. The ESP32 talks to
Supabase over outbound HTTPS on the flat's WiFi and takes its instructions
from there. A USB cable is needed once to flash it, and after that only for
5V, which a phone charger supplies.

Nothing can connect *to* the board either. It opens connections outwards
and listens on nothing, which is why there is no port forward anywhere in
this design.

### Why polling, not Realtime

The ESP32 polls every 2 seconds rather than holding a Supabase Realtime
websocket. Realtime on an ESP32 needs reconnect handling that fails in
exactly the conditions where you need the door to work, and a router reboot
costs this loop one poll and no configuration. Two seconds of latency on a
door is nothing.

### Why the ESP32 is the only claimer

`door_claim()` is the single path that consumes a command, and only
`door-poll` can reach it. The home controller polls a different function
that physically cannot claim. If the Node server could also claim, it would
win about half the races and those presses would vanish silently, which is
the worst possible failure for a door.

---

## Hardware

| Part | Notes |
| --- | --- |
| ESP32 DevKit, 30 pin, WROOM-32 with CP2102 | The board in the pinout diagram everyone has. Arduino core for ESP32 |
| Single channel opto isolated relay module | **Get the 5V version.** The 12V one needs its own supply |

### Wiring

```
   ESP32                          relay module
  ---------                     ----------------
   GPIO26   --------------->  IN      (trigger)
   VIN / 5V --------------->  DC+     (5V)
   GND      --------------->  GND / DC-

                               COM  ----+
                                        |--- across the intercom's
                               NO   ----+    existing release button
```

**DC+ goes to VIN, not to 3V3.** VIN is the board's USB 5V rail. Some
boards, USB-C ones especially, label that same pin `5V` instead; either way
it is the pin next to GND at the bottom of the left header, and it is the
one you want.

A 5V relay coil will not pull in reliably at 3.3V: it may buzz, half latch,
or work on the bench and fail in the cold. This is the one wiring mistake
that produces a door which mostly works.

Some boards diode-isolate VIN from USB 5V, so it reads nearer 4.7V than
5.0V under USB power. That is still comfortably above a 5V relay's pull-in
voltage. If the relay is unreliable, measure VIN before blaming anything
else.

If you did get 12V modules, they cannot be powered from this board at all.
They need a separate 12V supply, with that supply's negative tied to ESP32
GND so IN has a common reference. Simpler to use a 5V module.

The ESP32 never touches the intercom's 12V line either way. The relay
contacts are dry and the opto isolator keeps the two sides electrically
separate, so the coil side and the door side share nothing but the two
contact wires. Wiring COM and NO in parallel with the button means the
button is unaffected: press it and the door opens exactly as before.

### What wire to buy

Only one run needs buying: **relay COM and NO to the intercom**. The F to F
jumpers that came with the board cover ESP32 to relay, which is three short
hops inside the same box.

**Tinned copper, stranded, 2 core, 20 AWG (0.5mm2).** Sold as automotive,
marine or lamp cord. Five metres is plenty and leaves slack for a second
attempt.

Why each part of that matters:

- **20 AWG** because you do not yet know what the button carries. In some
  intercoms the release button switches the strike coil directly, on the
  order of an amp. In others it is a milliamp signal to the intercom's own
  electronics. 20 AWG covers both without having to find out, drops nothing
  over a run this short, and fits the relay's screw terminals comfortably.
- **Stranded, not solid.** Solid core work hardens and snaps where it flexes
  going into a wall box, and this run will get moved at least twice while
  you are fitting it.
- **Tinned** means every strand is tin plated. It does not oxidise, so screw
  terminals stay low resistance for years, it solders almost by itself, and
  it is the metal the quick splice connectors below are designed to bite
  into. This is the one upgrade worth paying for.
- **Copper, not copper clad aluminium.** See below if you already have CCA.

**Polarity does not matter.** COM and NO are a dry contact, which is to say
a switch. There is no correct way round, so any two conductors will do and
the colours are for your own sanity rather than for the circuit.

When ordering, check you are getting **2 conductor** cable and not a single
conductor spool. Two separate spools in different colours work just as well.

### If you already have copper clad aluminium

CCA is an aluminium core with a thin copper skin, and it is what most cheap
red and black 12V speaker cable is. It will work here. 20 AWG CCA behaves
like 22 AWG copper, because aluminium carries about 61% of what copper
does, which over three metres at an amp costs about a third of a volt. On a
12V strike that is nothing.

The difference is not conductivity, it is that the aluminium underneath
creeps under pressure in a way copper does not. Two habits cover it:

- **Re-tighten the relay's screw terminals a week after fitting.** The core
  will have relaxed slightly. That is the whole trick with aluminium and it
  takes ten seconds.
- **Solder any cable to cable joint rather than splicing it.** CCA solders
  well, because the surface the solder wets is copper. Solder the two wires
  together, heatshrink over it, done.

That second point does not contradict the ferrule advice above. Soldering
two wires to each other is a good joint. Tinning a wire end that then goes
under a screw is a bad one, because the solder cold flows and the screw
loosens. Both are still true.

### About the quick splice connectors

The solderless, no stripping kind press a blade through the insulation into
the conductor.

**On tinned copper they are fine.** That is exactly what they are built
for, and there is nothing to think about.

**On stranded CCA they are the weakest joint in the build.** The blade cuts
through the copper skin into the aluminium underneath, which then has a
freshly exposed surface to oxidise, against a dissimilar metal, under a
pressure the aluminium slowly creeps away from. Aluminium oxide is an
insulator, unlike copper oxide, so the joint gets worse rather than
settling.

None of that is fast or dramatic. It is a door that works for eight months
and then starts needing two presses.

So on CCA, prefer in this order:

1. The intercom's own screw terminal, if it has one.
2. Soldered and heatshrunk.
3. The relay's screw terminals, which the design requires anyway.
4. A quick splice, if there is genuinely nothing else.

If you do end up using one, note where it is. When the door gets flaky
months from now, that joint is the first thing to check, and the log on the
kiosk will tell you when it started.

### Before you cut anything

Look for terminals on the intercom first. A lot of door phones have a
labelled pair for exactly this, something like `door release`, `DO`, or a
push to exit input. Landing on a terminal block is far better than
soldering to the back of the button: it is reversible, it is what the
terminals are for, and it does not risk lifting a pad on a unit that is
probably older than the lease.

If there is no terminal and you do have to go to the button, put a
multimeter across its contacts in continuity mode and press it. The pair
that beeps is the pair you want, and the relay goes across those two.

For the ends, use bootlace ferrules if you can get them. Do not tin
stranded wire with solder for a screw terminal: solder cold flows under
pressure and the joint quietly loosens over months, which is a hard fault
to find later. Failing ferrules, twist the strands tight and do not
overstrip, so nothing can splay into the neighbouring terminal.

The dupont jumpers between the board and the relay are fine electrically
but they work loose with vibration. A zip tie or a dab of hot glue over the
connectors once it is tested costs nothing and saves a callout to yourself.

### Which way to set the jumper

**Start on HIGH.** The firmware ships configured for it
(`RELAY_ACTIVE_LOW 0`).

In HIGH mode the module's IN pin sits behind the optocoupler LED to ground,
so an undriven pin cannot rise past the LED's forward voltage and the relay
physically cannot close. Every reset, brownout, watchdog and reflash is
safe by construction, with no extra components and without relying on the
firmware getting its pin ordering right. In LOW mode an undriven pin is the
ON state, which is the exact failure this design exists to avoid.

The catch is that HIGH trigger drives the optocoupler straight from the
ESP32's 3.3V, and this module is specified at 5mA trigger current. Whether
3.3V clears that depends on the resistor the manufacturer fitted. It
usually works. When it does not, it fails safe: the relay simply never
clicks, which the bench test shows you in ten seconds.

**LOW trigger fallback.** If HIGH will not click reliably:

1. Move the jumper to LOW and set `RELAY_ACTIVE_LOW 1` in `config.h`.
2. Add a **10k resistor from IN to 3V3**. This holds IN high during the
   moments the ESP32 is not driving it, which is every reset. Pull it up to
   3V3 and not to DC+: 5V on a GPIO would be outside what an ESP32 pin
   tolerates.
3. The sketch's `relaySafe()` already writes the pin level before switching
   it to an output, which covers the software half. The resistor covers the
   hardware half. You want both in this mode.

### Bench test it first

Set `DOOR_BENCH_TEST 1` in `config.h` and flash it with **nothing connected
to the intercom**. It skips WiFi and Supabase entirely and pulses the relay
every 5 seconds, printing what it is doing at 115200 baud.

| What to watch | What it means |
| --- | --- |
| One click in, one click out per pulse, red LED with it | The jumper and wiring are right |
| Nothing ever clicks | 3.3V is not driving the opto. Try the other jumper position |
| Relay stays closed, buzzes, or double clicks | The OFF level is not reaching the module. See the LOW trigger fallback |
| **Press EN a dozen times during the quiet gaps** | The relay must stay silent through every reset. **If it clicks on reset, stop and fix the jumper before this goes anywhere near the intercom** |

Set `DOOR_BENCH_TEST` back to 0 before installing.

You ordered three modules, so if one behaves oddly on the bench, try
another before assuming the wiring is wrong.

### Power

USB from any phone charger. The relay coil draws about 70mA while
energised and the ESP32 peaks near 250mA on WiFi transmit, so a 500mA
supply is plenty.

**If your board is USB-C and it will not power up, try a USB-A to C cable.**
Plenty of cheap USB-C dev boards leave out the two 5.1k CC pull-down
resistors that tell a USB-C charger something is plugged in. Without them a
C to C cable into a C charger delivers no power at all, because the charger
never enables VBUS. An A to C cable always works, because USB-A has 5V
present with no negotiation. A dead board on a C to C cable is almost
always this and not a fault.

Windows usually installs the CP2102 driver by itself. If no COM port
appears, install Silicon Labs' CP210x VCP driver.

---

## Setup, in order

Each step is checkable on its own, and they are ordered so that nothing
depends on something you have not built yet.

Only two things genuinely need to exist before others: **Supabase before
everything**, and **a pass before you can test anything**. The Netlify page
and the ESP32 do not depend on each other at all, so their order is up to
you, and the hardware can be proved on day one with neither.

### 1. Prove the relay works

Before anything else, and before any account exists anywhere. Set
`DOOR_BENCH_TEST 1` in `config.h`, flash the board, and watch the relay.

With that flag the sketch returns out of `setup()` before it touches WiFi,
so the untouched `config.h.example` values are fine. No Supabase, no
Netlify, no keys. Just the board, the relay and a USB cable.

Full details, including what each failure looks like, are in
**Bench test it first** in the Hardware section above. The one that matters:
press EN a dozen times and the relay must stay silent through every reset.

Do this the day the parts arrive. Everything below is software and can wait
for a wet weekend; this is the step that tells you whether the hardware you
bought does what it should.

### 2. Database

Create a Supabase project. In the SQL editor, paste and run
[`supabase/schema.sql`](supabase/schema.sql). That creates three tables with
row level security on and **no policies**, plus the functions the Edge
Functions call.

No policies is the point. Anon and authenticated can read and write nothing.
Only the service role key, which never leaves the Edge Functions, gets in.

### 3. Edge Functions

```bash
cd door-opener

supabase link --project-ref YOUR-PROJECT-REF

# Generate the two keys. Keep the output; you need each one twice.
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

cp .env.example .env
$EDITOR .env                       # paste the two keys in
supabase secrets set --env-file .env

supabase functions deploy door-open   --no-verify-jwt
supabase functions deploy door-poll   --no-verify-jwt
supabase functions deploy door-events --no-verify-jwt
```

`--no-verify-jwt` is required on all three. A guest at the door has no
Supabase account and no token: `door-open` authenticates with the pass
itself, and the other two with their own keys.

### 4. Your first pass

```bash
cd door-opener
node tools/make-pass.js resident --label "Santi"
```

It prints the pass once and the SQL to store it. Run the SQL in the Supabase
SQL editor. The plaintext is never stored and cannot be recovered, so if you
lose it, generate another.

### 5. The ESP32

There is no setup portal and no web page on the board. Configuration is a
header file that gets compiled in, so changing any of it means editing
`config.h` and uploading again. That is on purpose: a board with no config
interface has no config interface to attack, and this one has WiFi
credentials and a door key on it.

**First, the tools.** Once only:

1. Install the Arduino IDE from arduino.cc.
2. **File > Preferences > Additional boards manager URLs**, paste:
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. **Tools > Board > Boards Manager**, search `esp32`, install
   **esp32 by Espressif Systems**.
4. **Tools > Board > esp32 > ESP32 Dev Module**.

**Then the config:**

```bash
cd firmware/door_opener
cp config.h.example config.h
$EDITOR config.h
```

`config.h` sits next to the sketch and is gitignored, so your WiFi password
and device key never reach the repo. Open `door_opener.ino` in the Arduino
IDE and `config.h` appears as a second tab, which is usually easier than
editing it separately.

Step 1 needed none of this filled in. Now set `DOOR_BENCH_TEST` back to 0
and fill in the WiFi credentials, the `door-poll` URL, and
the same `DOOR_DEVICE_KEY` you set in step 3.

**The WiFi must be 2.4GHz.** The ESP32 has no 5GHz radio at all. If your
router publishes one merged SSID for both bands this usually still works,
but if the board never connects and the credentials are definitely right,
this is why: split the bands or use the 2.4GHz SSID.

**To upload:** plug in USB, pick the port under **Tools > Port** (on
Windows it shows as Silicon Labs CP210x), and press the arrow. Watch it at
115200 with **Tools > Serial Monitor**.

Three things that go wrong on a first upload:

| Symptom | Fix |
| --- | --- |
| No port listed at all | Install the Silicon Labs CP210x VCP driver. Also try a different cable: plenty of USB cables are charge only and have no data lines |
| `Failed to connect ... Timed out waiting for packet header` | Hold the **BOOT** button while it prints `Connecting....`, release once the upload starts. Some boards auto-reset reliably and some do not |
| Upload starts then fails partway | Drop **Tools > Upload Speed** to 115200 |

Also close the Serial Monitor before uploading. It holds the port open and
the upload will fail with a busy port.

Then paste the root certificate. While `SUPABASE_ROOT_CA` is empty the board
works but does not verify who it is talking to, and prints a warning on every
boot saying so. Get the certificate with:

```bash
openssl s_client -showcerts -connect YOUR-PROJECT-REF.supabase.co:443 </dev/null 2>/dev/null
```

and paste the last certificate in the chain, BEGIN and END lines included.

Flash `door_opener.ino` with the Arduino IDE (board: ESP32 Dev Module) and
watch the serial monitor at 115200.

If you skipped step 1, do it now, before wiring anything to the intercom.
It is the step that tells you the jumper is right and catches a relay that
fires on reset.

Once it is flashed, unplug it from the computer and put it on a phone
charger. The USB cable was only ever for flashing and for reading the
serial log; after that it is just 5V. Nothing about the door needs a
computer, and the board is not reachable from one. It makes outbound HTTPS
requests and accepts no connections.

### 6. Open the door with curl

You now have everything except a nice way to type a pass. Prove it with
curl before building one:

```bash
curl -X POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/door-open \
  -H 'content-type: application/json' \
  -d '{"pass":"YOUR-PASS-HERE"}'
```

`{"ok":true,"reason":"opened","ttl":30}` and a click from the relay within
two seconds means the whole chain works: the pass was checked server side, a
command was queued, and the ESP32 claimed it and pulsed.

What the failures tell you:

| Response | Where to look |
| --- | --- |
| `{"ok":false,"reason":"unknown"}` | The pass is wrong, or the SQL insert never ran. Check `select * from door_pass_status` |
| `ok:true` but no click | The board. Serial monitor at 115200 says whether it is polling, and a 401 there means `DOOR_DEVICE_KEY` does not match |
| Connection refused or a 404 | The function is not deployed, or the project ref in the URL is wrong |

Getting this far means the door works. The page is a front end for this one
request.

### 7. The page

Edit [`public/config.js`](public/config.js) and put your project ref in
`openUrl`. That is the only edit the page needs.

In Netlify, create a site from this repo and set **Base directory** to
`door-opener`. It reads `netlify.toml` from there and publishes `public/`.
There is no build step.

Or by hand:

```bash
cd door-opener
netlify deploy --prod
```

Then tighten two things now that you know your URLs:

- `netlify.toml`: narrow `connect-src` from `https://*.supabase.co` to your
  own project.
- `.env`: set `DOOR_ALLOWED_ORIGIN` to the Netlify origin and re-run
  `supabase secrets set --env-file .env`.

### 8. The kiosk panel (optional)

In `home-controller/.env`:

```
DOOR_EVENTS_URL=https://YOUR-PROJECT-REF.supabase.co/functions/v1/door-events
DOOR_DASHBOARD_KEY=the-dashboard-key-from-step-3
DOOR_FLASH_IP=192.168.68.61
DOOR_QUIET_FROM=23:00
DOOR_QUIET_TO=07:00
```

Restart the server. The panel appears on the main kiosk with the last ten
events, and a successful open flashes the named bulb.

Leave `DOOR_EVENTS_URL` empty and the panel hides itself and nothing is
polled. The door does not depend on any of it.

---

## Passes

Two kinds.

**Resident passes** have no expiry. One per person who lives here.

```bash
node tools/make-pass.js resident --label "Santi"
```

**Guest passes** are valid only inside a window.

```bash
node tools/make-pass.js guest --label "Sat party" \
  --from "2026-09-12T20:00" --until "2026-09-13T02:00"

# One shot, for a single visitor
node tools/make-pass.js guest --label "Plumber" \
  --until "2026-09-13T17:00" --max-uses 1
```

Times are read in the machine's local timezone and the tool prints both the
local time and the UTC it resolved to, so there is no guessing.

**A guest pass with no `--until` is refused**, by the CLI and by a CHECK
constraint in the schema, so writing the INSERT by hand does not get around
it. A shared pass with no end date is a permanent key sitting in a group
chat, and group chats outlive parties, flatmates and phones.

### What is live right now

```sql
select * from door_pass_status order by state, label;
```

| label | kind | state | valid_until | expires_in | use_count | max_uses |
| --- | --- | --- | --- | --- | --- | --- |
| Santi | resident | live | | | 214 | |
| Sat party | guest | live | 2026-09-13 02:00 | 04:12:33 | 9 | |
| Plumber | guest | used up | 2026-09-13 17:00 | 10:41:02 | 1 | 1 |
| Old flatmate | resident | revoked | | | 806 | |

No salts, no hashes, so the output is safe to paste anywhere.

### Turning one off

```sql
update door_passes set revoked_at = now() where label = 'Sat party';
```

Revoke rather than delete. A deleted pass drops out of the constant time
scan, and its rows in the attempt log lose their label on the kiosk.

---

## Security

**Everything is decided server side.** The browser collects characters and
posts them. It never receives a hash, never receives a pass id, and decides
nothing. Reading `public/door.js` tells an attacker the shape of the API and
nothing else.

**PBKDF2-SHA256, 120000 iterations, a fresh 16 byte salt per pass**, with a
constant time comparison. Iterations are stored per row, so the cost can be
raised later without invalidating existing passes.

**Every stored pass is checked, with no break on match.** Stopping at the
first match would make a pass stored early answer faster than one stored
late, which over enough samples says which pass matched.

**A wrong pass and a nonexistent one are the same answer**, always: "Not
recognised". Expired, revoked and used up say so, because the person has
already proved they know a real pass and there is nothing left to protect.

**Lockout: 5 failed attempts from one IP in 15 minutes.** Attempts that are
themselves rejected for being locked out do not count toward it, so the rate
settles at 5 per 15 minutes rather than becoming a permanent ban that one
attacker could inflict on a resident sharing their NAT.

**Global limiter: 30 failures in 15 minutes across all IPs.** A per IP
lockout is worthless against someone rotating addresses. The threshold is
high enough that ordinary use never reaches it.

**Queued commands expire in 30 seconds.** A captured request cannot be
replayed into an open a minute later, because there is nothing left to
claim.

**Row level security on, no policies.** Only the service role touches the
tables, and the functions are `SECURITY DEFINER` with `EXECUTE` revoked from
anon and authenticated, so a leaked anon key gets nothing.

**Every attempt is logged** with IP and outcome. The IP is in the table and
is not in `door_recent_events`, so the home controller cannot see it even by
accident. That dashboard is on a living room screen.

**The firmware sets the relay pin level before switching it to an output.**
The other order drives the latched 0, which on an active low module opens
the street door on every reset: on power up, on a flash, on a brownout, on a
watchdog. CI checks the order in `door_opener.ino` on every push.

---

## Known limitations

- **The page confirms the command was queued, not that the latch moved.**
  There is no sensor and no path back from the relay. The ESP32 claims
  within 2 seconds, and the success screen counts down a window in which to
  push. If the board is offline the page still says the door opened.
- **Response time grows with the number of passes.** Every pass is hashed on
  every attempt, which is what keeps the timing flat. Roughly 55ms per pass,
  so 20 passes is about 1.1 seconds. Past 40 or so, prune long dead ones.
- **The lockout trusts the edge's idea of the client IP.** `cf-connecting-ip`
  is set by the edge and replaces anything the client sent, so it holds up.
  If that header ever stops being populated the code falls back to the last
  entry of `x-forwarded-for`, which is weaker. The global limiter is the
  backstop for exactly this.
- **Anyone with the pass can open the door.** There are no accounts and no
  second factor, by design. A pass in a group chat is available to everyone
  in that group chat, which is why guest passes must expire.
- **`DOOR_ALLOWED_ORIGIN` defaults to any origin** so the page works before
  you have a Netlify URL. CORS is not what protects this endpoint, but
  narrow it anyway once you know the URL.
- **Whether HIGH trigger fires at 3.3V is not certain until you test it.**
  The module is specified at 5mA trigger current and the ESP32 gives 3.3V
  into whatever resistor the manufacturer fitted. It fails safe (the relay
  never clicks) and the fallback is one 10k resistor, but it is a bench
  test, not a guarantee.
- **A stale root certificate stops the poller**, months from now, when the
  root rotates. The serial log says so plainly. The physical intercom button
  and everyone's keys are unaffected: it stops the web page working, not the
  building.
- **No admin UI.** The CLI and the SQL editor are the whole management
  surface. That is deliberate: an admin UI is another public endpoint with
  another authentication story.
- **The attempt log grows.** `door_gc()` prunes commands older than a day
  and attempts older than 30 days. Nothing calls it; run it when you think
  of it, or wire it to pg_cron.

---

## Files

| File | Role |
| --- | --- |
| `public/index.html`, `door.css`, `door.js` | The page. Split into three files because the CSP has `script-src 'self'` and a CSP worth having cannot allow inline script |
| `public/config.js` | The one file to edit: your `door-open` URL |
| `netlify.toml` | Publish directory and the security headers |
| `supabase/schema.sql` | Tables, RLS, the claim and consume functions, the status view |
| `supabase/functions/door-open/` | Public. Checks the pass, queues a command |
| `supabase/functions/door-poll/` | Device only. Claims one command |
| `supabase/functions/door-events/` | Dashboard only. Read only, no IPs |
| `supabase/functions/_shared/door.ts` | PBKDF2, constant time compare, client IP, RPC |
| `tools/make-pass.js` | Generates a pass, prints it once, prints the SQL |
| `firmware/door_opener/door_opener.ino` | The ESP32 sketch |
| `firmware/door_opener/config.h.example` | Copy to `config.h`, which is gitignored |
| `firmware/test/` | Stubbed Arduino headers so CI can compile the sketch without a toolchain |
| `.env.example` | Every value the whole system needs, and where each one goes |
