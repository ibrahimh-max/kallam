-- =============================================================================
-- Row Level Security (build (1).md §7.2 / §10)
-- =============================================================================
-- These policies prepare for authenticated Supabase clients and provide a
-- database boundary if direct client access is introduced. The current mobile app
-- talks only to the API, whose service-role key bypasses RLS; API user scoping is
-- therefore mandatory and must not be delegated to these policies.
--
-- The current mobile app does not ship a Supabase key. Keep RLS enabled so future
-- direct access is deny-by-default, and audit it, but do not claim it constrains
-- service-role queries.
--
-- Default posture: DENY. Every table is enabled and then granted back explicitly,
-- so a table added without a policy is unreadable rather than world-readable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere. Table owners and BYPASSRLS roles (including service_role)
-- can still bypass it, so the trusted API must enforce account ownership.
-- -----------------------------------------------------------------------------
alter table public.profiles              enable row level security;
alter table public.lessons               enable row level security;
alter table public.lesson_attempts       enable row level security;
alter table public.speaking_attempts     enable row level security;
alter table public.vocabulary            enable row level security;
alter table public.usage_events          enable row level security;
alter table public.consents              enable row level security;
alter table public.tts_cache             enable row level security;
alter table public.idempotency_records   enable row level security;

-- =============================================================================
-- profiles
-- =============================================================================
-- A learner may read and update only their own profile. INSERT is granted because
-- the app can bootstrap a profile right after signup; the id must equal the
-- authenticated user, so nobody can create a row for someone else.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No DELETE policy: rows are removed by the ON DELETE CASCADE when the auth user
-- is deleted, or by the retention job. A learner cannot hard-delete a profile row
-- directly, which keeps the consent/retention trail consistent.

-- =============================================================================
-- lessons
-- =============================================================================
-- Published lesson content is readable by any signed-in learner. Content is
-- authored in the repository and seeded with the service role, so there is no
-- client-side INSERT/UPDATE/DELETE policy at all: lesson content is not
-- user-writable, and RLS enforces that claim instead of trusting the API.
drop policy if exists lessons_select_published on public.lessons;
create policy lessons_select_published on public.lessons
  for select to authenticated
  using (published = true);

-- =============================================================================
-- lesson_attempts
-- =============================================================================
drop policy if exists lesson_attempts_select_own on public.lesson_attempts;
create policy lesson_attempts_select_own on public.lesson_attempts
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists lesson_attempts_insert_own on public.lesson_attempts;
create policy lesson_attempts_insert_own on public.lesson_attempts
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists lesson_attempts_update_own on public.lesson_attempts;
create policy lesson_attempts_update_own on public.lesson_attempts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists lesson_attempts_delete_own on public.lesson_attempts;
create policy lesson_attempts_delete_own on public.lesson_attempts
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- =============================================================================
-- speaking_attempts
-- =============================================================================
drop policy if exists speaking_attempts_select_own on public.speaking_attempts;
create policy speaking_attempts_select_own on public.speaking_attempts
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists speaking_attempts_insert_own on public.speaking_attempts;
create policy speaking_attempts_insert_own on public.speaking_attempts
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists speaking_attempts_delete_own on public.speaking_attempts;
create policy speaking_attempts_delete_own on public.speaking_attempts
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- UPDATE is deliberately absent: a stored evaluation or transcript is an
-- immutable record of what was said. Retention clears them server-side.

-- =============================================================================
-- vocabulary
-- =============================================================================
drop policy if exists vocabulary_select_own on public.vocabulary;
create policy vocabulary_select_own on public.vocabulary
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists vocabulary_insert_own on public.vocabulary;
create policy vocabulary_insert_own on public.vocabulary
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists vocabulary_update_own on public.vocabulary;
create policy vocabulary_update_own on public.vocabulary
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists vocabulary_delete_own on public.vocabulary;
create policy vocabulary_delete_own on public.vocabulary
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- =============================================================================
-- usage_events
-- =============================================================================
-- Read-only for the learner (a "your usage" view may need it). No write policy:
-- the ledger is written exclusively by the server through the service role, so a
-- compromised client cannot forge or erase spend history, which is the whole
-- point of a cost-attribution ledger.
drop policy if exists usage_events_select_own on public.usage_events;
create policy usage_events_select_own on public.usage_events
  for select to authenticated
  using (user_id = (select auth.uid()));

-- =============================================================================
-- consents
-- =============================================================================
-- Consent is user-facing and auditable. Learners may read their own history, but
-- all grants and withdrawals must go through the authenticated backend so a
-- modified client cannot forge consent or edit policy versions.
drop policy if exists consents_select_own on public.consents;
create policy consents_select_own on public.consents
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists consents_insert_own on public.consents;
drop policy if exists consents_update_own on public.consents;

-- =============================================================================
-- tts_cache
-- =============================================================================
-- No policy for `authenticated`. Cached lesson audio is served through the API,
-- which checks consent and lesson authorisation first; the table is not exposed
-- to clients at all. With RLS enabled and zero policies, only the service role
-- can read it. This is the deny-by-default posture working as intended.
--
-- (No policies created here on purpose — do not add one without a server route
-- that enforces the consent gate.)

-- =============================================================================
-- idempotency_records
-- =============================================================================
-- Server-only for the same reason as tts_cache: exposing stored responses to a
-- client would leak another request's payload if a key were ever guessed.
-- RLS enabled, no policies.

-- =============================================================================
-- Verification helper
-- =============================================================================
-- `select * from public.rls_audit()` returns every public table that exists
-- without RLS enabled. It is used by the repository's security check so a future
-- migration cannot quietly add an unprotected table.
create or replace function public.rls_audit()
returns table (table_name text, rls_enabled boolean, policy_count bigint)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select c.relname::text,
         c.relrowsecurity,
         (select count(*) from pg_policy p where p.polrelid = c.oid)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname not like 'pg_%'
  order by c.relname;
$$;

revoke all on function public.rls_audit() from public, anon, authenticated;
