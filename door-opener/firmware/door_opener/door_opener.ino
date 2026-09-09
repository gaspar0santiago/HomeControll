// Street door opener, device end.
//
// Polls the door-poll Edge Function every 2 seconds. If a command is
// waiting it claims it and pulses the relay for one second. The relay
// contacts sit in parallel with the intercom's existing release button, so
// a claimed command is indistinguishable from a finger on that button, and
// the button keeps working whatever this board is doing.
//
// Nothing forwards a port into the flat. This board makes outbound HTTPS
// requests and nothing reaches in.
//
// Board:    ESP32 Dev Module, 30 pin DevKit with CP2102
//
// Wiring, for a 5V relay module:
//
//   ESP32 GPIO26  ->  IN     (the trigger)
//   ESP32 VIN     ->  DC+    (5V, NOT 3V3: a 5V coil will not pull in
//                             reliably at 3.3V. Some boards, USB-C ones
//                             especially, label this pin 5V instead)
//   ESP32 GND     ->  DC-
//
//   relay COM and NO  ->  across the intercom's existing release button
//
// A 12V module cannot be powered from this board at all. It needs its own
// 12V supply, with that supply's negative tied to ESP32 GND so IN has a
// common reference. Use the 5V version if you have one.
//
// The ESP32 never touches the intercom's 12V line either way. The relay
// contacts are dry and the opto isolator keeps the two sides electrically
// separate, so the coil side and the door side share nothing.
//
// Jumper: HIGH trigger by default. See the long note in config.h.example
// for why, and for the fallback if HIGH will not click at 3.3V.
//
// Before wiring anything to the intercom, set DOOR_BENCH_TEST to 1 in
// config.h and run it on the desk.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

#include "config.h"

// Two seconds. On a door that is nothing, and polling survives a router
// reboot with no reconnect logic and no configuration, which a websocket
// on this chip does not.
static const uint32_t POLL_INTERVAL_MS = 2000;

// How long the contacts stay closed. Long enough to read as a press, short
// enough that a crash mid-pulse cannot hold the latch open for long.
static const uint32_t PULSE_MS = 1000;

// Back off after repeated failures instead of hammering a dead network.
static const uint32_t POLL_BACKOFF_MAX_MS = 30000;

static const uint32_t HTTP_TIMEOUT_MS = 8000;
static const uint32_t WIFI_CONNECT_TIMEOUT_MS = 20000;

// Active low modules energise when IN is pulled to ground.
#if RELAY_ACTIVE_LOW
  static const int RELAY_ON  = LOW;
  static const int RELAY_OFF = HIGH;
#else
  static const int RELAY_ON  = HIGH;
  static const int RELAY_OFF = LOW;
#endif

static WiFiClientSecure tls;
static HTTPClient http;

static uint32_t nextPollAt = 0;
static uint32_t backoffMs = POLL_INTERVAL_MS;
static uint32_t opens = 0;

enum PollResult { POLL_NOTHING, POLL_OPEN, POLL_FAILED };

// ── RELAY ─────────────────────────────────────────────────────

// Order matters more than anything else in this file.
//
// digitalWrite first, pinMode second. A pin that is switched to OUTPUT
// before its level is set drives whatever was latched in the output
// register, which is 0. On an active low module 0 means energised, so
// doing it the other way round opens the street door every single time the
// board resets: on power up, on a flash, on a brownout, on a watchdog.
static void relaySafe() {
  digitalWrite(RELAY_PIN, RELAY_OFF);
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_OFF);
}

// Blocking on purpose. Nothing between the two writes can stretch the
// pulse: no HTTP call, no reconnect, no retry. The next poll is at most
// one second late, which nobody standing at the door will notice.
static void pulseRelay() {
  Serial.println("[door] release");
  digitalWrite(RELAY_PIN, RELAY_ON);
  delay(PULSE_MS);
  digitalWrite(RELAY_PIN, RELAY_OFF);
  opens++;
  Serial.printf("[door] relay released (%u opens since boot)\n", opens);
}

// ── WIFI ──────────────────────────────────────────────────────
static bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // modem sleep adds seconds to a 2s poll
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] no connection, will retry");
    return false;
  }

  Serial.print("[wifi] connected, ip ");
  Serial.println(WiFi.localIP());
  return true;
}

// ── POLL ──────────────────────────────────────────────────────
static PollResult pollOnce() {
  if (!http.begin(tls, DOOR_POLL_URL)) {
    Serial.println("[poll] could not start request");
    return POLL_FAILED;
  }

  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  // Keeps the TLS session alive between polls. A fresh handshake every two
  // seconds costs this chip more than the request does.
  http.setReuse(true);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DOOR_DEVICE_KEY);

  int status = http.POST("{\"device\":\"" DOOR_DEVICE_NAME "\"}");

  if (status != 200) {
    if (status == 401) {
      Serial.println("[poll] rejected: DOOR_DEVICE_KEY does not match the one set on the function");
    } else if (status < 0) {
      Serial.printf("[poll] transport error %d (%s)\n", status, http.errorToString(status).c_str());
    } else {
      Serial.printf("[poll] http %d\n", status);
    }
    http.end();
    return POLL_FAILED;
  }

  String body = http.getString();
  http.end();

  // Deliberately narrow. Only an explicit true opens anything, so a
  // truncated body, an error page or an empty response all mean no.
  bool open = body.indexOf("\"open\":true") >= 0 || body.indexOf("\"open\": true") >= 0;

  if (open) {
    Serial.printf("[poll] command claimed: %s\n", body.c_str());
    return POLL_OPEN;
  }
  return POLL_NOTHING;
}

// ── BENCH TEST ────────────────────────────────────────────────
#if DOOR_BENCH_TEST
static const uint32_t BENCH_INTERVAL_MS = 5000;

// Pulses the relay on a loop with no network at all, so the wiring and
// the jumper can be proved on the desk. What to look for:
//
//   1. The red status LED and an audible click on every "release", and
//      both stopping again a second later. If nothing clicks, the jumper
//      is on the wrong setting or 3.3V is not enough to drive the opto:
//      try the other jumper position.
//   2. Nothing at all between pulses. A relay that stays closed, buzzes,
//      or clicks twice means the OFF level is not reaching the module.
//   3. Press EN on the board a dozen times during the quiet gaps. The
//      relay must stay silent through every reset. If it clicks on reset,
//      do not wire this to the intercom: that is the failure that would
//      open the street door on every power cut.
static void benchTest() {
  Serial.println("[bench] relay off, waiting");
  delay(BENCH_INTERVAL_MS);
  Serial.println("[bench] pulsing now, expect one click in and one click out");
  pulseRelay();
}
#endif

// ── ARDUINO ───────────────────────────────────────────────────
void setup() {
  // Before anything else. Serial, WiFi and TLS all take time, and the
  // relay must be known to be off for every millisecond of it.
  relaySafe();

  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("[door] street door opener starting");
  Serial.printf("[door] relay on pin %d, %s trigger\n",
                RELAY_PIN, RELAY_ACTIVE_LOW ? "LOW" : "HIGH");

#if DOOR_BENCH_TEST
  // No WiFi, no TLS, no Supabase. Nothing here can reach the door.
  Serial.println("[bench] BENCH TEST MODE. Nothing is polled and no command");
  Serial.println("[bench] can arrive. Set DOOR_BENCH_TEST to 0 in config.h");
  Serial.println("[bench] before installing this.");
  return;
#endif

  if (strlen(SUPABASE_ROOT_CA) > 8) {
    tls.setCACert(SUPABASE_ROOT_CA);
    Serial.println("[tls] verifying the server certificate");
  } else {
    tls.setInsecure();
    Serial.println("[tls] WARNING: SUPABASE_ROOT_CA is empty in config.h.");
    Serial.println("[tls] The server is not being verified and the device key");
    Serial.println("[tls] is readable by anyone who can redirect this traffic.");
    Serial.println("[tls] See the comment in config.h.example for the fix.");
  }

  ensureWifi();
}

void loop() {
#if DOOR_BENCH_TEST
  benchTest();
  return;
#endif

  if (millis() < nextPollAt) {
    delay(20);
    return;
  }

  if (!ensureWifi()) {
    backoffMs = min(backoffMs * 2, POLL_BACKOFF_MAX_MS);
    nextPollAt = millis() + backoffMs;
    return;
  }

  PollResult result = pollOnce();

  if (result == POLL_OPEN) {
    pulseRelay();
  }

  if (result == POLL_FAILED) {
    backoffMs = min(backoffMs * 2, POLL_BACKOFF_MAX_MS);
    Serial.printf("[poll] backing off to %ums\n", backoffMs);
  } else {
    backoffMs = POLL_INTERVAL_MS;
  }

  nextPollAt = millis() + backoffMs;
}
