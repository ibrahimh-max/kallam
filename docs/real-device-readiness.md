# Real-device and integration readiness

This is a test/setup procedure, not evidence that a device or live provider has
already passed. The project is not production-ready while the gates below remain.

## Current workstation evidence

- Flutter 3.41.7 / Dart 3.11.5 is installed.
- `JAVA_HOME` is `C:\Users\Dell\Desktop\New folder\jbr`, which does not exist.
  No JDK was found in the checked common install roots or Windows uninstall
  registry.
- Android SDK exists at `%LOCALAPPDATA%\Android\Sdk`, with Android platforms
  35, 36, and 36.1 and build-tools 35.0.0, 36.1.0, and 37.0.0.
- Android SDK Command-line Tools are missing. `ANDROID_HOME` and
  `ANDROID_SDK_ROOT` are unset.
- A `Pixel_7` AVD is configured, but `adb devices` is empty. Flutter currently
  detects only Windows, Chrome, and Edge.
- No APK, emulator journey, or physical-device journey has been completed.

## Windows Android setup (no system-wide changes)

The Android module uses Java 17. Install a JDK 17 distribution for the current
Windows user from a trusted vendor, and install the official Android SDK
Command-line Tools for Windows using Android Studio's SDK Manager or the
standalone download at <https://developer.android.com/studio#command-line-tools-only>.
Do not install or persist settings from this document without the workstation
owner's approval.

1. Install JDK 17 and note its actual installation directory (the directory
   containing `bin\java.exe` and `bin\javac.exe`).
2. Extract Android Command-line Tools so `sdkmanager.bat` is at
   `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat`.
   Avoid an extra nested `cmdline-tools` directory when extracting.
3. In the PowerShell window used for the build, configure only that session:

   ```powershell
   $env:JAVA_HOME = '<actual JDK 17 directory>'
   $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
   $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
   $env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:Path"
   java -version
   javac -version
   sdkmanager --list
   flutter doctor --android-licenses
   flutter doctor -v
   ```

4. Accept only the licenses the owner has reviewed. Confirm `flutter doctor -v`
   reports a healthy Android toolchain before attempting a build.
5. Build a debug APK; this does not create a release signing key or change the
   placeholder application ID:

   ```powershell
   Set-Location 'C:\Users\Dell\Desktop\Kal''lam\app'
   flutter pub get
   flutter build apk --debug --dart-define=API_BASE_URL=http://10.0.2.2:8080
   ```

   `10.0.2.2` is the Android Emulator alias for the development PC. For a USB
   device, either use `adb reverse tcp:8080 tcp:8080` and
   `http://127.0.0.1:8080`, or use the PC's private-LAN address with both devices
   on the same trusted network. Do not expose the development server to the
   public internet.
6. To test the configured emulator after the toolchain is ready:

   ```powershell
   emulator -avd Pixel_7
   flutter devices
   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080
   ```

   Emulator results are useful but do not count as physical-device verification.
   For a real device, enable Android developer options and USB debugging on the
   test phone, approve the computer prompt, and confirm it appears in `adb devices`.

No permanent production application ID, release signing configuration, or
system-wide environment setting is authorized by this procedure.

## Physical-device acceptance checklist

Use a test account and a backend configured for the intended test. Record each
result separately as **implemented**, **automated**, **mocked**, **emulator-tested**,
or **physical-device-tested**; do not infer device success from compilation.

1. Install the debug APK fresh; launch, complete onboarding, and verify Arabic
   right-to-left and English left-to-right layouts.
2. Register, open the email verification link, sign in, request password recovery,
   complete a reset, and verify the old password and refresh token no longer work.
   Then restart the app and verify profile and onboarding state persist.
3. Select a lesson; verify its Arabic explanation, English TTS playback, lesson
   navigation, completion, and progress after restart.
4. Grant voice-processing consent, trigger the Android microphone permission,
   record real speech, stop, and verify the recording reaches the backend. Then
   revoke consent and verify recording is blocked before the microphone opens.
5. Test a valid transcript, silence/empty transcript, invalid audio, timeout or
   network failure, retry, and feedback. Confirm the UI does not invent confidence
   or pronunciation scores.
6. Test TTS replay, app background/resume during recording, permission denial and
   recovery through Settings, and a backend outage.
7. Verify logout invalidates refresh, account deletion blocks subsequent access,
   and retention removes data only after the configured grace period.
8. Repeat on at least one physical Android device and record model, Android
   version, network, app build, backend mode, and observed outcomes.

## Supabase project checklist

### Required configuration for the current implementation

- `SUPABASE_URL`: the project's HTTPS API URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the server-only service-role secret. Store it in
  the backend's secret manager or local `server/.env`; never put it in Flutter,
  source control, logs, screenshots, or chat.
- `LOCAL_JWT_SECRET`: a randomly generated secret of at least 32 characters.
  Keep it identical across backend replicas; it signs the app's custom access
  tokens and domain-separates HMACed rate-limit bucket identifiers.
- `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and `EMAIL_FROM`: use a verified
  sender configured in Resend. Keep the key only in the backend secret manager or
  local `server/.env`; never put it in Flutter, source control, logs, or chat.
- `REPOSITORY_DRIVER=supabase`; production mode additionally requires HTTPS
  `PUBLIC_BASE_URL`, `SUPPORT_EMAIL`, and a real `HUMAIN_API_KEY`.

`SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`, and `DATABASE_URL` are not used by the
current backend. The mobile app communicates with the API, not Supabase directly.
`AUTH_DRIVER=supabase` is deliberately rejected: the API verifies scrypt password
hashes and issues its own sessions. Supabase Auth is only used as an identity-row
anchor; mailbox verification and recovery use the backend-managed `auth_credentials`
state and Resend. Migration `0006` adds hashed one-time action-token storage. This
custom-auth architecture differs from the original build specification's Supabase
Auth session requirement. Email delivery and migration `0006` have not been verified
against live services.

### Apply and verify (owner's real project only)

1. Provide the required values securely to the backend operator; do not send the
   service-role key through a public or logged channel.
2. Apply migrations `0001_init.sql` through `0006_email_verification_and_recovery.sql`
   in order. Do not create a substitute database.
3. Start the server with `REPOSITORY_DRIVER=supabase` and verify `/health` reports
   connectivity and a successful RLS audit. A reachable URL alone is insufficient.
4. Verify registration/login, profile and lesson operations, cross-account
   isolation, refresh rotation/revocation, account deletion, and scheduled
   retention against test accounts.
5. Verify the shared `hit_rate_limit` RPC with concurrent requests from separate
   instances, check that only HMAC bucket keys are stored, and confirm RPC outages
   fail closed. Confirm service-role table access is not mistaken for RLS
   enforcement: service-role queries bypass RLS, so API ownership filters remain
   essential.

No live credentials or project are available here. These checks are pending.

## HUMAIN real-device validation procedure

No paid HUMAIN request is authorized by this procedure. Obtain explicit owner
approval and a spend limit before any live run; automated regression must continue
using `VOICE_PROVIDER=mock`.

1. Confirm the provider account region, data-processing terms, selected voice
   availability, commercial-use terms, and the approved per-run credit budget.
2. Use a physical test phone, an approved test account, and a real backend with
   the provider key held only on the server. Do not add the provider key to the app.
3. Obtain participant consent for the research recording/processing separately
   from normal app voice consent. Keep a reference transcript for each utterance;
   do not retain raw audio beyond the approved research protocol.
4. Run the specification's Saudi-speaker set (20 speakers / 100 utterances) across
   quiet, noisy, device, and network conditions only when separately authorized.
   Compute word accuracy from the reference and returned transcript; do not
   substitute synthesized audio or provider confidence for listener judgment.
5. Measure STT latency for 10-second clips and TTS time-to-first-audio on 4G with
   a monotonic clock. Record per-call results, medians, device/network details,
   cache status, and actual credits from the provider console. The specification
   targets STT at or below 5 seconds and median TTS first audio at or below
   3 seconds; no target is considered met without observed data.
6. Test at least two Arabic and two English voices with native Saudi listeners.
   Have them judge intelligibility, naturalness, and whether Arabic explanations
   are understood. Report participant results separately from engineering tests.
7. Keep confidence `null` when the provider supplies none. Do not calculate or
   display fabricated speech confidence or pronunciation quality.

The previous approved paid validation is recorded in
[`milestone-0-voice-report.md`](./milestone-0-voice-report.md). No additional
credit was used during this readiness pass.
