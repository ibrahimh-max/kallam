-- Backend-managed email ownership verification and password recovery.
-- Raw action tokens are never stored; only their SHA-256 hashes reach Postgres.

alter table public.auth_credentials
  add column if not exists email_verified_at timestamptz;

create table if not exists public.auth_action_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  purpose text not null check (purpose in ('verify_email', 'password_recovery')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists auth_action_tokens_user_purpose_idx
  on public.auth_action_tokens (user_id, purpose);
create index if not exists auth_action_tokens_expires_at_idx
  on public.auth_action_tokens (expires_at);

alter table public.auth_action_tokens enable row level security;
revoke all privileges on table public.auth_action_tokens from public, anon, authenticated;
grant all privileges on table public.auth_action_tokens to service_role;
