-- =============================================================================
-- Saudi English Tutor — initial schema (build (1).md §8)
-- =============================================================================
-- Design rules applied here, each traceable to the spec:
--   * `auth.users.id` anchors every user-owned table, with ON DELETE CASCADE.
--     The current API verifies passwords and issues its own tokens; it does not
--     use Supabase Auth sessions or email verification.
--   * No raw audio column exists anywhere. build (1).md §10.1 requires recordings
--     to be deleted immediately, and the cheapest way to guarantee that is to have
--     nowhere to write them.
--   * Timestamps are `timestamptz` (UTC). Credits are integers, never floats:
--     they are money-adjacent and must not drift.
--   * Every table is constrained, because a constraint is the one rule that
--     survives a bug in the application layer.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 60),
  preferred_arabic_voice text,
  preferred_english_voice text,
  english_level text check (
    english_level is null
    or english_level in ('complete_beginner', 'few_words', 'simple_understanding', 'basic_conversation')
  ),
  learning_goal text check (
    learning_goal is null or learning_goal in ('everyday', 'work', 'travel', 'study', 'general')
  ),
  daily_goal_minutes integer check (daily_goal_minutes is null or daily_goal_minutes in (5, 10, 15)),
  -- Stamped once, server-side, when onboarding completes. Its presence is what
  -- moves the app from onboarding to home, so a reinstall cannot fake it.
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Set when deletion is requested; the retention job purges after the grace
  -- period (RETENTION_PROFILE_GRACE_DAYS, default 30).
  deleted_at timestamptz
);

-- The retention job scans for accounts past their grace period.
create index if not exists profiles_deleted_at_idx on public.profiles (deleted_at)
  where deleted_at is not null;

-- -----------------------------------------------------------------------------
-- lessons  (content is authored in the repo and seeded; never user-writable)
-- -----------------------------------------------------------------------------
create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9_:-]*$'),
  title text not null,
  title_ar text not null default '',
  description text not null default '',
  level text not null check (level in ('complete_beginner', 'few_words', 'simple_understanding', 'basic_conversation')),
  -- Deliberately free-form: topics are authored per lesson and the topic set grows.
  topic text not null,
  duration_minutes integer not null check (duration_minutes > 0 and duration_minutes <= 60),
  -- Only deterministic evaluation exists in the MVP. `llm_assisted` (Phase 2) is
  -- intentionally not a permitted value yet.
  evaluation_mode text not null default 'deterministic' check (evaluation_mode in ('deterministic')),
  content_json jsonb not null,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  -- Bumped on every content edit; part of the TTS cache version story.
  updated_at timestamptz not null default now()
);

create index if not exists lessons_published_idx on public.lessons (published, created_at);

-- -----------------------------------------------------------------------------
-- lesson_attempts
-- -----------------------------------------------------------------------------
create table if not exists public.lesson_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Null unless a documented rubric produces it. The MVP has no pronunciation
  -- score and this column must not be invented into one.
  score numeric(4, 3) check (score is null or (score >= 0 and score <= 1)),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'abandoned')),
  -- `completed_at` and `status` must agree, so a half-written row cannot claim
  -- completion without a time.
  constraint lesson_attempts_completion_consistent check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

-- "Resume the in-progress attempt for this lesson" is the hot query on start.
create unique index if not exists lesson_attempts_one_in_progress_idx
  on public.lesson_attempts (user_id, lesson_id)
  where status = 'in_progress';

create index if not exists lesson_attempts_user_idx on public.lesson_attempts (user_id, started_at desc);

-- -----------------------------------------------------------------------------
-- speaking_attempts   (no audio column: recordings are never persisted)
-- -----------------------------------------------------------------------------
create table if not exists public.speaking_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  lesson_attempt_id uuid references public.lesson_attempts (id) on delete set null,
  prompt_slug text not null,
  -- Nullable because the retention job clears it after RETENTION_TRANSCRIPT_DAYS.
  transcript text,
  evaluation_json jsonb,
  language_mode text not null check (language_mode in ('english_only', 'arabic_only', 'code_switch')),
  duration_seconds numeric(6, 2) not null check (duration_seconds > 0 and duration_seconds <= 600),
  -- Records when the upload was discarded. In this design audio never reaches
  -- storage, so this is set to the request time.
  audio_deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists speaking_attempts_user_idx on public.speaking_attempts (user_id, created_at desc);
-- Retention clears transcripts and evaluations by age.
create index if not exists speaking_attempts_created_idx on public.speaking_attempts (created_at);

-- -----------------------------------------------------------------------------
-- vocabulary
-- -----------------------------------------------------------------------------
create table if not exists public.vocabulary (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  english_term text not null check (char_length(english_term) between 1 and 200),
  arabic_meaning text not null check (char_length(arabic_meaning) between 1 and 300),
  example_sentence text not null default '',
  review_state text not null default 'new' check (review_state in ('new', 'learning', 'review', 'mastered')),
  next_review_at timestamptz,
  created_at timestamptz not null default now(),
  -- Saving the same term twice from two lessons updates rather than duplicates.
  unique (user_id, english_term)
);

create index if not exists vocabulary_user_idx on public.vocabulary (user_id, created_at desc);
create index if not exists vocabulary_due_idx on public.vocabulary (user_id, next_review_at)
  where next_review_at is not null;

-- -----------------------------------------------------------------------------
-- usage_events  (ledger; contains no audio and no transcript)
-- -----------------------------------------------------------------------------
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  -- Nullable so a provider-level failure can be recorded before a user is known,
  -- and so deleting an account can keep the operator's spend history.
  user_id uuid references auth.users (id) on delete set null,
  provider text not null,
  feature text not null check (feature in ('stt', 'tts', 'evaluation')),
  model text,
  usage_quantity numeric(12, 3) not null default 0 check (usage_quantity >= 0),
  credits_estimated integer not null default 0 check (credits_estimated >= 0),
  -- Critical for TTS cost attribution: a cache hit is 0 credits but still a
  -- request, and conflating the two makes the unit economics unverifiable.
  cache_hit boolean not null default false,
  request_id text not null,
  status text not null default 'reserved' check (status in ('reserved', 'succeeded', 'failed')),
  day date not null default (now() at time zone 'utc')::date,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_user_day_idx on public.usage_events (user_id, day);
create index if not exists usage_events_day_idx on public.usage_events (day);
create index if not exists usage_events_created_idx on public.usage_events (created_at);
-- One reservation per request id per feature, so a retried request cannot double
-- reserve. This is the database half of the atomicity guarantee.
create unique index if not exists usage_events_request_unique_idx
  on public.usage_events (request_id, feature, user_id);
create index if not exists usage_events_tts_cache_idx on public.usage_events (user_id, day, feature, cache_hit);

-- -----------------------------------------------------------------------------
-- consents  (auditable; retained longer than the data it covers)
-- -----------------------------------------------------------------------------
create table if not exists public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  consent_type text not null check (consent_type in ('voice_processing', 'terms_of_service', 'privacy_policy')),
  policy_version text not null,
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  -- A withdrawal cannot precede the grant.
  constraint consents_withdrawal_after_grant check (withdrawn_at is null or withdrawn_at >= granted_at)
);

-- The consent gate on every voice route runs this query.
create index if not exists consents_active_voice_idx
  on public.consents (user_id, consent_type)
  where withdrawn_at is null;

-- -----------------------------------------------------------------------------
-- tts_cache  (non-personal lesson audio; audio bytes live in the row here)
-- -----------------------------------------------------------------------------
create table if not exists public.tts_cache (
  cache_key text primary key,
  text text not null,
  text_hash text not null,
  voice_id text not null,
  model text not null,
  content_type text not null default 'audio/wav' check (content_type = 'audio/wav'),
  audio bytea not null,
  duration_seconds numeric(8, 3) not null default 0 check (duration_seconds >= 0),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  hits integer not null default 0 check (hits >= 0)
);

create index if not exists tts_cache_last_used_idx on public.tts_cache (last_used_at);

-- -----------------------------------------------------------------------------
-- idempotency_records
-- -----------------------------------------------------------------------------
create table if not exists public.idempotency_records (
  -- Scoped by (user, endpoint, key) so one user's key can never collide with
  -- another's, and the same key on two endpoints is two separate operations.
  key text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  request_hash text not null,
  response_json text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, endpoint, key)
);

create index if not exists idempotency_created_idx on public.idempotency_records (created_at);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists lessons_touch_updated_at on public.lessons;
create trigger lessons_touch_updated_at
  before update on public.lessons
  for each row execute function public.touch_updated_at();
