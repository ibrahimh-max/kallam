# Build Specification — Saudi-First AI English Tutor (v1.1)

**Status:** Product discovery completed; MVP planning ready  
**Working title:** Saudi English Tutor (name to be decided)  
**Primary market:** Saudi Arabia  
**Platforms:** Android (Google Play) and iOS (Apple App Store)  
**Core principles:** Fast · Cheap · Secure  
**Voice provider:** HUMAIN Voice  
**Document date:** 23 November 2026  
**Version:** 1.1 (adds cost model, API schemas, retention schedule, STT test protocol, measurable Milestone 0 criteria)

---

## 1. Product vision

Build a mobile English-learning app for Saudi Arabic speakers. The app teaches English through clear Arabic explanations, Saudi-accented Arabic tutor voices, English pronunciation audio, guided speaking exercises, and practical conversations.

The product should feel like a patient personal English tutor who understands how Saudi learners speak and explains mistakes in familiar Arabic—not a generic chatbot and not simply Duolingo with a microphone.

### One-line positioning

**Learn English in the Arabic you speak. Practise English with an AI tutor that understands you.**

### Product promise

A beginner should be able to open the app, understand a short English lesson explained in Saudi Arabic, practise saying a phrase, receive useful feedback, and see what to learn next—all in a few minutes.

### Target users for the first release

- Saudi Arabic-speaking adults and older teens learning English.
- Beginner to lower-intermediate learners (roughly CEFR A1–B1).
- People who understand some English but lack confidence speaking it.
- Learners who prefer explanations in Arabic rather than English-only instruction.

**MVP age recommendation:** Start with an adult/older-teen audience (18+ for the first public test) unless the team is prepared to implement the additional child-safety, parental-consent, data, and store requirements for younger users. Do not market the first version as a children's learning app.

### Product non-goals for MVP

- Do not attempt to replace a full school curriculum.
- Do not build a social network or public chat community.
- Do not store every learner's raw voice recording.
- Do not require an always-on AI conversation for ordinary lessons.
- Do not build a large admin dashboard before validating learner demand.
- Do not promise a certified English level or guaranteed fluency.

---

## 2. Research findings and product implications

### 2.1 HUMAIN Voice is a strong fit

Official HUMAIN Voice documentation describes speech-to-text for Arabic, English, and Arabic-English code-switching; text-to-speech voices that speak Arabic and English; fast, batch, and real-time transcription workflows; and a hosted Voice Agent for conversational experiences. The transcription model is called BayanArEn, and the TTS model is called Nebula.

The documented Saudi Arabic voice IDs include `mul_nourah`, `mul_abdullah`, `mul_sara`, and `mul_abdulaziz`. The voice catalogue may vary by environment/account. Fetch the available voices from the provider and validate the exact voice IDs before using them; do not assume an ID is enabled for every API key.

**Product implication:** Use a Saudi Arabic voice for explanations and an appropriate English voice for English examples. Test all available Saudi voices with actual Saudi learners before choosing the default. Do not assume the Arabic voice should speak every English phrase; test bilingual pronunciation and code-switching quality.

Official sources:
- https://docs.voice.humain.com/en
- https://docs.voice.humain.com/en/models
- https://voice.humain.com/
- https://www.humain.com/en/voice

### 2.2 HUMAIN Voice Agent is beta

The HUMAIN Voice Agent documentation currently labels the feature beta. Its documented mobile approach uses a backend-created short-lived session token and WebRTC, with LiveKit clients for mobile integration.

**Product implication:** Do not make the beta Voice Agent a hard dependency for MVP launch. Build a reliable turn-based speaking flow first using speech-to-text, lesson evaluation, and text-to-speech. Keep the voice provider behind a backend adapter so a later Voice Agent integration does not require rewriting the app.

Source: https://docs.voice.humain.com/en/agent

### 2.3 Public pricing suggests that usage controls matter

The public HUMAIN Voice page advertises a Free tier (5,000 credits), Starter (49 SAR / 75,000 credits), Basic (99 SAR / 165,000 credits), and Premium (169 SAR / 300,000 credits). Voice Agent pricing is documented separately at **765 credits per minute** (12.75 credits per second), billed per started minute, with the agent's own ASR, LLM, and voice included in that rate.

For standard STT and TTS (non-agent), the public page gives approximate usage examples for batch transcription, realtime transcription, and generated speech characters. These are not interchangeable measures. Re-check the live pricing and actual credit consumption before setting subscription prices or usage quotas.

**Product implication:** Build a usage ledger from day one. Measure provider credits by feature and user. Avoid unlimited live voice in a low-priced plan. Cache repeatable lesson audio and use short speaking turns. Voice Agent, when added later, must be budgeted at ~0.46 SAR/minute on the Basic plan.

Source: https://voice.humain.com/ and https://docs.voice.humain.com/en/agent/limits-and-billing

### 2.4 Saudi market signal

The Saudi Communications, Space and Technology Commission's 2025 Internet Report lists Duolingo among the most downloaded educational apps by category in Saudi Arabia. A 2025 study of Saudi EFL learners also reports substantial Duolingo usage among its surveyed participants.

These are useful demand signals, not proof that this specific product has product-market fit or that Saudi users will pay for it.

**Product implication:** Compete on Saudi-first explanations, structured speaking practice, and useful feedback—not on having more games, badges, or lessons than Duolingo.

Sources:
- https://www.cst.gov.sa/en/knowledge-center/reports/saudi-internet-25
- https://doi.org/10.1016/j.actpsy.2025.104796

### 2.5 Privacy and store requirements

Saudi PDPL applies to relevant personal-data processing involving individuals in Saudi Arabia. Article 18 requires that personal data be kept only as long as necessary to achieve the specified purposes. Cross-border transfers are regulated and require the applicable safeguards and assessments. HUMAIN states that its platform provides Saudi data residency, but the team must still verify the actual service region, account configuration, contractual terms, subprocessors, retention, and data flows for the specific account.

Apple requires an accessible privacy policy, clear disclosures about collection and third-party sharing, appropriate consent, data minimisation, and in-app account deletion where account creation is supported.

Google Play requires that apps enabling account creation provide both an in-app path to delete accounts and associated data, and a public web link for account deletion requests. Play also treats microphone/audio and other sensitive user data as sensitive data, requiring accurate Data safety disclosures and secure handling.

**Product implication:** Privacy cannot be postponed until store submission. Build consent, deletion, data minimisation, and retention rules into the first release. Obtain Saudi legal/privacy review before launch; this document is a product/engineering specification, not legal advice.

Sources:
- https://dgp.sdaia.gov.sa/wps/wcm/connect/f579bc32-fda8-47bd-bc6f-66b8cb77985c/ENG-Guide%2Bto%2Bthe%2Bsaudi%2BPDP%2Blaw%2Bfor%2Bcontrollers%2Bprocessors.pdf
- https://sdaia.gov.sa/en/SDAIA/about/Documents/ExecutiveRegulations.pdf
- https://developer.apple.com/app-store/review/guidelines/
- https://support.google.com/googleplay/android-developer/answer/10144311
- https://support.google.com/googleplay/android-developer/answer/13327111

---

## 3. Product pillars

Every feature and technical decision must be evaluated against these three principles.

### Pillar A — FAST

- App opens quickly and does not require a voice model to initialise before the home screen appears.
- Lessons and progress screens load from the app/backend without waiting for audio generation.
- Use short audio clips and stream audio where supported.
- Show immediate UI feedback when recording starts, stops, uploads, or is being evaluated.
- Use timeouts, retries with backoff, and graceful fallbacks for provider failures.
- Cache static lesson audio and common phrases.
- Avoid loading large media or unnecessary libraries on app launch.
- Measure cold-start time, lesson-start time, transcription latency, and TTS time-to-first-audio.

### Pillar B — CHEAP

- Default learning flow is structured lessons, not open-ended live AI calls.
- Generate and cache fixed lesson audio instead of regenerating it for every learner.
- Use short learner utterances with a configurable maximum recording duration.
- Apply daily/free-tier speaking limits and subscription quotas.
- Track HUMAIN credits per user, lesson, feature, and day.
- Use deterministic lesson feedback for known exercises; call an LLM only when open-ended feedback is genuinely needed.
- Do not send audio to multiple AI providers.
- Do not store raw audio by default.
- Set alerts and hard spending limits where provider/account controls allow them.
- Do not advertise unlimited AI speaking until measured unit economics support it.

### Pillar C — SECURE

- HUMAIN API key exists only in backend secrets.
- Mobile app never calls HUMAIN with the master API key.
- Use short-lived, scoped session tokens for any future realtime Voice Agent sessions.
- Authenticate backend requests and enforce per-user rate limits.
- Use TLS for all network traffic and encryption at rest for stored data.
- Apply database row-level security (RLS) to user-owned records.
- Do not log raw audio, API keys, access tokens, or full sensitive transcripts.
- Default to ephemeral audio processing and deletion after transcription/evaluation.
- Explain what audio/text is sent to HUMAIN and obtain clear consent before microphone use.
- Provide account deletion and a documented data-retention policy.
- Keep analytics privacy-conscious and avoid advertising trackers in the MVP.

---

## 4. MVP experience

### 4.1 First-time onboarding

1. Welcome screen in Arabic, with an option to switch to English.
2. Explain the app: learn English with Saudi Arabic explanations and speaking practice.
3. Select learning goal: Everyday conversations / Work and career / Travel / Study / General English.
4. Select current level: Complete beginner / I know a few words / I can understand simple English / I can hold basic conversations.
5. Choose daily goal: 5, 10, or 15 minutes.
6. Explain microphone usage and third-party voice processing before requesting microphone permission.
7. Offer a short placement check (optional for first MVP; can be a later release).
8. Create a starter learning path.

Do not ask for date of birth, precise location, contacts, or other personal information unless a genuine product/legal need is established.

### 4.2 Home screen

Show: Continue learning button; Today's lesson; Daily goal progress; Current learning streak (optional; do not shame users for missing days); Recent vocabulary; Progress summary; Speaking practice shortcut.

Keep the home screen lightweight. Avoid autoplay audio.

### 4.3 Lesson structure

Each lesson should take approximately 3–7 minutes.

1. **Arabic introduction:** A Saudi Arabic tutor explains the situation and learning objective.
2. **English phrase:** Show the English phrase with a clear translation.
3. **Listen:** Play the English phrase and optionally the Arabic explanation.
4. **Understand:** One quick comprehension question.
5. **Practise:** Learner repeats or answers using the microphone.
6. **Feedback:** Show what was understood, one or two useful corrections, and a model answer.
7. **Review:** Save useful vocabulary and mark the lesson complete.

Example lesson: Ordering coffee.
- Arabic explanation: "إذا دخلت مقهى وتبغى تطلب قهوة، تقدر تقول..."
- English: "I'd like a coffee, please."
- Meaning: "أبغى قهوة، لو سمحت."
- Speaking task: "Order a coffee politely."
- Feedback should distinguish grammar, word choice, and whether the speech was understood. Do not mark an answer wrong solely because it has a Saudi accent.

### 4.4 Speaking practice — MVP turn-based flow

1. App displays a prompt and a model answer.
2. Learner taps and holds or taps the microphone control.
3. App records a short utterance (target 3–15 seconds; enforce a configurable maximum).
4. Audio is sent securely to the backend.
5. Backend sends it to HUMAIN STT using the appropriate Arabic/English/code-switching mode.
6. Lesson evaluator compares the transcript with the expected answer or evaluates the learner's response against the task.
7. App displays transcript, useful correction, and a short explanation in Arabic.
8. Backend requests TTS for the correction/model phrase if it is not already cached.
9. App plays the model pronunciation.
10. Temporary audio is deleted according to the retention policy (see §10.1).

If transcription confidence is low, ask the learner to try again. Do not confidently invent a correction from unclear audio.

### 4.5 Conversation scenarios

MVP should include a small, high-quality set: Introducing yourself; Ordering food or coffee; Shopping; Asking for directions; Airport and hotel basics; Talking about your day; Simple workplace introductions.

Each scenario should have a defined learning objective, vocabulary list, difficulty level, expected intents/answers, and correction rules.

**Do not ship an unrestricted AI chatbot as the primary learning experience.** Keep conversation bounded by a scenario and learning objective.

### 4.6 Progress

Track: Lessons completed; Vocabulary learned and reviewed; Speaking attempts; Common grammar mistakes; Words/phrases needing practice; Weekly learning time; Self-reported confidence (optional).

Do not claim precise pronunciation scoring unless the selected model/service provides a validated score. Transcript matching is not the same as phonetic pronunciation assessment.

---

## 5. Later features — not MVP blockers

### Phase 2: Guided AI conversation

Add a two-way tutor conversation for a selected scenario. The tutor should speak Saudi Arabic when explaining a concept, speak English during practice, understand Arabic-English code-switching, keep the conversation at the learner's level, correct one or two important mistakes at a time, avoid overwhelming the learner with long explanations, and offer a repeat/slower playback option.

Evaluate HUMAIN Voice Agent once its beta status, mobile integration, latency, cost, quotas, and production support are acceptable. If used, backend creates short-lived session tokens; the mobile app never receives the master API key. Budget at the documented rate of 765 credits/minute (≈0.46 SAR/min on Basic).

### Phase 3: Adaptive learning

Personalise lesson difficulty; schedule spaced vocabulary review; identify recurring grammar errors; recommend lessons based on weak areas; add optional placement assessment and CEFR-aligned progress indicators.

### Phase 4: Monetisation and expansion

Possible model to validate: Free (structured lessons, limited daily speaking attempts); Premium (higher speaking allowance, more scenarios, personalised review, conversation mode). Optional family plan only after privacy and family-account requirements are properly designed.

Do not set final subscription prices until real HUMAIN usage costs, store commissions, taxes, payment fees, and retention are measured (see §11).

---

## 6. Recommended technical architecture

### Mobile app

**Flutter (Dart)**

Why: Single shared codebase for Android and iOS; good fit for audio recording/playback and mobile UI; native platform integrations remain possible where required.

Suggested structure:

```text
lib/
  app/
    app.dart
    router.dart
    theme/
  core/
    config/
    networking/
    audio/
    errors/
    security/
  features/
    onboarding/
    authentication/
    home/
    lessons/
    speaking/
    conversations/
    progress/
    settings/
  shared/
    widgets/
    models/
Use a maintainable state-management approach (Riverpod or Bloc; choose one and use it consistently). Avoid unnecessary packages.

Backend
Node.js + TypeScript

Responsibilities: Authenticate and authorise app requests; keep HUMAIN API credentials in server-side secrets; create and validate lesson sessions; orchestrate STT and TTS requests; apply user quotas and cost controls; evaluate structured lesson responses; generate short-lived Voice Agent session tokens in a future phase; record usage and provider errors without storing unnecessary audio/transcript content.

Suggested backend structure:

text
server/
  src/
    config/
    middleware/
    routes/
    services/
      humain/
      lessons/
      evaluation/
      usage/
    repositories/
    security/
    jobs/
  tests/
Implement a VoiceProvider interface so the app's lesson logic does not depend directly on HUMAIN-specific SDK objects. Keep HUMAIN integration replaceable.

Backend hosting
Choose a low-maintenance serverless/container platform that supports the required Node runtime, secrets, request duration, and streaming needs. Confirm region, egress, data-processing terms, and total cost before choosing a vendor. Do not assume that putting the database in one region automatically means all processing is in that region. Map every service and data flow.

Database and authentication
Supabase (PostgreSQL + Auth) is a reasonable MVP choice. Use Supabase Auth for user identity; PostgreSQL for profiles, lesson progress, vocabulary, and usage; RLS on every user-owned table; server-side service-role access only in trusted backend code; Storage disabled for raw voice recordings by default.

High-level architecture
text
Flutter app (iOS / Android)
        |
        | HTTPS + authenticated user token
        v
Node.js / TypeScript backend
        |
        +------ Supabase Auth / PostgreSQL
        |
        +------ HUMAIN Voice STT
        |
        +------ HUMAIN Voice TTS
        |
        +------ Usage limits / analytics
For future realtime conversations:

text
Flutter app -- WebRTC / LiveKit --> HUMAIN Voice Agent
      ^
      |
Backend creates short-lived session token
(Master HUMAIN API key remains on backend)
7. API design
7.1 Illustrative application endpoints
Method	Endpoint	Purpose
GET	/v1/me	Current user profile
PATCH	/v1/me	Update learning preferences
GET	/v1/lessons/today	Today's recommended lesson
GET	/v1/lessons/:id	Fetch lesson content
POST	/v1/lessons/:id/start	Start lesson session
POST	/v1/speaking/transcribe	Submit short audio for transcription
POST	/v1/speaking/evaluate	Evaluate a learner response
POST	/v1/audio/tts	Request or retrieve generated lesson audio
POST	/v1/lessons/:id/complete	Save completion
GET	/v1/progress	Fetch learning progress
GET	/v1/usage	Fetch remaining usage allowance
DELETE	/v1/me	Initiate account and data deletion
Implementation requirements: Validate file size, duration, MIME type, and request size. Apply per-user and per-IP rate limits. Use idempotency keys where retrying could create duplicate usage charges. Return stable error codes and safe user-facing messages. Never expose raw provider errors or secrets to the mobile client. Avoid putting transcripts, audio, or tokens in URLs. Do not trust client-supplied user IDs; derive identity from verified auth tokens.

7.2 Request/response schemas — speaking endpoints
POST /v1/speaking/transcribe
Purpose: Accept a short audio clip and return a transcript with confidence metadata. Does not evaluate. Does not persist audio beyond the request lifecycle.

Request:

json
{
  "audio_base64": "<base64-encoded audio>",
  "mime_type": "audio/m4a",
  "duration_seconds": 8.2,
  "language_mode": "code_switch" | "english_only" | "arabic_only",
  "prompt_id": "coffee_order_01"
}
Constraints (server-enforced):

audio_base64 decoded size ≤ 2 MB.

duration_seconds ≤ 20 (configurable; MVP default 15).

mime_type ∈ {audio/m4a, audio/wav, audio/mp4}.

language_mode default code_switch for mixed speech; english_only only for explicit English tasks.

Success response (200):

json
{
  "request_id": "req_abc123",
  "transcript": "I would like a coffee please",
  "confidence": 0.87,
  "language_detected": "en",
  "duration_seconds": 8.2,
  "credits_consumed": 12
}
Error responses:

HTTP	Code	Meaning	Client action
400	INVALID_AUDIO	Decode failed / unsupported MIME	Show "Recording was not clear. Please try again."
400	AUDIO_TOO_LONG	Exceeds duration limit	Truncate and retry, or ask user to speak shorter
401	UNAUTHORIZED	Missing/invalid auth token	Refresh token or re-login
429	RATE_LIMITED	Per-user limit hit	Show usage allowance screen
503	PROVIDER_UNAVAILABLE	HUMAIN STT timeout/error	Show retry button; do not charge user quota
422	LOW_CONFIDENCE	Confidence below threshold (e.g. < 0.5)	Ask learner to try again; do not evaluate
Server-side timeout: 15 seconds total (HUMAIN call + overhead). On timeout, return 503 and release any reserved quota.

POST /v1/speaking/evaluate
Purpose: Evaluate a transcript against a lesson prompt. Does not accept audio. Accepts a transcript produced by /transcribe (or, with caution, client-supplied text for typed practice).

Request:

json
{
  "prompt_id": "coffee_order_01",
  "transcript": "I would like a coffee please",
  "lesson_attempt_id": "att_xyz789",
  "language_mode": "english_only"
}
Success response (200):

json
{
  "request_id": "req_def456",
  "evaluation": {
    "understood": true,
    "task_completed": true,
    "corrections": [
      {
        "type": "style",
        "original": "I would like a coffee please",
        "suggested": "I'd like a coffee, please.",
        "explanation_ar": "هذي الطريقة أكثر طبيعية في الكلام اليومي."
      }
    ],
    "model_answer": "I'd like a coffee, please.",
    "encouragement_ar": "ممتاز! فهمت الطلب."
  },
  "credits_consumed": 0
}
Notes:

For deterministic lesson types (expected answer known), evaluation runs server-side rules and consumes 0 HUMAIN credits.

For open-ended responses, backend may call an LLM; this must be gated by a per-lesson evaluation_mode flag (deterministic | llm_assisted).

Never return raw LLM output directly; always parse into the structured evaluation object.

Error responses:

HTTP	Code	Meaning
400	UNKNOWN_PROMPT	prompt_id not found or not published
400	EMPTY_TRANSCRIPT	Transcript is empty or only whitespace
409	ALREADY_EVALUATED	This lesson_attempt_id already has an evaluation; use GET to retrieve
429	RATE_LIMITED	Per-user evaluation limit (only if LLM-assisted)
POST /v1/audio/tts
Purpose: Return TTS audio for a fixed lesson phrase. Uses cache-first lookup; only generates if not cached.

Request:

json
{
  "text": "I'd like a coffee, please.",
  "voice_id": "mul_nourah",
  "language": "en",
  "cache_key": "lesson_coffee_en_v1"
}
Success response (200): audio/mpeg binary stream, or JSON with audio_url if using CDN. Headers include X-Cache: HIT|MISS.

Cache key rule: Cache key must include text hash, voice ID, model version, and relevant generation settings. When lesson text or voice settings change, bump the cache key version (_v2).

Cost implication: Cached TTS consumes 0 HUMAIN credits. Uncached TTS consumes credits. The usage ledger must record cache_hit: true|false per request.

8. Initial database model
A minimal schema is preferable. Add fields only when a real feature needs them.

profiles
id (UUID, same identity as auth user)

display_name (optional)

preferred_arabic_voice

english_level

learning_goal

daily_goal_minutes

created_at, updated_at

lessons
id, title, description, level, topic

duration_minutes

content_json (versioned and validated; no executable code)

published, created_at

lesson_attempts
id, user_id, lesson_id

started_at, completed_at

score (only if a meaningful, documented scoring rubric exists)

status

speaking_attempts
id, user_id, lesson_attempt_id, prompt_id

transcript (retain only if needed and disclosed; see §10.1)

evaluation_json

created_at, audio_deleted_at

Do not store raw audio in this table. If a future feature genuinely needs recordings, create a separate opt-in design with explicit consent, access controls, retention limits, and deletion.

vocabulary
id, user_id, english_term, arabic_meaning, example_sentence

review_state, next_review_at

usage_events
id, user_id, provider, feature, model

usage_quantity, credits_estimated

cache_hit (boolean; critical for TTS cost attribution)

request_id, created_at

Do not store API keys or sensitive audio payloads in usage events.

consents
id, user_id, consent_type, policy_version

granted_at, withdrawn_at

Record consent to relevant voice processing and third-party processing in a clear, auditable way. Note: SDAIA guidance suggests consent records be retained for the duration of processing plus 36 months after withdrawal. Confirm this with legal counsel before implementing.

9. HUMAIN integration rules
Server-side only
Store HUMAIN_API_KEY in the backend secret manager.

Never add it to Flutter .env files that are bundled into the app.

Never commit secrets to Git.

Rotate a key immediately if it is exposed.

Restrict access to production secrets.

Text-to-speech
Fetch available voice IDs from the provider.

Select a Saudi Arabic voice for Arabic explanations after human testing.

Select an English voice for target phrases after testing accent clarity and learner comprehension.

Cache audio for static lessons using a cache key based on text, voice, model, language, and relevant generation settings.

Use a storage/CDN only for approved reusable lesson audio; do not store personal recordings in the same public bucket.

Set cache invalidation when lesson text or voice settings change.

Speech-to-text
Use the appropriate Arabic-English code-switching model (BayanArEn) for mixed speech.

Use English-only transcription when the task is explicitly English-only and testing confirms it works better.

Set duration and file-size limits.

Handle empty speech, background noise, unsupported audio, provider timeout, and low-confidence output.

Do not interpret a transcription as a reliable pronunciation score.

Voice Agent
Treat as a later-phase integration while the provider marks it beta.

Backend creates short-lived session tokens.

Token must be scoped to one session and expire.

Never expose the master API key to the client.

Enforce session duration and per-user daily limits.

Test interruption handling, reconnects, network changes, and app backgrounding.

Budget at 765 credits/minute (12.75 credits/second), billed per started minute.

10. Privacy and security requirements
10.1 Audio handling and retention schedule
Default policy with concrete durations:

Data type	Retention	Storage location	Deletion trigger
Raw voice recording (upload)	Deleted immediately after STT response is received (target < 5 seconds)	Backend memory / ephemeral temp only; never written to database or object storage	Automatic after transcription
Transcript (speaking_attempts)	90 days from creation	PostgreSQL, encrypted at rest	Scheduled job or user deletion request
Evaluation result	90 days or until user deletes account, whichever is first	PostgreSQL, encrypted at rest	User deletion or scheduled job
Usage events (no audio/transcript content)	24 months	PostgreSQL	Scheduled job
Consent records	Duration of processing + 36 months after withdrawal (pending legal confirmation)	PostgreSQL	Scheduled job after retention period
Cached TTS audio (non-personal, lesson content)	Indefinite (no personal data)	CDN / object storage	Cache invalidation on lesson change
Account profile	Until account deletion + 30 days (grace period for recovery requests)	PostgreSQL	User-initiated deletion or scheduled job after 30 days
Rationale: PDPL Article 18 requires data to be kept only as long as necessary. The 90-day transcript retention balances learning usefulness (reviewing past mistakes) against minimisation. If the product does not need transcripts after evaluation, reduce to 30 days or delete immediately and store only aggregate error types.

User-facing disclosure: The privacy policy must state these durations in plain Arabic and English.

10.2 Data minimisation
Collect only data needed for learning: Account identifier; Optional display name; Learning level and goals; Lesson completion and progress; Vocabulary and learning preferences; Limited transcripts/evaluation results where needed and disclosed.

Avoid collecting precise location, contacts, photo library, or unrelated device information.

10.3 Security controls
HTTPS/TLS for every network request.

Database encryption at rest and encrypted backups.

RLS for all user-owned records.

Least-privilege backend/database roles.

Secure token storage on device using platform-backed secure storage.

Short session expiry and refresh-token rotation where supported.

Rate limiting and abuse detection.

Request-size and audio-duration limits.

Dependency scanning and secret scanning in CI.

Redacted logs and audit events for administrative access.

Tested account deletion and data deletion workflow.

Documented incident response and backup recovery process.

10.4 Saudi PDPL launch checklist
Before production:

Identify the data controller and processors.

Map where profile, transcript, audio, analytics, and payment data are processed.

Verify HUMAIN's account-specific processing region and contractual terms.

Assess any cross-border transfer and applicable safeguards.

Publish an Arabic and English privacy policy.

Define retention and deletion schedules (see §10.1).

Obtain consent where required and make withdrawal understandable.

Establish a process for data-subject requests.

Obtain qualified Saudi privacy/legal review.

11. Cost-control model
11.1 Worked cost example (MVP assumptions)
This is a planning model, not a prediction. Replace every number with measured values after the Milestone 0 pilot.

Assumptions (conservative, for planning only):

Variable	Assumed value	Source / note
STT audio per speaking attempt	10 seconds	MVP maximum 15s; average target 10s
STT batch overage rate	~1 SAR per audio hour	Public pricing; realtime STT may differ
TTS generation per lesson	2 uncached phrases (correction + model)	Lesson audio pre-cached; correction audio partially cached
TTS cached phrases per lesson	10+	All static lesson content pre-generated
Speaking attempts per lesson	3	Each attempt = 1 STT call + 1 evaluation
Lessons per active learner per day	2	Daily goal 10 minutes
Active days per month	20	Conservative engagement
Voice Agent (Phase 2 only)	Not in MVP	Excluded from this model
Per-lesson voice cost (MVP, non-agent):

STT: 3 attempts × 10s = 30s audio. At ~1 SAR/audio hour batch rate: ~0.008 SAR per lesson.

TTS uncached: 2 phrases × ~50 characters = 100 characters. Public pricing does not expose a per-character rate for Nebula TTS in the search results; this is the critical unknown. Planning placeholder: assume 1 SAR per 100,000 characters (order-of-magnitude for planning only). Per-lesson TTS uncached: ~0.001 SAR.

TTS cached: 0 SAR (generated once, served from CDN).

Evaluation: deterministic for MVP = 0 SAR.

Total per-lesson voice cost (planning estimate): ~0.01 SAR.

Per-active-learner per month (MVP):

2 lessons/day × 20 days = 40 lessons/month.

Voice cost: 40 × 0.01 SAR = ~0.40 SAR per active learner per month (voice only).

Add infrastructure, database, backend compute: ~1–3 SAR per active learner per month (highly dependent on hosting choice).

Voice Agent (Phase 2) cost — for comparison:

A 5-minute conversation = 5 started minutes × 765 credits = 3,825 credits.

On Basic plan (165,000 credits / 99 SAR): 3,825 credits ≈ 2.3 SAR per 5-minute conversation.

Ten such conversations per learner per month = 23 SAR per learner per month. This is 50× the turn-based MVP cost and must not be offered in a low-priced tier.

Pricing implication: The MVP turn-based flow is extremely cheap on voice. The real cost risk is Voice Agent (Phase 2) and unlimited TTS generation. Price the MVP subscription around the infrastructure + modest margin; reserve Voice Agent minutes for a premium tier with hard caps.

11.2 Required controls
Free daily speaking allowance.

Maximum audio duration.

Maximum TTS text length.

Per-user request rate limits.

Daily and monthly provider-credit budgets.

Cached TTS for fixed curriculum content.

No automatic microphone recording.

No background voice sessions.

No unnecessary retries that create duplicate provider usage.

Usage dashboard for the operator.

Alerts when actual cost per active learner crosses a configured threshold.

11.3 Metrics to calculate before pricing
Average STT credits per speaking attempt (measured, not assumed).

Average TTS credits per lesson (separate cache hit vs miss).

Average number of speaking attempts per active learner/day.

Average provider cost per daily active user.

Average provider cost per monthly active user.

Infrastructure and database cost per active user.

Paid conversion and subscription-store fees.

Gross margin after refunds, taxes, and payment/store fees.

Do not set a final subscription price from the provider's headline plan price alone. Run a real usage test with 20–50 learners and calculate the cost distribution.

12. UX and visual direction
Design principles
Arabic-first onboarding and explanations.

Support Arabic right-to-left (RTL) and English left-to-right (LTR) correctly.

Use a clean, modern, welcoming visual identity.

Large readable Arabic typography.

Clear microphone state and recording timer.

One primary action per lesson screen.

Avoid clutter, excessive animation, and distracting gamification.

Make audio replay and slower playback easy to find.

Ensure accessible contrast, touch targets, and screen-reader labels.

Suggested navigation
Home, 2. Learn, 3. Speak, 4. Progress, 5. Profile.

The MVP can simplify this to Home, Learn, Speak, and Profile if five tabs feel crowded.

Important interaction states
Every audio screen must handle: Microphone permission not yet requested; Permission denied; Recording in progress; Recording too long; Uploading; Transcribing; Evaluating; Playing response audio; Network disconnected; Provider unavailable; Usage allowance exhausted; Retry available.

Never leave the learner looking at an unresponsive microphone button.

13. App Store and Google Play release requirements
Build and test for both stores from the beginning.

Android / Google Play
Flutter release build and signed Android App Bundle (AAB).

App icon, screenshots, feature graphic, store description.

Privacy policy URL.

Accurate Data safety form, including Data deletion questions.

In-app account deletion path.

Public web account/data deletion route.

Microphone permission explanation and runtime permission.

Content rating and target-audience declarations.

Testing track and current Play Console testing requirements.

Crash-free release testing on real Android devices.

iOS / Apple App Store
iOS release build and signing configuration.

App icon, screenshots, store description.

Privacy policy URL in App Store Connect and within the app.

Clear microphone purpose string.

App Privacy disclosures that match actual SDK/backend data flows.

In-app account deletion if account creation is supported.

TestFlight testing on real iPhones.

Review notes explaining the voice-learning flow and microphone usage.

Check current Apple requirements for privacy manifests and third-party SDKs.

Store-readiness rule
Do not submit until the privacy policy, consent screens, microphone purpose strings, data declarations, account deletion, and actual network behaviour all match.

14. MVP delivery plan
Milestone 0 — Validate before building (short discovery sprint)
Measurable exit criteria:

□ HUMAIN developer account active; API key obtained and tested.
□ At least 2 Saudi Arabic voices and 2 English voices confirmed available and tested with native Saudi listeners.
□ STT test set (see §15.4) shows ≥ 80% word accuracy on Saudi-accented English at A1–B1 level in quiet conditions.
□ TTS latency (time to first audio) ≤ 3 seconds median on 4G.
□ STT latency ≤ 5 seconds median for 10-second clips.
□ Credit consumption measured for 100 simulated speaking attempts; per-attempt cost documented.
□ 10–15 Saudi English learners interviewed; ≥ 8/10 understand the Arabic explanation in a prototype lesson.
□ 5 learners complete a clickable speaking-task prototype; ≥ 4/5 complete the task unaided.
□ At least 6/10 interviewees say they would use the app weekly if it existed.
□ First 20 lesson topics decided based on interview feedback.
□ Commercial use terms for selected voices confirmed in writing.
If any criterion fails: Do not proceed to Milestone 1. Re-scope, re-test, or abandon.

Milestone 1 — Mobile foundation
Flutter project setup; app theme, routing, localisation, RTL/LTR; authentication; Supabase schema and RLS; backend deployment and secret management; basic profile and onboarding.

Milestone 2 — Learning engine
Lesson content format; home and lesson screens; audio playback; vocabulary saving; lesson completion and progress; seed 20–30 high-quality lessons.

Milestone 3 — Speaking MVP
Microphone permission and recording; secure upload to backend; HUMAIN STT integration; response evaluation; HUMAIN TTS integration; feedback UI and audio replay; usage quotas and cost logging; audio deletion behaviour per §10.1.

Milestone 4 — Beta and validation
Closed beta with 20–50 Saudi learners; measure lesson completion and speaking-task completion; measure speech recognition quality across Saudi accents and devices using the test protocol in §15.4; measure latency and cost per active learner; fix confusing lessons and poor corrections; validate willingness to pay before implementing complex subscriptions.

Milestone 5 — Public release
Arabic and English privacy policy; terms of service; account deletion (in-app + web); store listing assets; Data safety and App Privacy disclosures; Android and iOS release builds; TestFlight and Google Play testing; production monitoring and support process.

Milestone 6 — Conversational tutor
Only after the turn-based experience is reliable: prototype HUMAIN Voice Agent; test WebRTC/LiveKit on iOS and Android; add scenario-bound two-way conversations; enforce short-lived tokens and session budgets; compare cost and learning outcomes against turn-based practice.

15. Success metrics
15.1 Activation
Percentage completing onboarding; Percentage starting the first lesson; Percentage completing the first speaking exercise.

15.2 Learning engagement
Lessons completed per active learner/week; Speaking attempts per active learner/week; Day 1, Day 7, and Day 30 retention; Percentage returning to review vocabulary.

15.3 Learning quality
Learner-reported clarity of Arabic explanations; Task completion rate; Repeat-attempt improvement on the same exercise; Human-reviewed quality of corrections; Speech recognition failure rate by device/noise condition.

15.4 Speech recognition test protocol
Test set construction:

20 speakers minimum: 10 male, 10 female, ages 18–45, varied Saudi regions (Riyadh/Najd, Jeddah/Hijaz, Eastern Province).

5 utterances per speaker (100 total): 2 English-only phrases (e.g., "I'd like a coffee, please"), 2 Arabic-English code-switch phrases (e.g., "أبغى أطلب same order"), 1 Arabic-only explanation phrase for baseline.

Recording conditions: quiet room, one noisy condition (café background), one device variation (at least 2 phone models).

Metrics to compute:

Word Error Rate (WER) per condition (quiet vs noisy) and per language mode (English-only vs code-switch).

Task completion rate: percentage of utterances where the correct intent is recoverable from the transcript, judged by a Saudi bilingual evaluator.

Low-confidence rate: percentage of utterances returning confidence < 0.5.

Acceptance thresholds for MVP:

Quiet, English-only: WER ≤ 15%, task completion ≥ 90%.

Quiet, code-switch: WER ≤ 25%, task completion ≥ 80%.

Noisy: WER ≤ 30%, task completion ≥ 70% (or product explicitly warns users about background noise).

If thresholds fail: Evaluate alternative STT models or restrict MVP to quiet-environment use with a clear user warning. Do not ship a speaking feature that fails code-switch tests.

15.5 Product performance
App cold-start time; Lesson content load time; Median and p95 STT response time; Median and p95 TTS time-to-first-audio; Crash-free sessions.

15.6 Unit economics
HUMAIN credits per active learner; Voice cost per completed lesson; Voice cost per weekly active learner; Infrastructure cost per active learner; Gross margin by subscription tier.

Set numerical targets after baseline testing. Do not invent performance or learning claims before measurement.

16. Acceptance criteria for the first MVP
The MVP is ready for closed beta when:

□ The same Flutter codebase builds successfully for Android and iOS.
□ A new learner can onboard and select a learning goal.
□ The app correctly renders Arabic RTL and English LTR.
□ A learner can open and complete a structured lesson.
□ A learner can play a Saudi Arabic explanation and an English model phrase.
□ A learner can record a short speaking response.
□ The backend transcribes the response using HUMAIN without exposing the API key.
□ The app displays a useful transcript and a bounded, understandable correction.
□ The learner can hear the corrected phrase.
□ Raw audio is not retained after processing (verified by database/storage inspection).
□ Consent and microphone permission are handled clearly.
□ User data is protected by authentication and database RLS.
□ Usage limits and provider-credit logging work, including cache_hit attribution.
□ The user can request account/data deletion in-app and via public web link.
□ Provider errors, network loss, and permission denial have clear fallback states.
□ Privacy disclosures accurately describe actual data processing and retention durations.
17. Key risks and decisions still to validate
Risk / open question	Required action
HUMAIN voice quality may vary by voice and use case	Test each enabled Saudi voice with native Saudi listeners
HUMAIN TTS per-character credit consumption is not publicly documented in search results	Measure directly in Milestone 0; this is the largest cost unknown
Voice Agent is beta and expensive (~2.3 SAR per 5-min conversation on Basic)	Keep it out of the MVP critical path; budget explicitly before Phase 2
STT may misrecognise Saudi-accented English	Run the §15.4 test protocol before building the speaking UI
Transcript matching is not pronunciation assessment	Avoid unsupported pronunciation scores
Saudi PDPL and cross-border processing	Map data flows and obtain local legal/privacy review
Competitors already have strong content libraries	Differentiate through Saudi Arabic explanations and speaking feedback
Subscription willingness to pay is unknown	Interview learners and test pricing before building complex billing
Decisions to make before implementation
Final app name and brand.

First target segment: university students, job seekers, working adults, or general adult beginners.

Arabic voice default after native-speaker testing.

English voice and accent preference.

Initial lesson curriculum and level.

Backend hosting region/provider after data-flow and cost review.

Free daily speaking allowance after real credit measurement.

Subscription model after pilot validation.

18. Final product recommendation
Build the first release as a Saudi Arabic-guided English-learning app with structured lessons and short speaking exercises.

The strongest initial loop is:

Understand in Saudi Arabic → Listen in English → Speak in English → Get corrected in Saudi Arabic → Practise again.

Use HUMAIN as the voice layer, not as the entire product. The curriculum, learning progression, feedback rules, progress tracking, cost controls, privacy design, and user experience are what make this a real learning product.

Keep the first version deliberately small, reliable, and measurable. Prove that Saudi learners return to practise speaking before investing in a complex realtime AI tutor.

Research references
HUMAIN Voice introduction and integration documentation — https://docs.voice.humain.com/en

HUMAIN Voice models, languages, and voices — https://docs.voice.humain.com/en/models

HUMAIN Voice Agent documentation — https://docs.voice.humain.com/en/agent

HUMAIN Voice Agent limits and billing (765 credits/minute) — https://docs.voice.humain.com/en/agent/limits-and-billing

HUMAIN Voice public pricing and demo — https://voice.humain.com/

HUMAIN Voice platform overview — https://www.humain.com/en/voice

Dalili HUMAIN Voice summary (BayanArEn, Nebula, public pricing) — https://dalili.tools/en/tools/humain-voice

Saudi CST 2025 Internet Report — https://www.cst.gov.sa/en/knowledge-center/reports/saudi-internet-25

Saudi EFL learner mobile-app study — https://doi.org/10.1016/j.actpsy.2025.104796

SDAIA guide to Saudi PDPL — https://dgp.sdaia.gov.sa/wps/wcm/connect/f579bc32-fda8-47bd-bc6f-66b8cb77985c/ENG-Guide%2Bto%2Bthe%2Bsaudi%2BPDP%2Blaw%2Bfor%2Bcontrollers%2Bprocessors.pdf

SDAIA PDPL FAQs (Article 11 minimisation, Article 18 retention) — https://dgp.sdaia.gov.sa/wps/portal/pdp/knowledgecenter

Apple App Review Guidelines — https://developer.apple.com/app-store/review/guidelines/

Google Play User Data policy — https://support.google.com/googleplay/android-developer/answer/10144311

Google Play account deletion requirements — https://support.google.com/googleplay/android-developer/answer/13327111

SDAIA consent record retention guidance (36 months after withdrawal) — industry summary

Research note: Provider features, model availability, prices, store rules, and legal requirements can change. Re-check official documentation and account-specific terms immediately before implementation and release.

v1.1 changes summary:

Added §7.2 with concrete request/response schemas, error codes, and timeout budgets for /speaking/transcribe and /speaking/evaluate.

Added §10.1 retention schedule with actual durations for every data category.

Added §11.1 worked cost model with planning assumptions and the Voice Agent cost comparison.

Added §15.4 STT test protocol with measurable acceptance thresholds.

Replaced subjective Milestone 0 exit condition with testable checkboxes in §14.

Added cache_hit field to usage_events for TTS cost attribution.

Strengthened store requirements citations for account deletion (Play, Apple).

Flagged the TTS per-character cost as the largest remaining unknown to measure in Milestone 0.
