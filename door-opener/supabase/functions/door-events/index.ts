// door-events: read only feed for the home controller's kiosk panel.
//
// It reads. It cannot claim a command and it cannot open anything. If the
// Node server could claim commands it would race the ESP32 for every press
// and roughly half of them would vanish, so this endpoint has no path to
// door_claim at all.
//
// Authenticated with DOOR_DASHBOARD_KEY, which is a different secret from
// the device key so the two rotate independently. Losing this one leaks a
// list of times and labels, not a way in.
//
// The IP column is not in door_recent_events, so it cannot be returned
// here even by accident. The dashboard is on a living room screen.
//
// Deploy:
//   supabase functions deploy door-events --no-verify-jwt
//   supabase secrets set DOOR_DASHBOARD_KEY=...

import { json, keyMatches, rpc } from "../_shared/door.ts";

const DASHBOARD_KEY = Deno.env.get("DOOR_DASHBOARD_KEY");
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

type EventRow = { id: number; at: string; outcome: string; label: string | null };

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "GET" && req.method !== "POST") return json({ events: [] }, 405);

  if (!keyMatches(req.headers.get("x-dashboard-key"), DASHBOARD_KEY)) {
    return json({ events: [] }, 401);
  }

  try {
    const url = new URL(req.url);
    const asked = parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_LIMIT) : DEFAULT_LIMIT;

    const rows = await rpc<EventRow[]>("door_recent_events", { p_limit: limit });
    return json({ events: rows });
  } catch (err) {
    console.error("door-events failed:", err instanceof Error ? err.message : err);
    return json({ events: [] }, 500);
  }
});
