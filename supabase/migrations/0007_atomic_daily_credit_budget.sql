-- Atomically reserve estimated provider credits across all API instances.
-- The per-user quota check in 0003 remains the source of truth for speaking/TTS
-- limits; this wrapper serializes the shared daily budget check before calling it.

create or replace function public.reserve_usage_with_budget(
  p_user_id uuid,
  p_feature text,
  p_quantity numeric,
  p_credits integer,
  p_provider text,
  p_model text,
  p_request_id text,
  p_day date,
  p_speaking_limit integer,
  p_tts_limit integer,
  p_daily_credit_budget integer
)
returns table (id uuid, allowed boolean, reason text, status text, credits integer)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_existing_id uuid;
  v_existing_status text;
  v_existing_credits integer;
  v_spent bigint;
  v_requested integer := greatest(p_credits, 0);
begin
  if p_daily_credit_budget < 0 then
    raise exception 'daily credit budget must not be negative' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('usage-budget:' || p_day::text, 0));

  -- A replay must return its original reservation even if the budget has since
  -- been reached; it must not be blocked or counted a second time.
  select ue.id, ue.status, ue.credits_estimated
    into v_existing_id, v_existing_status, v_existing_credits
  from public.usage_events ue
  where ue.request_id = p_request_id
    and ue.feature = p_feature
    and ue.user_id = p_user_id
  limit 1;

  if v_existing_id is not null then
    return query select v_existing_id, true, 'ok'::text, v_existing_status, v_existing_credits;
    return;
  end if;

  select coalesce(sum(ue.credits_estimated), 0)
    into v_spent
  from public.usage_events ue
  where ue.day = p_day
    and ue.status <> 'failed';

  if v_requested > 0 and v_spent + v_requested > p_daily_credit_budget then
    return query select gen_random_uuid(), false, 'credit_budget'::text, 'reserved'::text, 0;
    return;
  end if;

  return query
    select * from public.reserve_usage(
      p_user_id,
      p_feature,
      p_quantity,
      p_credits,
      p_provider,
      p_model,
      p_request_id,
      p_day,
      p_speaking_limit,
      p_tts_limit
    );
end;
$$;

revoke all on function public.reserve_usage_with_budget(uuid, text, numeric, integer, text, text, text, date, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.reserve_usage(uuid, text, numeric, integer, text, text, text, date, integer, integer)
  from service_role;
grant execute on function public.reserve_usage_with_budget(uuid, text, numeric, integer, text, text, text, date, integer, integer, integer)
  to service_role;
