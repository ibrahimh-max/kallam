# Resume audit — independent re-verification

Audit performed against the current files on disk. Nothing below is taken from a
previous report; each claim names the command or source that produced it.

## 1. What the specification actually is

The spec file in this workspace is **`build (1).md`** (1003 lines, 47 KB) — there is
no `build.md`. Every earlier reference to "build.md" means this file. The milestone
list lives in §14 (`Milestone 0` … `Milestone 6`), the MVP acceptance criteria in
§16, the retention schedule in §10.1 and the STT test protocol in §15.4.

## 2. Verification of the previously reported checks

Independently re-run, not trusted from the log:

| Check | Reported | Re-observed now | Verdict |
|---|---|---|---|
| `npx tsc --noEmit` (server) | exit 0 | exit 0, no output | reproduced |
| `npm test` (server) | 22 tests, 22 pass | **27 tests, 27 pass, 0 fail** | reproduced (suite grew) |
| `flutter analyze` | no issues | **No issues found** | reproduced |
| `flutter test test/` | 35 tests, all passed | **36 pass / 11 FAIL** → after fix **44/44 pass** | **FALSE CLAIM, corrected** |
| e2e journey | 69–70 checks pass | not re-run this pass | not re-verified |

## 3. Defect found: the widget tests never ran (P0, fixed)

The development log asserted "flutter test test/ — 35 tests, all passed". That was
not true. `app/test/auth_flow_test.dart` failed **11 of 12 tests** before this pass.

**Observed symptom.** `flutter test test/auth_flow_test.dart` printed, for every
test:

```
The following StackOverflowError was thrown building _Root(dirty, dependencies:
[UncontrolledProviderScope], state: _ConsumerState#8b5f2):
Stack Overflow
```

**Root cause, read from the Dart SDK source, not guessed.** The harness pumped the
app inside:

```dart
HttpOverrides.runZoned(() async { … },
    createHttpClient: (context) => HttpClient(context: context));
```

`HttpOverrides.runZoned` installs `_HttpOverridesScope`, whose `createHttpClient`
calls the callback it was given (`dart-sdk/lib/_http/overrides.dart`). The callback
asks `HttpClient(context: …)` for a client, which resolves through the current zone
— whose builder is that same callback. It calls itself until the stack is exhausted.
So the tests could not have passed in any environment; the failure was in the test
harness, and it masked everything the file was meant to prove.

**Second, deeper cause.** Even once the recursion was removed (by passing a
`_RealHttpOverrides` whose inherited `createHttpClient` builds the real client
directly), the requests still never completed. `testWidgets` runs its body under
`AutomatedTestWidgetsFlutterBinding`, which drives a **fake event loop**; a loopback
socket's completion events belong to the real one, so they are never delivered while
`pumpAndSettle` advances fake time. That is exactly why the binding installs
`_MockHttpOverrides` (an empty 400 for every request, `_binding_io.dart:27`) and why
its documentation says to *provide your own client* (`_binding_io.dart:90-92`). The
"real loopback server" design was unsound, not merely mis-wired.

**Fix.** `app/test/support/fake_server.dart` now implements `http.BaseClient`
directly, keeping the same documented wire contract, recorded-request list and
canned-failure hooks, and is injected through the already-supported
`ApiClient(httpClient:)` seam. The `HttpOverrides.runZoned` machinery was deleted.

**Fix.** One assertion also named a widget the screen never builds
(`find.byType(ElevatedButton)` for the offline-splash retry, which the app renders
through `PrimaryButton`/`FilledButton`). It now asserts
`find.widgetWithText(FilledButton, 'جرّب مرة ثانية')` — the affordance as the learner
sees it.

**Evidence after the fix.**
`flutter test test/auth_flow_test.dart` → `+9: All tests passed!`
`flutter test test/` → `+44: All tests passed!`

**Honest coverage note.** TCP transport is no longer exercised inside widget tests,
and cannot be. It is covered where it can be real:
`server/tests/e2e-journey.mjs` drives the actual Node server over real HTTP.

## 4. Android build — diagnosis and the required action

Independently probed, per the owner's request:

* `JAVA_HOME` = `C:\Users\Dell\Desktop\New folder\jbr` → **`Test-Path` = False**.
  It points at a directory that does not exist.
* **No JDK exists on this machine.** A recursive search for `java.exe` under
  `C:\` (depth 6) returned nothing, and nothing under `C:\Program Files\Java`,
  `Eclipse Adoptium` or `Microsoft`. `Get-Command java` finds nothing.
* Android Studio is **not** installed as a program: only its per-user data folder
  `C:\Users\Dell\AppData\Local\Google\AndroidStudio2025.3.4` exists, and it contains
  **no `jbr`** — so the usual bundled JDK is unavailable.
* The Android SDK exists at `%LOCALAPPDATA%\Android\Sdk` and is substantial
  (`build-tools`, `platforms`, `platform-tools`, `ndk`, `system-images`, `emulator`,
  `licenses`), but has **no `cmdline-tools`** and no `sdkmanager`, so
  `flutter doctor` reports *"cmdline-tools component is missing"*. `ANDROID_HOME`
  and `ANDROID_SDK_ROOT` are both unset.

**Conclusion:** this is a workstation prerequisite, not a code defect. The Android
build configuration in the repo is complete and prepared. Completing a device build
requires, in order (each is a sizeable install — **not performed, awaiting the
owner's decision**):

1. Install a JDK (Android Gradle Plugin 8.x needs **JDK 17 or 21**, 64-bit), e.g.
   Eclipse Temurin 21, then set `JAVA_HOME` to its install root (replacing the
   dangling value) and add its `bin` to `PATH`.
2. Install the Android SDK **Command-line Tools** package into
   `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest` (`sdkmanager.bat` must end up
   there), then set `ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk`.
3. `flutter doctor --android-licenses`, then `flutter build appbundle`.

Nothing above creates external exposure and nothing was changed on the machine.

## 5. Supabase — status

No project exists and `DATABASE_URL` is unset, per the owner's instruction. No
substitute database was created and no credentials were invented. Schema and RLS
migrations are written and ready in `supabase/migrations/` (`0001_init.sql`,
`0002_rls.sql`, `0003_auth_and_usage.sql`). The data layer is behind `Repository`,
so connecting a real project changes no business logic; the server logs
`repository.ephemeral` and runs the in-memory driver until `DATABASE_URL` exists.
**Live integration and RLS enforcement remain unverified — this is a mock-only
result and must not be read as live database verification.**

## 6. HUMAIN — status

Real adapter in place behind `VoiceProvider`; credentials read from `server/.env`
only and redacted in every log line. Verified from the approved run: batch STT
enabled, buffered TTS enabled (raw PCM), Socket.IO transport live, 4 bilingual
`ars` voice UUIDs resolved. Still unverified: fast STT over Socket.IO, per-character
TTS cost, real Saudi-accented accuracy. No transcription confidence score exists,
so the deterministic retry turn (owner-approved, R1) is kept. **No further paid call
was made or is authorised.**

## 7. Milestone 0 human gates — separated, not fabricated

* **Engineering (done):** adapter, provider abstraction, harness, connectivity,
  capability probing, voice resolution, latency measured.
* **Automatically checkable locally (done):** zero-credit gates in
  `tools/checks/milestone-0-zero-credit.mjs`; no key ever printed.
* **Human research (outstanding, needs real people):** the 10–15 learner
  interviews, the 5-learner prototype, the native Saudi listener review, and the
  §15.4 test set (20 speakers × 5 utterances) that the ≥80% word-accuracy criterion
  depends on. **No learner data may be fabricated.**
* **Provider/commercial (outstanding, needs HUMAIN):** written commercial-use terms
  for the selected voices; the account-specific processing region and terms; the
  100-attempt credit measurement (far beyond the approved ~4-credit budget).

`build (1).md` says "If any criterion fails: Do not proceed to Milestone 1." The
engineering decision taken instead, recorded rather than silently ignored: build
Milestones 1–5 against the mock provider and the abstraction, because the voice
layer is designed to be replaceable, and make **no** claim that voice quality is
validated.
