# Release gates and operational limitations

**This project is not production-ready.** The current repository supports local
development and automated tests, but several gates require real credentials,
operator decisions, infrastructure, or human validation.

## Latest browser-first verification (2026-11-24)

- Flutter Web built and ran locally in Chrome against a test-only in-memory API.
  Registration, direct test-token verification, login, onboarding, a complete
  lesson, typed speaking feedback, progress, vocabulary review, logout, and
  re-login were exercised. The lesson completed at 100% comprehension and saved
  three vocabulary items.
- Browser CORS preflight returned 204 for the configured local origin. The local
  backend reported the memory repository and mock voice provider. Mock TTS
  returned WAV audio and browser playback started; this is not live voice quality
  evidence.
- The standalone verification-link page showed a generic failure under browser
  automation even though the same test token verified through the API. Treat the
  email-link page as unverified until that path is reproduced and resolved.
- After the user granted Chrome microphone permission with voice consent active,
  the Web recorder captured an in-memory PCM clip for more than two seconds,
  encoded it as WAV, and completed a round-trip to the local mock speaking API.
  The mock asked for a retry because it did not recognize clear speech. Browser
  permission and capture are verified locally; live speech-recognition quality
  is not. Android/native microphone and physical-device verification remain
  unverified.
- No live Supabase, Resend, or HUMAIN requests were made; no real email was sent
  and no additional paid voice call was made.

## Engineering and security work still required

| Area | Current state | Before public release |
|---|---|---|
| Flutter Web | Local build and the browser journeys listed above passed against the memory/mock backend. The verification-link page remains unresolved; browser mic permission, capture, and the mock speaking round-trip work locally. This is not live-service or device evidence. | Resolve the email-link behavior, then retest against a controlled staging backend. Review live speech-recognition quality separately with owner approval. |
| Registration identity | Backend-managed one-time email verification and password recovery are implemented with generic responses and hashed action tokens. Resend is not configured or live-tested; until it is configured, registration cannot deliver messages. Automated tests cover expiry and single use; only the mock sender was exercised. | Configure a verified Resend sender and secrets, apply migration `0006`, and test delivery/expiry/replay behavior before public release. Do not send real emails without owner authorization. |
| Authentication architecture | The API verifies scrypt password hashes and issues its own short-lived JWTs/rotating opaque refresh tokens. Supabase Auth is only an identity anchor; it does not issue app sessions or own email verification. | Reconcile this custom-auth design with the product spec's Supabase Auth requirement before release. Password-reset access JWTs remain valid until their 15-minute expiry; refresh tokens are revoked immediately. |
| Rate limiting | Memory mode is process-local. Supabase mode now uses migration `0005`'s atomic Postgres RPC with HMACed bucket keys and fails closed on store errors; neither migration nor multi-instance behavior has been verified against a live project. | Apply `0005` and test concurrent limits and database-outage behavior in the owner's Supabase project before horizontal scaling. |
| Retention operations | The server runs retention on startup and every 24 hours; `npm run retention` is also available for an external job. | Configure a durable scheduler, locking for multiple instances, and alerting for failed runs. Verify it against the live database. |
| Off-app deletion | The public page describes an email-based request; no authenticated support workflow exists. | Set a monitored `SUPPORT_EMAIL` and establish a verifiable, auditable deletion procedure. |
| Android identity/signing | The debug identity remains a placeholder. Release tasks reject the placeholder ID and debug signing. | Owner chooses a permanent `ANDROID_APPLICATION_ID` and creates a protected upload keystore; provide the four `ANDROID_KEYSTORE_*`/`ANDROID_KEY_*` environment values only to the release environment. |
| Android toolchain | Work was stopped at the owner's direction in favor of Flutter Web. The previous checks found no usable JDK and missing SDK Command-line Tools; Android project configuration remains intact. No APK, emulator journey, or physical-device journey is verified. | Resume only when requested: install JDK 17 and Android SDK Command-line Tools, configure them for the current shell, accept licenses, then build and test. Exact steps are in [real-device-readiness.md](./real-device-readiness.md). |
| iOS release | The workspace runs on Windows. | Build and test on macOS with Xcode and Apple signing. |
| Supabase | Migrations `0001`–`0006` were reviewed statically for table coverage, RLS posture, grants, and token storage. Credentials were not provided; no live migration, RLS, or repository check was run. The service role bypasses RLS, so API ownership filters remain mandatory. | Provide the project URL and server-only service-role key through a secure secrets channel, apply migrations `0001`–`0006`, then verify repository/auth operations, RLS, rate-limit RPC, refresh rotation, and retention. See [real-device-readiness.md](./real-device-readiness.md). |
| HUMAIN | Real provider adapter remains available; automated tests use the mock provider. | Confirm account-region and commercial terms, then perform only owner-approved human-quality and cost validation. Do not spend more credits without approval. |

## Human validation still outstanding

- Saudi learner interviews and prototype sessions.
- Native Saudi listener review of the selected voices and Arabic explanations.
- The specified 20-speaker / 100-utterance speech-recognition set across quiet,
  noisy, and device conditions.
- Human-reviewed speech-recognition quality for real learner recordings; the
  local mock response is not evidence of recognition accuracy.
- Human-reviewed correction quality and willingness-to-pay study.
- The 100-attempt credit study (requires separate approval).
- The physical Android device journey, including microphone permission, real recording,
  audio playback, and restart persistence. The configured AVD is not a physical device.

Do not fabricate results or claim the Milestone 0 voice-quality gates have passed.
Milestone 6's live conversational tutor remains deferred until the turn-based MVP
is validated and its separate provider budget is approved.
