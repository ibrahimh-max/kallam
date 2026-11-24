-- Shared fixed-window rate limits for multi-instance API deployments.
-- Bucket identifiers are HMACed by the API before they reach this table, so
-- raw IP addresses and learner IDs are not retained here.

create table if not exists public.rate_limit_buckets (
  bucket_hash text primary key check (bucket_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null
);

create index if not exists rate_limit_buckets_expires_at_idx
  on public.rate_limit_buckets (expires_at);

alter table public.rate_limit_buckets enable row level security;
revoke all privileges on table public.rate_limit_buckets from public, anon, authenticated;
grant all privileges on table public.rate_limit_buckets to service_role;

create or replace function public.hit_rate_limit(
  p_bucket_hash text,
  p_window_ms integer,
  p_limit integer,
  p_now_ms bigint
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_now timestamptz;
  v_started timestamptz;
  v_expires timestamptz;
  v_count integer;
begin
  if p_bucket_hash !~ '^[0-9a-f]{64}$'
     or p_window_ms < 1
     or p_window_ms > 3600000
     or p_limit < 1
     or p_limit > 100000
     or p_now_ms < 1 then
    raise exception 'invalid rate-limit arguments' using errcode = '22023';
  end if;

  v_now := to_timestamp(p_now_ms::double precision / 1000.0);

  insert into public.rate_limit_buckets as buckets (
    bucket_hash, window_started_at, request_count, expires_at
  ) values (
    p_bucket_hash, v_now, 1, v_now + p_window_ms * interval '1 millisecond'
  )
  on conflict (bucket_hash) do update
    set window_started_at = case
          when buckets.expires_at <= v_now then v_now
          else buckets.window_started_at
        end,
        request_count = case
          when buckets.expires_at <= v_now then 1
          else buckets.request_count + 1
        end,
        expires_at = case
          when buckets.expires_at <= v_now then v_now + p_window_ms * interval '1 millisecond'
          else buckets.expires_at
        end
  returning buckets.window_started_at, buckets.request_count, buckets.expires_at
       into v_started, v_count, v_expires;

  if random() < 0.01 then
    delete from public.rate_limit_buckets
    where bucket_hash in (
      select expired.bucket_hash
      from public.rate_limit_buckets as expired
      where expired.expires_at < v_now - interval '1 hour'
      limit 100
    );
  end if;

  return query
  select v_count <= p_limit,
         greatest(p_limit - v_count, 0),
         case
           when v_count <= p_limit then 0
           else greatest(1, ceil(extract(epoch from (v_expires - v_now)))::integer)
         end;
end;
$$;

revoke all on function public.hit_rate_limit(text, integer, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer, integer, bigint)
  to service_role;

-- SupabaseRepository.health() runs this with the service-role client so an
-- applied migration set can be distinguished from a merely reachable database.
grant execute on function public.rls_audit() to service_role;
