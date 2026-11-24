# Project Initialization Audit — Saudi English Tutor

**Date:** 2026-11-23
**Status:** Audit complete. No implementation code written. Awaiting product-owner go-ahead for Milestone 0.
**Source of truth:** `build (1).md` (v1.1), cross-checked against the live HUMAIN Voice documentation.

This file is a durable record of the audit. The same content was reported in chat.

---

## 1. Product understanding

A mobile app teaching English to Saudi Arabic speakers, where **explanations and corrections are in
Saudi Arabic** and the practised sentence is English.

Core loop: *understand in Saudi Arabic → listen in English → speak English → get corrected in Saudi
Arabic → practise again.*

Explicitly not a chatbot, not a game-heavy clone. MVP = 3–7 minute structured lessons plus short
speaking turns. Audience: adult/older-teen beginners, 18+ for the first release (avoids child-safety
and parental-consent obligations). Product non-goals per spec: no full curriculum, no social
network, no always-on AI conversation, no raw-recording storage by default.

## 2. Architecture to be implemented

```
Flutter app (Android / iOS)
  |  HTTPS + the learner's own token. Never holds a provider key.
  v
Node.js + TypeScript backend        <- sole holder of the HUMAIN key
  +-- Supabase Auth + PostgreSQL (RLS on every user-owned table)
  +-- HUMAIN Voice: short-clip STT + cached TTS
  +-- usage ledger, quotas, cost guardrails
```

Three protecting choices:

- **`VoiceProvider` interface** behind the backend. Lesson logic never sees a HUMAIN-shaped object,
  so the provider can be replaced without touching the learning application.
- **Data-access interface** in front of Supabase, so Milestone 1 can be built and tested while no
  Supabase project exists.
- **Provider calls are server-side only.** The key lives in `server/.env` (git-ignored). The master
  key can never reach the app bundle.

## 3. Current directory state (observed, not assumed)

Workspace contains **one file**: `build (1).md`. Greenfield: nothing to preserve or overwrite.

Detected toolchain:

| Tool | State |
|---|---|
| Flutter 3.41.7 / Dart 3.11.5 | installed |
| Node 24.15.0 / npm 11.12.1 | installed (satisfies provider "Node 24 or newer") |
| Docker Desktop, Vercel CLI, Chrome | installed |
| Android cmdline-tools | MISSING (flagged by `flutter doctor`) |
| Java / JDK | not on PATH — Android Gradle builds will fail |
| adb | not on PATH — no device/emulator access |
| iOS toolchain | impossible on Windows (needs macOS + Xcode) |
| Supabase CLI, psql | not installed |

## 4. Missing prerequisites and external credentials

Owner supplies `HUMAIN_API_KEY` and `HUMAIN_API_URL` in `server/.env`.

Safety of that location is **verified by an executable check**
(`tools/checks/security-guard.mjs`), not by inspection:

- `git check-ignore -v server/.env` matches `.gitignore:2:.env`
- `git add -A --dry-run` stages `server/.env.example` and never `server/.env`

| Missing | Blocking? | Notes |
|---|---|---|
| Supabase project | Not M1 | Schema + RLS as repo migrations behind an interface |
| Android cmdline-tools + JDK | M1 verification | Cannot build/verify Android on this machine without them |
| Physical Android phone | Beta / M4 | Spec requires real-device testing |
| macOS + Xcode | M1 acceptance #1 | "Same codebase builds for iOS" is unverifiable from Windows |
| Backend host + region | M3 | Region has PDPL / cross-border implications |
| Play Console, Apple Developer | M5 | Paid accounts — require explicit approval |
| Privacy policy URL + public web deletion page | M5 | Play requires a *web* deletion link, not only in-app |
| Saudi legal/privacy review | Launch gate | Owner action |

## 5. Contradictions and technical risks found in the specification

Ordered by potential damage. "Docs" = live HUMAIN Voice developer documentation.

**R1 — HIGH: the low-confidence rule has nothing to detect.** Spec wants
`422 LOW_CONFIDENCE` at confidence < 0.5. The short-clip endpoint returns NDJSON records with
`transcription`, `words`, `is_final` only — **no confidence field exists**. Building the spec
literally produces a rule that can never fire. *Needs a product decision.*

**R2 — HIGH: "TTS time-to-first-audio <= 3 s" is unreachable via the buffered route.** The buffered
speech endpoint "buffers the whole clip before it answers" and never streams. A streaming Socket.IO
path exists (raw PCM). Milestone 0's target must be re-based on measurement, or the streaming route
adopted. *Needs a product decision.*

**R3 — HIGH: the voice IDs in the spec are display labels, not sendable IDs.** The documented value
to send is a **profile UUID that differs per environment**, and there is **no HTTP voice-list route**
— voices are listed over Socket.IO. Voice configuration must therefore be resolved at runtime and
cached; the adapter needs a Socket.IO dependency for that lookup alone.

**R4 — HIGH: M4A recordings may be rejected outright.** The spec's example upload is `audio/m4a`.
Accepted containers are WAV, FLAC, MP3, AAC-ADTS and the MP4 family, of which the docs state **only
MP4 is tested and intended**, and require the **`moov` atom at the FRONT** of the file because the
upload is read forward-only. Many phone recorders write `moov` at the end. The recorder must be
configured for a front-`moov` container or the core speaking flow fails on real devices.

**R5 — MEDIUM: `credits_consumed` cannot be read from the response.** The spec's schemas show it; the
provider response has no such field. The usage ledger must estimate locally (audio seconds,
character counts) and be reconciled against the console Usage page.

**R6 — MEDIUM: the provider cannot provide idempotency.** Short-clip STT has "no idempotency or
replay contract" and warns against blind resubmission; the buffered TTS `Idempotency-Key` is "best
effort", scoped to one pod's memory for ~10 minutes. Our attempt IDs and database state must be the
source of truth for "did this already happen".

**R7 — MEDIUM: two spec request fields are not real parameters.** `mime_type` is decorative — the
provider identifies the container from the payload itself, "never from a filename or a media type"
— so validating a client-declared MIME string proves nothing; the real contract is a decoded
container check plus `ASR_UNSUPPORTED_CODEC`. TTS accepts **no `language` field**: Arabic vs English
is selected by whether the text contains Arabic script.

**R8 — LOW: the 2 MB / 15-second limits are our policy, not the provider's.** Provider allows 64 MiB
and 30 minutes. The tighter limits are correct, but must be presented as our policy in our own
error messages.

**R9 — Confirmations.** Voice Agent is beta and needs the `agent` scope enabled on the key: correctly
excluded from MVP. Riverpod/Bloc choice is consistent. "Transcript matching is not pronunciation
assessment" matches the docs exactly.

**R10 — Gap in the endpoint list.** No endpoint lets the app discover voices, and no provider HTTP
voice-list route exists. Backend must expose `GET /v1/voices` (cached, server-side).

## 6. Implementation sequence (aligned to spec milestones)

**Milestone 0 — prove the voice layer before trusting it** *(recommended first step)*
1. Verify connectivity — documented no-file probe creates no job, consumes no credits.
2. Probe capability by capability (short-clip STT, TTS, batch informational); never assume an active
   key grants all three; treat `403` as a finding.
3. Resolve the account's real voice UUIDs; identify Saudi Arabic (`ars`) and bilingual `ar,en` voices.
4. *(spends credits — needs approval)* Small controlled measurements: latency and real credit deltas
   from generated phrases; word accuracy needs owner-recorded Saudi-accented English samples.
5. Report latency, transcription results, estimated remaining credits, and R1/R2 resolved with data.

**Milestone 1 — mobile + backend foundation** *(approved; stops for owner review)*
Flutter scaffold with Riverpod, Arabic-first RTL theming, routing; thin TS backend with auth
middleware, input validation, rate limiting, `VoiceProvider` + real HUMAIN adapter; Supabase schema
and RLS as migrations behind a data interface; onboarding, login, profile.

**Milestone 2 — learning engine.** Lesson format, home and lesson screens, cached audio playback,
vocabulary, progress, seed lessons.

**Milestone 3 — speaking MVP.** Recording with front-`moov` container (R4), secure upload, STT,
deterministic evaluation, TTS feedback, quotas, usage ledger with `cache_hit`, audio deletion.

**Milestone 4 — beta and validation.** 20–50 learners, WER protocol, cost per active learner.

**Milestone 5 — public release.** Privacy policy (AR + EN), public web deletion page, store assets
and declarations.

## 7. First files to be created (Milestone 0 only)

| File | Purpose |
|---|---|
| `tools/validation/README.md` | How to run, what it spends, what each step proves |
| `tools/validation/src/env.ts` | Loads `server/.env`; fails loudly if key absent; never logs the value |
| `tools/validation/src/connectivity.ts` | Step 1 — zero-credit key check |
| `tools/validation/src/capabilities.ts` | Step 2 — per-capability probe; classifies 401/402/403 as findings |
| `tools/validation/src/voices.ts` | Step 3 — resolves real voice UUIDs; flags Saudi `ars` voices |
| `tools/validation/src/measure.ts` | Step 4 — credit-budgeted measurement run (gated) |
| `tools/validation/src/report.ts` | Step 5 — evidence report + credit estimate |
| `server/src/services/voice/VoiceProvider.ts` | Provider interface the application depends on |
| `server/src/services/voice/HumainVoiceProvider.ts` | Real adapter implementing that interface |

## 8. Open decisions put to the owner

1. **R1 — no confidence signal.** Recommendation: keep the speaking turn bounded and deterministic;
   if the transcript is empty, too short, or fails the expected-intent match, respond "let's try
   that again" in Arabic and **never invent a correction**. Preserves the spec's "do not confidently
   invent a correction from unclear audio" rule without a confidence number.
2. **R2 — latency target.** Recommendation: measure full buffered-synthesis time and set an honest
   target from measurement; do not adopt streaming yet.
