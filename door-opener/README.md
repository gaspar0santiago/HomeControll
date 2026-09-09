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
| ESP32 dev board | any of them; the sketch uses the Arduino core |
| Single channel opto isolated relay module | 3.3V logic, active low on almost every cheap one |

```
  ESP32 GPIO 26  ->  IN
  ESP32 3V3      ->  VCC
  ESP32 GND      ->  GND

  relay COM and NO  ->  across the intercom's existing release button
```

The ESP32 never touches the 12V line. The relay contacts are dry, the opto
isolator keeps the two sides electrically separate, and the module runs off
the board's 3V3 rail. Wiring in parallel with the button means the button is
unaffected: press it and the door opens exactly as before.

Worth adding: a 10k pull-up from IN to 3V3 on an active low module. During a
reset the ESP32's pins revert to inputs and IN floats for a few
milliseconds. Most modules have their own pull-up and are fine; the resistor
makes it certain.

---

## Setup, in order

### 1. Database

Create a Supabase project. In the SQL editor, paste and run
[`supabase/schema.sql`](supabase/schema.sql). That creates three tables with
row level security on and **no policies**, plus the functions the Edge
Functions call.

No policies is the point. Anon and authenticated can read and write nothing.
Only the service role key, which never leaves the Edge Functions, gets in.

### 2. Edge Functions

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

### 3. The page

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

### 4. The ESP32

```bash
cd firmware/door_opener
cp config.h.example config.h
$EDITOR config.h
```

Fill in the WiFi credentials, the `door-poll` URL, and the same
`DOOR_DEVICE_KEY` you set in step 2.

Then paste the root certificate. While `SUPABASE_ROOT_CA` is empty the board
works but does not verify who it is talking to, and prints a warning on every
boot saying so. Get the certificate with:

```bash
openssl s_client -showcerts -connect YOUR-PROJECT-REF.supabase.co:443 </dev/null 2>/dev/null
```

and paste the last certificate in the chain, BEGIN and END lines included.

Flash `door_opener.ino` with the Arduino IDE (board: ESP32 Dev Module) and
watch the serial monitor at 115200. **Before wiring it to the intercom**,
confirm the relay clicks once per open and never on reset: press the reset
button ten times with a pass unused and the relay must stay silent.

### 5. Your first pass

```bash
cd door-opener
node tools/make-pass.js resident --label "Santi"
```

It prints the pass once and the SQL to store it. Run the SQL in the Supabase
SQL editor. The plaintext is never stored and cannot be recovered, so if you
lose it, generate another.

### 6. The kiosk panel (optional)

In `home-controller/.env`:

```
DOOR_EVENTS_URL=https://YOUR-PROJECT-REF.supabase.co/functions/v1/door-events
DOOR_DASHBOARD_KEY=the-dashboard-key-from-step-2
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
| `.env.example` | Every value the whole system needs, and where each one goes |
