// door-open: the only public endpoint.
//
//   page -> here -> queue a command row -> ESP32 picks it up
//
// The browser posts characters and gets back a verdict. It never sees a
// hash, never sees a pass id, and decides nothing. Everything below runs
// server side.
//
// Deploy:
//   supabase functions deploy door-open --no-verify-jwt
//
// --no-verify-jwt is required: this endpoint is reached by a guest with no
// Supabase account and no token. Its authentication is the pass itself.

import {
  clientIp,
  corsHeaders,
  hexToBytes,
  json,
  pbkdf2,
  rpc,
  timingSafeEqual,
} from "../_shared/door.ts";

// Queued commands die after this. A request captured off the wire cannot
// be replayed into an open a minute later, because there is nothing left
// to claim.
const COMMAND_TTL_SECONDS = 30;

// Lock out an IP after this many failures inside the window. A six or
// eight character pass with no lockout is brute forced in an afternoon.
const MAX_FAILURES_PER_IP = 5;
const LOCKOUT_WINDOW_SECONDS = 900;

// Backstop for someone rotating IPs, which defeats the per IP lockout
// entirely. Set high enough that ordinary use never reaches it.
const MAX_FAILURES_GLOBAL = 30;

// Nothing legitimate is longer than this. Without a cap, a megabyte of
// input would be run through PBKDF2 once per stored pass.
const MAX_PASS_LENGTH = 64;

type Candidate = { id: string; salt: string; hash: string; iterations: number };
type ConsumeRow = {
  outcome: string;
  command_id: number | null;
  label: string | null;
  valid_from: string | null;
  valid_until: string | null;
};

/**
 * The keypad only emits characters from the pass alphabet, but people also
 * type, and they add spaces and dashes when a pass is written down. Strip
 * to letters and digits and upper case it. make-pass.js hashes the same
 * normalised form, so the two always agree.
 */
function normalise(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, reason: "error" }, 405);

  const ip = clientIp(req);

  try {
    let pass = "";
    try {
      const body = await req.json();
      pass = typeof body?.pass === "string" ? normalise(body.pass) : "";
    } catch {
      pass = "";
    }

    if (!pass || pass.length > MAX_PASS_LENGTH) {
      await rpc("door_log_attempt", { p_ip: ip, p_outcome: "unknown" });
      return json({ ok: false, reason: "unknown" });
    }

    // Lockout first, before any hashing. Being locked out is not a secret:
    // the person is told, so there is nothing to leak by answering fast.
    const locked = await rpc<boolean>("door_ip_locked", {
      p_ip: ip,
      p_max_failures: MAX_FAILURES_PER_IP,
      p_window_seconds: LOCKOUT_WINDOW_SECONDS,
    });
    if (locked) {
      await rpc("door_log_attempt", { p_ip: ip, p_outcome: "locked_out" });
      return json({ ok: false, reason: "locked_out", retry_after: LOCKOUT_WINDOW_SECONDS }, 429);
    }

    const throttled = await rpc<boolean>("door_globally_throttled", {
      p_max_failures: MAX_FAILURES_GLOBAL,
      p_window_seconds: LOCKOUT_WINDOW_SECONDS,
    });
    if (throttled) {
      await rpc("door_log_attempt", { p_ip: ip, p_outcome: "throttled" });
      return json({ ok: false, reason: "throttled", retry_after: LOCKOUT_WINDOW_SECONDS }, 429);
    }

    const candidates = await rpc<Candidate[]>("door_candidates");

    // Every stored pass is hashed and compared, with no break on match.
    // Breaking early would make a pass stored first answer faster than one
    // stored last, which over enough samples says which pass matched.
    let matchedId: string | null = null;
    for (const c of candidates) {
      const derived = await pbkdf2(pass, c.salt, c.iterations);
      if (timingSafeEqual(derived, hexToBytes(c.hash))) matchedId = c.id;
    }

    // With no passes stored at all the loop above costs nothing, and a
    // near instant answer would say so. Burn one round instead.
    if (candidates.length === 0) {
      await pbkdf2(pass, "0".repeat(32), 120000);
    }

    if (!matchedId) {
      await rpc("door_log_attempt", { p_ip: ip, p_outcome: "unknown" });
      return json({ ok: false, reason: "unknown" });
    }

    // The pass is right. Whether it is usable right now is decided in the
    // database, under a row lock, in the same transaction that increments
    // the use counter.
    const rows = await rpc<ConsumeRow[]>("door_consume", {
      p_pass_id: matchedId,
      p_ip: ip,
      p_ttl_seconds: COMMAND_TTL_SECONDS,
    });
    const result = rows[0];

    if (result?.outcome === "opened") {
      return json({ ok: true, reason: "opened", ttl: COMMAND_TTL_SECONDS });
    }

    // Past this point the caller has proved they know a real pass, so
    // telling them why it did not work gives nothing away.
    return json({
      ok: false,
      reason: result?.outcome ?? "unknown",
      valid_from: result?.valid_from ?? null,
      valid_until: result?.valid_until ?? null,
    });
  } catch (err) {
    console.error("door-open failed:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "error" }, 500);
  }
});
