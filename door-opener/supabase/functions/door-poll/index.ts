// door-poll: the ESP32's end of the mailbox.
//
// The device polls this every 2 seconds and gets back either nothing or
// one command id, which it turns into a one second relay pulse. Polling
// rather than Realtime is deliberate: a websocket on an ESP32 needs
// reconnect handling that fails in exactly the situations you need the
// door to work in, and a router reboot costs this loop one poll.
//
// The device authenticates with DOOR_DEVICE_KEY and holds no Supabase key
// at all, so it cannot read the passes table even if the key walks off in
// someone's pocket. Rotate it independently of the dashboard key.
//
// Deploy:
//   supabase functions deploy door-poll --no-verify-jwt
//   supabase secrets set DOOR_DEVICE_KEY=...

import { json, keyMatches, rpc } from "../_shared/door.ts";

const DEVICE_KEY = Deno.env.get("DOOR_DEVICE_KEY");

type ClaimRow = { command_id: number };

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ open: false }, 405);

  if (!keyMatches(req.headers.get("x-device-key"), DEVICE_KEY)) {
    return json({ open: false }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const device = typeof body?.device === "string" ? body.device.slice(0, 64) : "esp32";

    // One command, claimed atomically. If a second poller existed it would
    // either get a different row or nothing, never this one again.
    const rows = await rpc<ClaimRow[]>("door_claim", { p_device: device });

    if (rows.length === 0) return json({ open: false });
    return json({ open: true, command_id: rows[0].command_id });
  } catch (err) {
    console.error("door-poll failed:", err instanceof Error ? err.message : err);
    // Fail closed. A poll that cannot reach the database must never read
    // as an open.
    return json({ open: false }, 500);
  }
});
