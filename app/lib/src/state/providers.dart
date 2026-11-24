import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../audio/recorder_service.dart';
import '../audio/tts_audio_player.dart';
import '../data/api_client.dart';
import '../data/models.dart';
import '../data/token_store.dart';

/// Application-wide providers.
///
/// Layering rule: screens never construct an [ApiClient] or touch the token
/// store; they read a provider. That keeps one session, one HTTP client and one
/// place where "the session ended" is decided.

final tokenStoreProvider = Provider<TokenStore>((_) => SecureTokenStore());

final apiClientProvider = Provider<ApiClient>((ref) {
  final client = ApiClient.production(
    tokenStore: ref.watch(tokenStoreProvider),
  );
  ref.onDispose(client.dispose);
  return client;
});

final recorderProvider = Provider<AudioRecorderService>((ref) {
  final recorder = AudioRecorderService();
  ref.onDispose(recorder.dispose);
  return recorder;
});

final ttsPlayerProvider = Provider<TtsAudioPlayer>((ref) {
  final player = TtsAudioPlayer();
  ref.onDispose(player.dispose);
  return player;
});

/// The signed-in learner, or `null` when signed out.
///
/// The profile is the app's routing truth: `onboardingCompleted` decides whether
/// the learner lands on onboarding or the home screen, and it comes from the
/// server so it cannot be faked by reinstalling.
class AuthState {
  const AuthState({this.profile, this.checking = true, this.offline = false});

  final PublicProfile? profile;

  /// True until the stored session has been validated on startup. The router
  /// shows a splash while this holds, so a signed-in learner never sees a flash
  /// of the sign-in screen.
  final bool checking;

  /// True when startup could not reach the server, so the stored session is
  /// *unknown* rather than invalid. The splash offers a retry instead of signing
  /// the learner out for a missing connection.
  final bool offline;

  bool get isSignedIn => profile != null;
  bool get needsOnboarding => profile != null && !profile!.onboardingCompleted;
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._api) : super(const AuthState()) {
    _api.onSessionLost = () async {
      if (mounted) state = const AuthState(checking: false);
    };
    _restore();
  }

  final ApiClient _api;

  /// Used only to keep the app usable when the last validation succeeded.
  PublicProfile? _lastKnownProfile;

  /// The most recent validated profile, if any. Exposed for the offline splash,
  /// which must not claim the learner is signed in without evidence.
  PublicProfile? get lastKnownProfile => _lastKnownProfile;

  /// Validates the stored tokens against the server. A failure here means the
  /// session is gone (revoked, expired, account deleted) and the learner must
  /// sign in — it is not an error to show on a splash screen.
  Future<void> _restore() async {
    final AuthTokens? tokens;
    try {
      tokens = await _api.tokenStore.read();
    } on Exception {
      // A keystore read can fail (corrupt entry, revoked key). That is a session we
      // cannot use, not a reason to sit on the splash screen forever.
      await _clearStoredTokens();
      if (mounted) state = const AuthState(checking: false);
      return;
    }
    if (tokens == null) {
      if (mounted) state = const AuthState(checking: false);
      return;
    }
    try {
      final profile = await _api.profile();
      if (mounted) {
        _lastKnownProfile = profile;
        state = AuthState(profile: profile, checking: false);
      }
    } on SessionExpired {
      // The server actively rejected the token: the session really is gone.
      await _clearStoredTokens();
      if (mounted) state = const AuthState(checking: false);
    } on ApiError catch (error) {
      if (!mounted) return;
      // Offline on launch. The token is still stored; we simply could not reach the
      // server to validate it, so the session is *unknown*, not invalid. Dropping to
      // AuthState(profile: null) would sign the learner out of a valid session —
      // the exact opposite of what this branch is for. Keep the splash and let the
      // UI offer a retry. A definitive answer (SessionExpired/403) still signs out.
      if (error.code == 'NETWORK_UNAVAILABLE' || error.retryable) {
        state = const AuthState(checking: true, offline: true);
      } else {
        await _clearStoredTokens();
        state = const AuthState(checking: false);
      }
    }
  }

  /// Best-effort local clear. A failure here must not mask the original outcome.
  Future<void> _clearStoredTokens() async {
    try {
      await _api.tokenStore.clear();
    } on Exception {
      // Nothing further can be done locally; the tokens are unusable anyway.
    }
  }

  /// Retries the startup validation after an offline launch. Called by the splash.
  Future<void> retryRestore() async {
    if (mounted) state = const AuthState(checking: true);
    await _restore();
  }

  Future<void> register({
    required String email,
    required String password,
    required bool termsAccepted,
    required bool privacyPolicyAccepted,
    required bool voiceConsent,
    String? displayName,
  }) async {
    await _api.register(
      email: email,
      password: password,
      termsAccepted: termsAccepted,
      privacyPolicyAccepted: privacyPolicyAccepted,
      displayName: displayName,
      voiceConsent: voiceConsent,
    );
  }

  Future<void> resendVerification({required String email}) =>
      _api.resendVerification(email: email);

  Future<void> requestPasswordRecovery({required String email}) =>
      _api.requestPasswordRecovery(email: email);

  Future<void> login({required String email, required String password}) async {
    final session = await _api.login(email: email, password: password);
    if (mounted) {
      _lastKnownProfile = session.profile;
      state = AuthState(profile: session.profile, checking: false);
    }
  }

  Future<void> signOut() async {
    try {
      await _api.logout();
    } finally {
      // The learner asked to sign out; the local session must be dropped even if the
      // call fails. Without the finally, a throw here left the pushed Settings route
      // on screen with tokens already cleared.
      if (mounted) state = const AuthState(checking: false);
    }
  }

  /// Completes onboarding and re-reads the profile, because the server stamps
  /// completion and the app must render what the server actually stored.
  Future<void> completeOnboarding({
    required String englishLevel,
    required String learningGoal,
    required int dailyGoalMinutes,
    String? preferredArabicVoice,
    String? preferredEnglishVoice,
  }) async {
    final profile = await _api.updateProfile(
      englishLevel: englishLevel,
      learningGoal: learningGoal,
      dailyGoalMinutes: dailyGoalMinutes,
      preferredArabicVoice: preferredArabicVoice,
      preferredEnglishVoice: preferredEnglishVoice,
      completeOnboarding: true,
    );
    if (mounted) state = AuthState(profile: profile, checking: false);
  }

  Future<void> refreshProfile() async {
    try {
      final profile = await _api.profile();
      if (mounted) state = AuthState(profile: profile, checking: false);
    } on SessionExpired {
      if (mounted) state = const AuthState(checking: false);
    }
  }

  Future<void> withdrawVoiceConsent() async {
    await _api.withdrawVoiceConsent();
    await refreshProfile();
  }

  Future<void> grantVoiceConsent() async {
    await _api.grantVoiceConsent();
    await refreshProfile();
  }

  /// Renames the learner. `null` clears the name, which the profile renders with
  /// its Arabic fallback rather than an empty gap.
  Future<void> updateDisplayName(String? displayName) async {
    final profile = await _api.updateProfile(displayName: displayName ?? '');
    if (mounted) state = AuthState(profile: profile, checking: false);
  }

  Future<void> updateDailyGoal(int minutes) async {
    final profile = await _api.updateProfile(dailyGoalMinutes: minutes);
    if (mounted) state = AuthState(profile: profile, checking: false);
  }

  Future<void> deleteAccount() async {
    await _api.deleteAccount();
    if (mounted) state = const AuthState(checking: false);
  }
}

final authControllerProvider = StateNotifierProvider<AuthController, AuthState>(
  (ref) {
    return AuthController(ref.watch(apiClientProvider));
  },
);

// ---------------------------------------------------------------------------
// Server data
// ---------------------------------------------------------------------------

/// Today's lesson plus its in-progress attempt, if any.
final todayLessonProvider = FutureProvider<TodayLesson>((ref) {
  return ref.watch(apiClientProvider).todayLesson();
});

final lessonsProvider = FutureProvider<List<Lesson>>((ref) {
  return ref.watch(apiClientProvider).lessons();
});

final lessonProvider = FutureProvider.family<Lesson, String>((ref, id) {
  return ref.watch(apiClientProvider).lesson(id);
});

final progressProvider = FutureProvider<Progress>((ref) {
  return ref.watch(apiClientProvider).progress();
});

final vocabularyProvider = FutureProvider<List<VocabularyItem>>((ref) {
  return ref.watch(apiClientProvider).vocabulary();
});

final usageProvider = FutureProvider<UsageSummary>((ref) {
  return ref.watch(apiClientProvider).usage();
});

final voicesProvider = FutureProvider<VoiceCatalog>((ref) {
  return ref.watch(apiClientProvider).voices();
});

final speakingHistoryProvider = FutureProvider<List<SpeakingAttempt>>((ref) {
  return ref.watch(apiClientProvider).speakingHistory();
});

/// Synthesises a phrase through the backend's cache-first route.
///
/// Exposed as a provider so several screens share one player and so playback
/// state survives a widget rebuild during a lesson.
final ttsProvider = Provider<TtsService>((ref) {
  return TtsService(ref.watch(apiClientProvider), ref.watch(ttsPlayerProvider));
});

class TtsService {
  TtsService(this._api, this._player);

  final ApiClient _api;
  final TtsAudioPlayer _player;

  /// Plays [text] and reports whether it came from the cache (free) or was
  /// synthesised. Errors are surfaced as [ApiError] for the caller to render.
  Future<({bool cacheHit, int credits})> speak({
    required String text,
    required String script,
    String? voiceId,
    String namespace = 'adhoc',
  }) async {
    final result = await _api.tts(
      text: text,
      script: script,
      voiceId: voiceId,
      namespace: namespace,
    );
    await _player.play(result.audio, contentType: 'audio/wav');
    return (cacheHit: result.cacheHit, credits: result.credits);
  }

  Future<void> stop() => _player.stop();
}

/// Maps an arbitrary thrown object onto learner-facing Arabic text.
///
/// One place decides what a learner reads for a failure, so no screen can leak a
/// provider message, a stack trace or a status code into the UI.
String userMessageFor(Object error) {
  if (error is ApiError) return error.messageAr;
  if (error is MicrophoneUnavailable) return error.messageAr;
  return 'صار خطأ غير متوقع. جرّب مرة ثانية.';
}

/// True when retrying the exact same action is worth offering.
bool isRetryable(Object error) => error is ApiError && error.retryable;

/// The WAV container the recorder produces; named here so screens do not build
/// MIME strings inline.
const String kWavContentType = 'audio/wav';

/// Test-only helper to build a client pointed at a fake server.
ApiClient buildTestClient({
  required String baseUrl,
  required TokenStore store,
}) => ApiClient(baseUrl: baseUrl, tokenStore: store);

/// Re-export so screens can type a recording result without importing dart:typed_data.
typedef RecordedAudio = Uint8List;
