-- =============================================================================
-- Server-only credential store + atomic usage reservation
-- =============================================================================
-- Two problems solved here, both about correctness under concurrency.
--
-- 1. auth_credentials
--    Identity lives in Supabase Auth, but the API also stores a scrypt password
--    hash and a rotating refresh-token hash. Those are server secrets: they must
--    never be readable with the anon key, so the table has RLS enabled and zero
--    policies (service-role only), and cascades with the auth user.
--
-- 2. reserve_usage()
--    Quota enforcement cannot be "select count, then insert" from the client: two
--    overlapping speaking requests would both read 9/10 and both insert, and the
--    learner would exceed the free allowance — which is a direct cost leak, not a
--    cosmetic bug. The check and the insert therefore happen in ONE database
--    function, serialised per (user, feature, day) with a transaction-scoped
--    advisory lock. That is what makes the guarantee real rather than hoped for.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- auth_credentials (server-only; RLS enabled with no policies on purpose)
-- -----------------------------------------------------------------------------
create table if not exists public.auth_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Lowercased at write time so lookups are case-insensitive and unambiguous.
  email text not null unique check (email = lower(email) and position('@' in email) > 1),
  password_hash text not null,
  refresh_token_hash text,
  created_at timestamptz not null default now()
);

alter table public.auth_credentials enable row level security;

-- -----------------------------------------------------------------------------
-- reserve_usage
-- -----------------------------------------------------------------------------
-- Mirrors MemoryRepository.reserve exactly, so switching drivers cannot change
-- what a learner is allowed to do:
--   * 'failed' rows are excluded from the counts, because a released reservation
--     must not consume the learner's allowance.
--   * a quota rejection returns allowed=false and inserts NOTHING.
create or replace function public.reserve_usage(
  p_user_id uuid,
  p_feature text,
  p_quantity numeric,
  p_credits integer,
  p_provider text,
  p_model text,
  p_request_id text,
  p_day date,
  p_speaking_limit integer,
  p_tts_limit integer
)
returns table (id uuid, allowed boolean, reason text, status text, credits integer)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_event_id uuid := gen_random_uuid();
  v_used integer;
  v_reason text := 'ok';
  v_allowed boolean := true;
  v_existing_id uuid;
  v_existing_status text;
  v_existing_credits integer;
begin
  if p_feature not in ('stt', 'tts', 'evaluation') then
    raise exception 'unsupported feature: %', p_feature using errcode = '22023';
  end if;

  -- Serialise reservations for this learner, feature and day. The lock is
  -- released automatically when the surrounding transaction ends.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_feature || ':' || p_day::text, 0));

  -- Replay of an identical request id: return the original row rather than
  -- double-reserving, so a retried HTTP request cannot cost the learner twice.
  select ue.id, ue.status, ue.credits_estimated
    into v_existing_id, v_existing_status, v_existing_credits
  from usage_events ue
  where ue.request_id = p_request_id
    and ue.feature = p_feature
    and ue.user_id = p_user_id
  limit 1;

  if v_existing_id is not null then
    return query select v_existing_id, true, 'ok'::text, v_existing_status, v_existing_credits;
    return;
  end if;

  if p_feature = 'stt' then
    select count(*) into v_used
    from usage_events ue
    where ue.user_id = p_user_id
      and ue.day = p_day
      and ue.feature = 'stt'
      and ue.status <> 'failed';
    if v_used >= p_speaking_limit then
      v_allowed := false;
      v_reason := 'speaking_quota';
    end if;
  elsif p_feature = 'tts' then
    select count(*) into v_used
    from usage_events ue
    where ue.user_id = p_user_id
      and ue.day = p_day
      and ue.feature = 'tts'
      and ue.status <> 'failed';
    if v_used >= p_tts_limit then
      v_allowed := false;
      v_reason := 'tts_quota';
    end if;
  end if;

  if not v_allowed then
    -- Nothing is written when the learner is over quota.
    return query select v_event_id, false, v_reason, 'reserved'::text, 0;
    return;
  end if;

  insert into usage_events (
    id, user_id, provider, feature, model, usage_quantity, credits_estimated,
    cache_hit, request_id, status, day
  ) values (
    v_event_id, p_user_id, p_provider, p_feature, p_model, p_quantity, greatest(p_credits, 0),
    false, p_request_id, 'reserved', p_day
  );

  return query select v_event_id, true, 'ok'::text, 'reserved'::text, greatest(p_credits, 0);
end;
$$;

revoke all on function public.reserve_usage(uuid, text, numeric, integer, text, text, text, date, integer, integer)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- settle_usage
-- -----------------------------------------------------------------------------
-- A released reservation ('failed') is zeroed, matching MemoryRepository.settle.
-- Without this a provider outage would still burn the learner's credit counter.
create or replace function public.settle_usage(
  p_event_id uuid,
  p_status text,
  p_cache_hit boolean,
  p_credits integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_status not in ('reserved', 'succeeded', 'failed') then
    raise exception 'unsupported status: %', p_status using errcode = '22023';
  end if;

  update usage_events
     set status = p_status,
         cache_hit = coalesce(p_cache_hit, cache_hit),
         credits_estimated = case
           when p_status = 'failed' then 0
           when p_credits is null then credits_estimated
           else greatest(p_credits, 0)
         end
   where id = p_event_id;
end;
$$;

revoke all on function public.settle_usage(uuid, text, boolean, integer)
  from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- touch_tts_cache
-- -----------------------------------------------------------------------------
-- Increments the hit counter inside SQL. A read-modify-write in application code
-- would lose increments when two requests hit the same cached phrase at once, and
-- the hit count is the evidence for how many credits caching actually saved.
create or replace function public.touch_tts_cache(p_cache_key text, p_at timestamptz)
returns void
language sql
security definer
set search_path = public, pg_catalog
as $$
  update tts_cache
     set hits = hits + 1,
         last_used_at = p_at
   where cache_key = p_cache_key;
$$;

revoke all on function public.touch_tts_cache(text, timestamptz)
  from public, anon, authenticated;

-- The Node API uses the server-only service role. Revoking PUBLIC is the safe
-- default, but it also means that role must be granted explicitly; otherwise
-- every Supabase reservation, settlement and cache-hit update fails with
-- permission denied even though the in-memory tests pass.
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
grant execute on function public.reserve_usage(uuid, text, numeric, integer, text, text, text, date, integer, integer)
  to service_role;
grant execute on function public.settle_usage(uuid, text, boolean, integer)
  to service_role;
grant execute on function public.touch_tts_cache(text, timestamptz)
  to service_role;
