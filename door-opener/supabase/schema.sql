-- Door opener schema.
--
-- Run this once in the Supabase SQL editor, or with:
--   supabase db push
--
-- Design notes that matter:
--
--  * RLS is on for every table and there is not a single policy. That means
--    anon and authenticated can read and write nothing at all. Only the
--    service role key, which lives in the Edge Functions and nowhere else,
--    reaches these tables. The ESP32 and the home controller never hold a
--    Supabase key: they hold their own keys, which only their own Edge
--    Function accepts.
--
--  * The functions are SECURITY DEFINER so they can work under that RLS,
--    and EXECUTE is revoked from anon and authenticated, so leaking the
--    anon key still gets you nothing.
--
--  * Pass hashes are PBKDF2-SHA256 and are computed in the Edge Function,
--    not here. Postgres cannot do PBKDF2-SHA256 without an extension, and
--    putting plaintext passes into SQL statements would put them in the
--    query log. The database only ever sees a pass id.

-- ── PASSES ────────────────────────────────────────────────────
create table if not exists public.door_passes (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  kind        text not null check (kind in ('resident', 'guest')),

  -- PBKDF2-SHA256. Salt and hash are lowercase hex. Iterations are stored
  -- per pass so the cost can be raised later without invalidating old ones.
  salt        text not null check (salt ~ '^[0-9a-f]{32,}$'),
  hash        text not null check (hash ~ '^[0-9a-f]{64}$'),
  iterations  integer not null check (iterations >= 100000),

  valid_from  timestamptz,
  valid_until timestamptz,

  -- null means unlimited. A guest pass may set this to 1 for a one shot
  -- visitor.
  max_uses    integer check (max_uses is null or max_uses > 0),
  use_count   integer not null default 0,

  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),

  -- A shared pass with no end date is a permanent key sitting in a group
  -- chat. Guest passes must expire. The CLI refuses to generate one, and
  -- this refuses to store one even if you write the INSERT by hand.
  constraint door_passes_guest_must_expire
    check (kind <> 'guest' or valid_until is not null),

  constraint door_passes_window_ordered
    check (valid_from is null or valid_until is null or valid_from < valid_until)
);

comment on table public.door_passes is
  'Door passes. Plaintext is never stored; the CLI prints it once.';

-- ── QUEUED COMMANDS ───────────────────────────────────────────
-- The mailbox the ESP32 pulls from. Nothing forwards a port; the device
-- reaches out. Rows expire in 30 seconds so a captured request cannot be
-- replayed into an open later.
create table if not exists public.door_commands (
  id          bigint generated always as identity primary key,
  pass_id     uuid references public.door_passes(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  claimed_at  timestamptz,
  claimed_by  text
);

-- The claim query orders by id over unclaimed, unexpired rows. Partial
-- index so the poll every 2 seconds stays cheap as the table grows.
create index if not exists door_commands_claimable_idx
  on public.door_commands (id)
  where claimed_at is null;

-- ── ATTEMPT LOG ───────────────────────────────────────────────
-- Every attempt, with IP and outcome. This is also the lockout's memory:
-- door_ip_locked counts failures here.
create table if not exists public.door_attempts (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  ip          text,
  outcome     text not null check (outcome in (
                'opened',        -- pass matched, command queued
                'unknown',       -- no stored pass matched
                'expired',       -- matched, but outside its window
                'not_yet_valid', -- matched, but the window has not started
                'revoked',       -- matched, but turned off
                'used_up',       -- matched, but max_uses reached
                'locked_out',    -- this IP is in its 15 minute cooldown
                'throttled'      -- global limiter tripped
              )),
  -- Denormalised on purpose: the dashboard shows the label of a pass that
  -- may later be deleted, and it must never join back to door_passes.
  pass_label  text,
  pass_id     uuid
);

create index if not exists door_attempts_at_idx on public.door_attempts (at desc);
create index if not exists door_attempts_ip_at_idx on public.door_attempts (ip, at desc);

-- ── LOCK IT ALL DOWN ──────────────────────────────────────────
alter table public.door_passes   enable row level security;
alter table public.door_commands enable row level security;
alter table public.door_attempts enable row level security;

-- Belt and braces: force RLS even for the table owner, so only the
-- service role and the SECURITY DEFINER functions below get through.
alter table public.door_passes   force row level security;
alter table public.door_commands force row level security;
alter table public.door_attempts force row level security;

-- No policies are created. That is deliberate, not an omission.

revoke all on public.door_passes   from anon, authenticated;
revoke all on public.door_commands from anon, authenticated;
revoke all on public.door_attempts from anon, authenticated;

-- ── DEVICE KEYS ───────────────────────────────────────────────
-- Only hashes. The ESP32 reaches door_claim through PostgREST rather than
-- through an Edge Function, because a 2 second poll is 1.3 million calls a
-- month and the REST API is the part with unlimited requests. That means
-- the check that used to live in Deno lives here instead.
--
-- Plain SHA-256, not PBKDF2. These keys are 256 bits of randomness from
-- tools/make-key.js, so there is no dictionary to stretch against; the
-- iteration count on the pass hashes exists because humans type those.
create table if not exists public.door_keys (
  name       text primary key,
  hash       text not null check (hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table public.door_keys enable row level security;
alter table public.door_keys force row level security;
revoke all on public.door_keys from anon, authenticated;

-- ── CLAIM: THE ONLY WAY A COMMAND IS CONSUMED ─────────────────
-- Called by the ESP32 and by nothing else. SELECT ... FOR UPDATE SKIP
-- LOCKED is what makes this safe: the subquery takes a row lock before the
-- UPDATE touches the row, so two pollers racing get two different rows or
-- nothing, never the same one. A claimed row sets claimed_at, and the WHERE
-- clause never sees it again, so one command can never open the door twice.
--
-- EXECUTE is granted to anon, because the board authenticates with the
-- Supabase anon key plus its own device key. The anon key alone is worth
-- nothing here: RLS is on with no policies, anon holds no table grants, and
-- every other function is still revoked from it. Without the device key
-- this returns no rows, which is also exactly what it returns when there is
-- simply nothing waiting, so a wrong key cannot be told apart from a quiet
-- door.
create or replace function public.door_claim(p_device text, p_key text)
returns table (command_id bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.door_keys
     where name = 'device'
       and hash = encode(sha256(coalesce(p_key, '')::bytea), 'hex')
  ) then
    return;
  end if;

  return query
    update public.door_commands c
       set claimed_at = now(),
           claimed_by = left(coalesce(p_device, 'esp32'), 64)
     where c.claimed_at is null
       and c.id = (
         select d.id
           from public.door_commands d
          where d.claimed_at is null
            and d.expires_at > now()
          order by d.id
            for update skip locked
          limit 1
       )
    returning c.id;
end;
$$;

-- ── LOCKOUT ───────────────────────────────────────────────────
-- Failed attempts from one IP inside the window. 'locked_out' and
-- 'throttled' rows are excluded on purpose: if being locked out counted
-- toward the lockout, hammering the door would extend the ban forever and
-- one attacker behind a shared NAT could keep a resident out indefinitely.
-- Excluding them means the rate settles at p_max_failures per window,
-- which is the point.
create or replace function public.door_ip_locked(
  p_ip             text,
  p_max_failures   integer default 5,
  p_window_seconds integer default 900
) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p_ip is not null and count(*) >= p_max_failures, false)
    from public.door_attempts
   where ip = p_ip
     and at > now() - make_interval(secs => p_window_seconds)
     and outcome in ('unknown', 'expired', 'not_yet_valid', 'revoked', 'used_up');
$$;

-- Backstop for an attacker who rotates their source IP. A per IP lockout
-- is worthless against that on its own. The threshold is deliberately
-- higher than the per IP one so ordinary use never reaches it.
create or replace function public.door_globally_throttled(
  p_max_failures   integer default 30,
  p_window_seconds integer default 900
) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*) >= p_max_failures
    from public.door_attempts
   where at > now() - make_interval(secs => p_window_seconds)
     and outcome in ('unknown', 'expired', 'not_yet_valid', 'revoked', 'used_up');
$$;

create or replace function public.door_log_attempt(
  p_ip      text,
  p_outcome text
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.door_attempts (ip, outcome) values (p_ip, p_outcome);
$$;

-- ── CONSUME: WINDOW AND USE COUNT, UNDER ONE LOCK ─────────────
-- The Edge Function has already proved the caller knows this pass. Every
-- decision that can go stale is made here, inside the row lock, in the
-- same transaction that increments the counter. Two guests tapping in the
-- same second on a single use pass serialise on the FOR UPDATE: the first
-- gets 'opened', the second waits, then reads use_count = 1 and gets
-- 'used_up'. Checking in the Edge Function instead would let both through.
create or replace function public.door_consume(
  p_pass_id      uuid,
  p_ip           text,
  p_ttl_seconds  integer default 30
) returns table (
  outcome     text,
  command_id  bigint,
  label       text,
  valid_from  timestamptz,
  valid_until timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pass    public.door_passes;
  v_outcome text;
  v_command bigint;
  v_ttl     integer := least(greatest(coalesce(p_ttl_seconds, 30), 5), 120);
begin
  select * into v_pass
    from public.door_passes
   where id = p_pass_id
     for update;

  if not found then
    v_outcome := 'unknown';
  elsif v_pass.revoked_at is not null then
    v_outcome := 'revoked';
  elsif v_pass.valid_from is not null and now() < v_pass.valid_from then
    v_outcome := 'not_yet_valid';
  elsif v_pass.valid_until is not null and now() >= v_pass.valid_until then
    v_outcome := 'expired';
  elsif v_pass.max_uses is not null and v_pass.use_count >= v_pass.max_uses then
    v_outcome := 'used_up';
  else
    update public.door_passes
       set use_count = use_count + 1
     where id = v_pass.id;

    insert into public.door_commands (pass_id, expires_at)
         values (v_pass.id, now() + make_interval(secs => v_ttl))
      returning id into v_command;

    v_outcome := 'opened';
  end if;

  insert into public.door_attempts (ip, outcome, pass_label, pass_id)
       values (p_ip, v_outcome, v_pass.label, v_pass.id);

  return query
    select v_outcome, v_command, v_pass.label, v_pass.valid_from, v_pass.valid_until;
end;
$$;

-- ── DASHBOARD FEED ────────────────────────────────────────────
-- What the home controller is allowed to see. The IP column is not in it.
-- The living room screen is visible from the couch and from the balcony,
-- and a visitor's IP has no business on it.
create or replace function public.door_recent_events(p_limit integer default 10)
returns table (
  id      bigint,
  at      timestamptz,
  outcome text,
  label   text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.at, a.outcome, a.pass_label
    from public.door_attempts a
   order by a.id desc
   limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

-- ── PRUNING ───────────────────────────────────────────────────
-- Optional. Claimed and expired commands are dead weight, and the attempt
-- log only needs to reach back past the lockout window to do its job.
-- Run it by hand, or from a pg_cron job if you ever want one.
create or replace function public.door_gc(p_keep_days integer default 30)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.door_commands
   where expires_at < now() - interval '1 day';
  delete from public.door_attempts
   where at < now() - make_interval(days => greatest(coalesce(p_keep_days, 30), 1));
$$;

revoke execute on function public.door_claim(text, text)                  from public, authenticated;
revoke execute on function public.door_ip_locked(text, integer, integer)  from public, anon, authenticated;
revoke execute on function public.door_globally_throttled(integer, integer) from public, anon, authenticated;
revoke execute on function public.door_log_attempt(text, text)            from public, anon, authenticated;
revoke execute on function public.door_consume(uuid, text, integer)       from public, anon, authenticated;
revoke execute on function public.door_recent_events(integer)             from public, anon, authenticated;
revoke execute on function public.door_gc(integer)                        from public, anon, authenticated;

-- The board holds the anon key and its own device key. See door_claim.
grant execute on function public.door_claim(text, text)                    to anon, service_role;
grant execute on function public.door_ip_locked(text, integer, integer)    to service_role;
grant execute on function public.door_globally_throttled(integer, integer) to service_role;
grant execute on function public.door_log_attempt(text, text)              to service_role;
grant execute on function public.door_consume(uuid, text, integer)         to service_role;
grant execute on function public.door_recent_events(integer)               to service_role;

-- ── CANDIDATES FOR THE HASH SCAN ──────────────────────────────
-- Every pass, including revoked and expired ones. The Edge Function must
-- hash against all of them and must not stop at the first match, so that
-- a wrong pass and a nonexistent one take the same time. Revoked rows stay
-- in the scan so a revoked pass can be told apart from a wrong one by the
-- function, which is safe: the holder already proved they knew it.
--
-- Deliberately a function rather than a direct table read, so every path
-- into door_passes goes through something this file can see.
create or replace function public.door_candidates()
returns table (
  id         uuid,
  salt       text,
  hash       text,
  iterations integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.salt, p.hash, p.iterations
    from public.door_passes p
   order by p.created_at;
$$;

revoke execute on function public.door_candidates() from public, anon, authenticated;
grant  execute on function public.door_candidates() to service_role;

-- ── WHICH PASSES ARE LIVE RIGHT NOW ───────────────────────────
-- For the SQL editor. Never granted to anon or authenticated, and it does
-- not select salt or hash, so pasting the output somewhere gives nothing
-- away.
--
--   select * from door_pass_status order by state, label;
--
create or replace view public.door_pass_status as
  select
    p.label,
    p.kind,
    case
      when p.revoked_at is not null                                    then 'revoked'
      when p.valid_from  is not null and now() <  p.valid_from         then 'not yet valid'
      when p.valid_until is not null and now() >= p.valid_until        then 'expired'
      when p.max_uses    is not null and p.use_count >= p.max_uses     then 'used up'
      else 'live'
    end                                                                as state,
    p.valid_from,
    p.valid_until,
    case
      when p.valid_until is null then null
      else p.valid_until - now()
    end                                                                as expires_in,
    p.use_count,
    p.max_uses,
    p.created_at,
    p.revoked_at,
    p.id
  from public.door_passes p;

comment on view public.door_pass_status is
  'Live / expired / revoked state of every pass, evaluated now. No hashes.';

revoke all on public.door_pass_status from anon, authenticated;
grant  select on public.door_pass_status to service_role;

-- ── REVOKING ──────────────────────────────────────────────────
-- Everything here is reachable with SQL alone. To turn a pass off:
--
--   update door_passes set revoked_at = now() where label = 'Sat party';
--
-- Revoke rather than delete. A deleted pass drops out of the constant time
-- scan and its attempts lose their label on the dashboard.
--
-- There is an admin path now, under ADMIN below, but it is additive: it
-- calls the same table through its own key, and nothing above this line
-- depends on it existing.

-- ── ADMIN: THE SAME EDITS, WITHOUT THE SQL EDITOR ─────────────
-- Everything above this line is reachable with SQL alone, and was the whole
-- management surface for a while. These exist so tools/manage.html can do
-- the same edits over HTTPS instead of by copy and paste.
--
-- The reasoning that said "no admin UI" still holds, so this concedes as
-- little as possible to it:
--
--   * No new public endpoint. door-admin sits behind its own key, the same
--     way door-events does, and that key can be rotated on its own.
--   * No service role key in a browser. These are SECURITY DEFINER and
--     granted to service_role only, so the Edge Function is the only thing
--     that can reach them, exactly as with every other function here.
--   * No plaintext leaves the page. manage.html derives the salt and hash
--     in the browser and sends those; door_admin_create never sees a pass,
--     which is why it takes a hash rather than making one.
--   * No hashes come back. door_admin_list returns what door_pass_status
--     returns, and that view has never carried salt or hash.
--
-- What it does concede: a key that can create a working pass now exists
-- outside the database. Treat it like the front door key it is.

create or replace function public.door_admin_list()
returns table (
  id          uuid,
  label       text,
  kind        text,
  state       text,
  valid_from  timestamptz,
  valid_until timestamptz,
  use_count   integer,
  max_uses    integer,
  created_at  timestamptz,
  revoked_at  timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.label, s.kind, s.state, s.valid_from, s.valid_until,
         s.use_count, s.max_uses, s.created_at, s.revoked_at
    from public.door_pass_status s
   order by s.created_at desc;
$$;

-- Takes a salt and hash rather than a pass. The plaintext is derived and
-- shown in the browser and never crosses the wire, so this function cannot
-- leak what it never receives.
--
-- The guest-must-expire constraint on the table still applies, so a guest
-- pass with no end date is refused here exactly as it is in the SQL editor.
create or replace function public.door_admin_create(
  p_label       text,
  p_kind        text,
  p_salt        text,
  p_hash        text,
  p_iterations  integer,
  p_valid_from  timestamptz default null,
  p_valid_until timestamptz default null,
  p_max_uses    integer     default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if coalesce(btrim(p_label), '') = '' then
    raise exception 'label is required';
  end if;

  insert into public.door_passes
    (label, kind, salt, hash, iterations, valid_from, valid_until, max_uses)
  values
    (btrim(p_label), p_kind, p_salt, p_hash, p_iterations,
     p_valid_from, p_valid_until, p_max_uses)
  returning id into v_id;

  return v_id;
end;
$$;

-- Turning a pass off and back on. Separate from the window, because
-- revoking and expiring are different things and conflating them is how
-- you restore a pass and find it still does not work.
create or replace function public.door_admin_revoke(p_id uuid, p_off boolean)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  update public.door_passes
     set revoked_at = case when p_off then now() else null end
   where id = p_id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function public.door_admin_window(
  p_id          uuid,
  p_valid_from  timestamptz,
  p_valid_until timestamptz
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  update public.door_passes
     set valid_from = p_valid_from,
         valid_until = p_valid_until
   where id = p_id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

create or replace function public.door_admin_uses(p_id uuid, p_max_uses integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  update public.door_passes
     set max_uses = p_max_uses
   where id = p_id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Prefer revoking. This is here because the page offers it, and because a
-- pass created by mistake is better gone than kept forever; but a deleted
-- pass drops out of the constant time scan and its rows in the attempt log
-- lose their label, which revoking does not.
create or replace function public.door_admin_delete(p_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  delete from public.door_passes where id = p_id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.door_admin_list()                         from public, anon, authenticated;
revoke execute on function public.door_admin_create(text, text, text, text, integer, timestamptz, timestamptz, integer)
                                                                            from public, anon, authenticated;
revoke execute on function public.door_admin_revoke(uuid, boolean)          from public, anon, authenticated;
revoke execute on function public.door_admin_window(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.door_admin_uses(uuid, integer)            from public, anon, authenticated;
revoke execute on function public.door_admin_delete(uuid)                   from public, anon, authenticated;

grant execute on function public.door_admin_list()                          to service_role;
grant execute on function public.door_admin_create(text, text, text, text, integer, timestamptz, timestamptz, integer)
                                                                            to service_role;
grant execute on function public.door_admin_revoke(uuid, boolean)           to service_role;
grant execute on function public.door_admin_window(uuid, timestamptz, timestamptz)  to service_role;
grant execute on function public.door_admin_uses(uuid, integer)             to service_role;
grant execute on function public.door_admin_delete(uuid)                    to service_role;
