// door-admin: create, edit and delete passes from tools/manage.html.
//
// The repo managed passes with SQL alone for a long time, and everything
// still can. This exists so the page on your own machine can do the same
// edits over HTTPS rather than by handing you statements to paste.
//
// What it deliberately does not do:
//
//   * It never sees a pass. manage.html derives the salt and PBKDF2 hash in
//     the browser and sends those, so "create" takes a hash and has no idea
//     what the plaintext was. Nothing here can leak what it never receives.
//   * It never returns a hash. Listing goes through door_admin_list, which
//     reads door_pass_status, and that view has never carried salt or hash.
//   * It cannot open the door. There is no path from here to door_consume
//     or door_claim, the same way door-events has no path to either.
//
// Authenticated with DOOR_ADMIN_KEY, a third key on top of the device and
// dashboard ones, so it rotates on its own. This is the most powerful of
// the three: it can mint a working pass. Treat it like a front door key.
//
// Deploy:
//   supabase functions deploy door-admin --no-verify-jwt
//   supabase secrets set DOOR_ADMIN_KEY=...

import { json, keyMatches, rpc } from "../_shared/door.ts";

const ADMIN_KEY = Deno.env.get("DOOR_ADMIN_KEY");

// Deliberately not DOOR_ALLOWED_ORIGIN. That one is narrowed to the Netlify
// page, and manage.html is opened from a file:// URL, which sends
// `Origin: null` and would be refused by it. CORS is not what protects this
// endpoint in any case: the key is, and a browser's origin check does
// nothing about a request that did not come from a browser.
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const MAX_LABEL = 60;
const ITERATIONS = 120000;

type Body = {
  action?: string;
  id?: string;
  label?: string;
  kind?: string;
  salt?: string;
  hash?: string;
  valid_from?: string | null;
  valid_until?: string | null;
  max_uses?: number | null;
  off?: boolean;
};

function fail(reason: string, status = 400): Response {
  return json({ ok: false, reason }, status, CORS);
}

/** Rejects anything that is not a plain uuid, before it reaches Postgres. */
function uuid(value: unknown): string | null {
  return typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

/** null stays null: it is how "no window" and "unlimited" are expressed. */
function when(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return fail("method", 405);

  if (!keyMatches(req.headers.get("x-admin-key"), ADMIN_KEY)) {
    return fail("unauthorised", 401);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return fail("bad_json");
  }

  try {
    switch (body.action) {
      case "list":
        return json({ ok: true, passes: await rpc("door_admin_list") }, 200, CORS);

      case "create": {
        const label = (body.label ?? "").trim();
        if (!label) return fail("label_required");
        if (label.length > MAX_LABEL) return fail("label_too_long");
        if (body.kind !== "resident" && body.kind !== "guest") return fail("bad_kind");
        // The page derives these. Checked here anyway, because this is the
        // boundary and the page is not the only thing that can call it.
        if (typeof body.salt !== "string" || !/^[0-9a-f]{32,}$/.test(body.salt)) return fail("bad_salt");
        if (typeof body.hash !== "string" || !/^[0-9a-f]{64}$/.test(body.hash)) return fail("bad_hash");

        const id = await rpc<string>("door_admin_create", {
          p_label: label,
          p_kind: body.kind,
          p_salt: body.salt,
          p_hash: body.hash,
          p_iterations: ITERATIONS,
          p_valid_from: when(body.valid_from),
          p_valid_until: when(body.valid_until),
          p_max_uses: typeof body.max_uses === "number" && body.max_uses > 0 ? body.max_uses : null,
        });
        return json({ ok: true, id }, 200, CORS);
      }

      case "revoke": {
        const id = uuid(body.id);
        if (!id) return fail("bad_id");
        const rows = await rpc<number>("door_admin_revoke", { p_id: id, p_off: body.off !== false });
        return json({ ok: rows > 0, rows }, 200, CORS);
      }

      case "window": {
        const id = uuid(body.id);
        if (!id) return fail("bad_id");
        const rows = await rpc<number>("door_admin_window", {
          p_id: id,
          p_valid_from: when(body.valid_from),
          p_valid_until: when(body.valid_until),
        });
        return json({ ok: rows > 0, rows }, 200, CORS);
      }

      case "uses": {
        const id = uuid(body.id);
        if (!id) return fail("bad_id");
        const rows = await rpc<number>("door_admin_uses", {
          p_id: id,
          p_max_uses: typeof body.max_uses === "number" && body.max_uses > 0 ? body.max_uses : null,
        });
        return json({ ok: rows > 0, rows }, 200, CORS);
      }

      case "delete": {
        const id = uuid(body.id);
        if (!id) return fail("bad_id");
        const rows = await rpc<number>("door_admin_delete", { p_id: id });
        return json({ ok: rows > 0, rows }, 200, CORS);
      }

      default:
        return fail("unknown_action");
    }
  } catch (err) {
    // The message can carry a Postgres error, which is useful here: the
    // caller already proved they hold the admin key, and "guest passes must
    // expire" is a great deal more helpful than "error".
    const message = err instanceof Error ? err.message : String(err);
    console.error("door-admin failed:", message);
    return json({ ok: false, reason: "error", detail: message }, 500, CORS);
  }
});
