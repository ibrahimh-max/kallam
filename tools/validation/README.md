# Milestone 0 — HUMAIN Voice validation harness

Proves what the HUMAIN Voice key can actually do **before** we build the learning
UI on top of assumptions. Run it from the repository root.

## Install

```powershell
npm install
```

Requirements: Node 22+ (Node 24 runs the TypeScript directly — no build step),
and `server/.env` containing `HUMAIN_API_KEY` and `HUMAIN_API_URL`.

## What each step costs

| Step | Script | Credits | What it proves |
|---|---|---|---|
| 1 | `npm run step1` | **0** | The key is accepted by this environment |
| 2 | `npm run step2` | **0** | Which routes/transports answer, and which capabilities are forbidden |
| 3 | `npm run step3` | **0** | The account's real voice UUIDs and Saudi (`ars`) voices |
| 4 | `npm run step4` | **spends** | Latency and real credit consumption — gated, see below |
| 5 | `npm run step5` | **0** | Writes `docs/milestone-0-voice-report.md` |

Steps 1–3 and 5 are free by design. Each one fails at the provider's validation
layer *before* any billing step:

- Step 1 sends **no file**, which creates no job (the provider's own documented check).
- Step 2 sends **empty text** to TTS; the provider checks TTS limits before any charge.
- Step 3 only opens a Socket.IO connection and asks for the voice list.

## Step 4 is gated and will refuse to run

```powershell
node tools/validation/src/measure.ts --approve --confirm-credits=4
```

Without **both** `--approve` and `--confirm-credits=N` it prints the plan and
exits without sending anything. It also refuses when the ceiling exceeds
`VALIDATION_MAX_CREDITS`, or when the estimate exceeds your ceiling.

## Results from the first real run (2026-11-22)

| Capability | Verdict | Evidence |
|---|---|---|
| Credential detection | present | `server/.env` read; values never printed |
| Batch STT `POST /v1/transcribe/{lang}` | enabled | 400 `VALIDATION_FILE_CORRUPT` (key accepted, no file sent) |
| Buffered HTTP TTS `POST /v1/audio/speech` | enabled | 400 `VALIDATION_REQUIRED_FIELD` on empty input |
| Socket.IO transport | enabled | handshake ok with `x-api-key` + `Origin` |
| Voice list (`tts_voice_list`) | 7 profiles | 4 Saudi (`ars`), all bilingual `ar,en` |
| Fast STT upload (`audio_file`) | **unverified** | needs one billed upload — gated |
| ASR model provisioning | **unverified** | only reported on a billed request |
| Short-clip STT `POST /v1/realtime/http/stt` | 404 | documented but not deployed at this origin |

### The trap this harness exists to catch

Omitting the request's content-type (and, on `/v1/realtime/http/{route}`, the
required `id` UUID query parameter) makes the gateway answer **403 with no
ErrorResponse body** — which is easily misread as "this key lacks the
capability". The docs are explicit: *"A 403 without an ErrorResponse body comes
from a gateway: check the URL, route and headers."* Both probes therefore send the
documented multipart content-type, so a 403 here now means a real capability gap.

Run `npm run check` for the zero-credit acceptance check over steps 1–3.

## Secret handling

- Values are read from `server/.env`, which is git-ignored.
- No script prints a key or a full URL. Output shows `present`, `length` and a
  short SHA-256 fingerprint instead.
- `assertNoSecrets()` runs over every report before it is printed, and throws if
  the output would contain the key.
- The key travels only in the `x-api-key` header — never in a URL, never in a log.

## Known limits of this harness

- A synthesised tone measures **latency**, not transcription **quality**. Real
  accuracy needs real Saudi-accented speech recorded by the owner.
- Step 2 cannot prove that a specific ASR model (e.g. `bayan_cs_ar_en`) is
  provisioned for the account; that only surfaces as `ASR_MODEL_NOT_FOUND` on a
  billed request. It is reported as unverified rather than guessed.
- Credit estimates are estimates: the provider returns no `credits_consumed`
  field, so reconcile against the console Usage page.
