-- Keep refresh credentials and consent decisions behind the backend service role.
-- This migration also repairs projects that already applied the earlier policies.

alter table public.auth_credentials enable row level security;
revoke all privileges on table public.auth_credentials from public, anon, authenticated;

drop policy if exists consents_insert_own on public.consents;
drop policy if exists consents_update_own on public.consents;
revoke all privileges on table public.consents from public, anon, authenticated;
grant select on table public.consents to authenticated;

create unique index if not exists auth_credentials_refresh_token_hash_idx
  on public.auth_credentials (refresh_token_hash)
  where refresh_token_hash is not null;
