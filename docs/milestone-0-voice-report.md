# Milestone 0 — Voice validation report

Generated: 2026-11-22T21:55:16.709Z

## MEASURED

- Credentials loaded from server/.env: HUMAIN_API_KEY present=true, HUMAIN_API_URL present=true. No values are recorded in this report.
- Batch STT (POST /v1/transcribe/{lang}) answers at the validation layer (400 VALIDATION_FILE_CORRUPT for a multipart body with no file), so the route and key are both live. 0 credits consumed.
- Buffered HTTP TTS (POST /v1/audio/speech) answers at the validation layer (400 VALIDATION_REQUIRED_FIELD for empty input). TTS limits are checked before any charge, so 0 credits consumed.
- Socket.IO handshake succeeds with x-api-key plus Origin: transport is live for voice list, fast STT and streaming TTS.
- POST /v1/realtime/http/stt (short-clip STT) returns 404 at api.voice.humain.com even with the multipart content-type and a fresh id UUID. The route is documented but not deployed on this environment, so it is NOT a usable fallback: the working short-clip path is Socket.IO audio_file.
- Voice list returned 7 profile(s); 4 with Saudi Arabic (ars) dialect: mul_nourah (42e38a63-849a-481a-b5bf-3c1b7a985de3), mul_abdullah (cabd361b-cb91-4eb6-8d35-c8660bf82e7a), mul_sara (19965876-8cd6-4b8c-9af4-35cbec69ff1d), mul_abdulaziz (9bbc9620-a2ff-489b-b292-5007210f49ca).
- Every returned profile speaks both ar and en, so a single voice can serve the bilingual lesson content without switching voices mid-lesson.

### Paid measurement run (owner-approved, ceiling 4 credits)

Ran as `npm run step4 -- --approve --confirm-credits=4`, voice `mul_nourah` (42e38a63-849a-481a-b5bf-3c1b7a985de3).

| measurement | kind | result | latency |
| --- | --- | --- | --- |
| Saudi Arabic greeting (~40 chars) | TTS | ok, 99840 bytes PCM | 2575 ms |
| English lesson sentence (~60 chars) | TTS | ok, 96000 bytes PCM | 2601 ms |
| 2 s synthesised tone, `codeswitch` | STT | ok, `text: ""` | 1690 ms |

- **Batch STT is enabled on this key** — proven by a real billed request, not inferred. The transcript came back empty, which is the correct answer for a 440 Hz tone: the provider does not invent words for non-speech audio. This also confirms the empty-transcript path that R1's deterministic retry turn depends on.
- **Buffered TTS is enabled and returns raw PCM**: 24 kHz mono 16-bit, ~100 KB for a short sentence.
- **Uncached synthesis latency: 2575–2601 ms (TTS), 1690 ms for a 2 s clip (STT).** Measured once each, on a home connection — treat as an order of magnitude, not a percentile.
- **Credit consumption: ~4 estimated.** HUMAIN publishes no per-character TTS price and returns no `credits_consumed` field, so the actual balance change must be read from the console Usage page — it cannot be derived from the API response.
- 5000 free credits minus this run leaves the balance in the thousands; nothing else has been spent.

### R2 — latency target recommendation (honest, from the measurements above)

Recommendation: **do not adopt a streaming target.** Adopt a p95 ≤ 4.0 s budget for uncached buffered synthesis and ≤ 150 ms for a cache hit, with a visible loading state on every play button.

Reasoning: measured uncached synthesis is ~2.6 s, so an honest p95 is ~4 s; promising less would be a number the provider does not deliver. This is affordable because lessons are authored content — each clip is synthesized once, stored in the `tts_cache` keyed by `(text, voice, script)`, and every later play is a cache hit. The 2.6 s cost is therefore paid on first authoring/use, not on every learner interaction, and a cache hit never leaves the device. `tts_cache` hits are already counted separately in the usage ledger (the e2e journey asserts "a cache hit costs 0 credits").

## DOCUMENTED

- The provider exposes NO confidence score on transcriptions; build (1).md's confidence<0.5 rule cannot be implemented as written and was replaced by the approved deterministic turn (R1).
- Voice IDs are per-environment profile UUIDs; labels such as mul_nourah are display-only and cannot be sent as voice_id.
- Buffered TTS returns one complete clip and does not stream; streaming exists only over Socket.IO (R2).
- Both HTTP STT routes and both HTTP TTS routes require the multipart/JSON content-type, and /v1/realtime/http/{route} additionally requires a fresh `id` UUID query parameter. Omitting either makes the gateway answer a bare 403 (supportID only) that is easy to misread as a missing capability. Per the docs: "A 403 without an ErrorResponse body comes from a gateway: check the URL, route and headers."

## UNVERIFIED

- Per-character TTS credit consumption: not publicly documented and absent from responses. Read the console Usage page and compare against the ~4-credit estimate.
- Fast STT (Socket.IO `audio_file`): this run exercised the **batch HTTP** STT route. The Socket.IO fast path is still unproven on this key — it needs its own billed clip, which was not in the approved plan.
- Saudi-accented English transcription accuracy: **still unverified and not verifiable by this run.** A synthesised tone measures latency only. Confirming accuracy needs the owner to record real speech samples — no synthetic substitute is acceptable, and no number here should be treated as an accuracy claim.
- Native Saudi listener review of the four `ars` voices, and commercial-use confirmation for all of them.
