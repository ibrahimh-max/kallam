import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import 'models.dart';
import 'token_store.dart';

/// The app's single HTTP entry point.
///
/// Every server call goes through here so that three rules hold everywhere and
/// cannot be forgotten in a screen:
///
///  1. **Errors are typed.** [ApiError] carries the server's stable `code` plus
///     its Arabic message. Screens branch on `code`, never on message text.
///  2. **A dead session is handled once.** A 401 triggers a single-flight refresh
///     and one retry; if refresh fails the session is cleared and
///     [SessionExpired] is thrown so the router sends the learner to sign-in —
///     it is never reported as a random error on a lesson screen.
///  3. **Retries cannot bill twice.** Any call that spends credits passes an
///     idempotency key, so a flaky-connection retry replays the stored response.
///
/// No provider credential ever reaches this layer: the app talks only to our
/// backend (SECURE), and the HUMAIN key stays in the server's environment.
class ApiClient {
  ApiClient({
    required this.baseUrl,
    required this.tokenStore,
    http.Client? httpClient,
  }) : _http = httpClient ?? http.Client(),
       _ownsClient = httpClient == null;

  /// Convenience constructor for the running app.
  factory ApiClient.production({
    required TokenStore tokenStore,
    http.Client? httpClient,
  }) => ApiClient(
    baseUrl: AppConfig.apiBaseUrl,
    tokenStore: tokenStore,
    httpClient: httpClient,
  );

  final String baseUrl;
  final TokenStore tokenStore;
  final http.Client _http;
  final bool _ownsClient;

  /// Long enough for a slow 3G upload of a short clip, short enough that a dead
  /// connection does not leave a spinner forever.
  static const Duration requestTimeout = Duration(seconds: 30);

  Future<void>? _refreshInFlight;
  Future<void> Function()? _onSessionLostCallback;

  /// Called when the session ends for good, so the app can reset its navigation.
  /// The router owns that decision; this layer only reports the fact.
  set onSessionLost(Future<void> Function() callback) =>
      _onSessionLostCallback = callback;

  void dispose() {
    if (_ownsClient) _http.close();
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  Future<void> register({
    required String email,
    required String password,
    required bool termsAccepted,
    required bool privacyPolicyAccepted,
    String? displayName,
    required bool voiceConsent,
  }) async {
    await _send(
      'POST',
      '/v1/auth/register',
      body: {
        'email': email,
        'password': password,
        'accept_terms': termsAccepted,
        'accept_privacy_policy': privacyPolicyAccepted,
        if (displayName != null && displayName.isNotEmpty)
          'display_name': displayName,
        'voice_consent': voiceConsent,
      },
      authenticated: false,
    );
  }

  Future<void> resendVerification({required String email}) async {
    await _send(
      'POST',
      '/v1/auth/resend-verification',
      body: {'email': email},
      authenticated: false,
    );
  }

  Future<void> requestPasswordRecovery({required String email}) async {
    await _send(
      'POST',
      '/v1/auth/forgot-password',
      body: {'email': email},
      authenticated: false,
    );
  }

  Future<AuthSession> login({
    required String email,
    required String password,
  }) async {
    final json = await _send(
      'POST',
      '/v1/auth/login',
      body: {'email': email, 'password': password},
      authenticated: false,
    );
    final session = AuthSession.fromJson(json);
    _requireValidSession(session);
    await tokenStore.write(session.tokens);
    return session;
  }

  /// Ends the session server-side (which revokes the refresh token), then
  /// locally. A server failure must not strand the learner signed in on the
  /// device, so the local clear always happens.
  Future<void> logout() async {
    try {
      await _send('POST', '/v1/auth/logout', body: const <String, dynamic>{});
    } on ApiError {
      // Already gone or unreachable; clearing locally is the correct outcome.
    } on SessionExpired {
      // The token was already rejected server-side. Same outcome, and without this
      // the caller never reaches its own navigation reset.
    } finally {
      await tokenStore.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Profile / onboarding
  // ---------------------------------------------------------------------------

  Future<PublicProfile> profile() async {
    final json = await _send('GET', '/v1/profile');
    return PublicProfile.fromJson(_asMap(json['profile']));
  }

  Future<PublicProfile> updateProfile({
    String? displayName,
    String? englishLevel,
    String? learningGoal,
    int? dailyGoalMinutes,
    String? preferredArabicVoice,
    String? preferredEnglishVoice,
    bool completeOnboarding = false,
  }) async {
    final json = await _send(
      'PATCH',
      '/v1/profile',
      body: {
        'display_name': ?displayName,
        'english_level': ?englishLevel,
        'learning_goal': ?learningGoal,
        'daily_goal_minutes': ?dailyGoalMinutes,
        'preferred_arabic_voice': ?preferredArabicVoice,
        'preferred_english_voice': ?preferredEnglishVoice,
        if (completeOnboarding) 'complete_onboarding': true,
      },
    );
    return PublicProfile.fromJson(_asMap(json['profile']));
  }

  Future<void> withdrawVoiceConsent() async {
    await _send(
      'POST',
      '/v1/consent/withdraw',
      body: {'consent_type': 'voice_processing'},
    );
  }

  /// Re-grants voice processing consent. Withdrawal is reversible on purpose: a
  /// learner who changes their mind must not lose the core exercise forever.
  Future<void> grantVoiceConsent() async {
    await _send(
      'POST',
      '/v1/consent/grant',
      body: {'consent_type': 'voice_processing'},
    );
  }

  /// Requests account deletion. The server revokes sessions immediately and
  /// purges the rows after the grace period, so the device must forget its tokens.
  Future<String> deleteAccount() async {
    final json = await _send('DELETE', '/v1/account');
    await tokenStore.clear();
    final note = json['note_ar'];
    return note is String ? note : 'حُذف حسابك.';
  }

  // ---------------------------------------------------------------------------
  // Lessons
  // ---------------------------------------------------------------------------

  Future<List<Lesson>> lessons() async {
    final json = await _send('GET', '/v1/lessons');
    return _asList(
      json['lessons'],
    ).map((l) => Lesson.fromJson(_asMap(l))).toList(growable: false);
  }

  /// Today's lesson, chosen server-side, plus any in-progress attempt and whether
  /// this lesson was already completed (so the UI can say "revise" instead of
  /// "start"). The server raises UNKNOWN_LESSON only when no lesson is published
  /// at all — the app renders that as an empty state, not a crash.
  Future<TodayLesson> todayLesson() async {
    final json = await _send('GET', '/v1/lessons/today');
    final lesson = json['lesson'];
    final attempt = json['attempt'];
    return TodayLesson(
      lesson: lesson == null ? null : Lesson.fromJson(_asMap(lesson)),
      attempt: attempt == null ? null : LessonAttempt.fromJson(_asMap(attempt)),
      completed: json['completed'] == true,
    );
  }

  Future<Lesson> lesson(String lessonId) async {
    final json = await _send('GET', '/v1/lessons/$lessonId');
    return Lesson.fromJson(_asMap(json['lesson']));
  }

  Future<LessonAttempt> startAttempt(String lessonId) async {
    final json = await _send(
      'POST',
      '/v1/lessons/$lessonId/attempts',
      body: const <String, dynamic>{},
    );
    return LessonAttempt.fromJson(_asMap(json['attempt']));
  }

  Future<({int vocabularySaved, LessonAttempt? attempt})> completeAttempt({
    required String attemptId,
    double? comprehensionScore,
    bool saveVocabulary = true,
  }) async {
    final json = await _send(
      'POST',
      '/v1/attempts/$attemptId/complete',
      body: {
        'comprehension_score': ?comprehensionScore,
        'save_vocabulary': saveVocabulary,
      },
    );
    final saved = json['vocabulary_saved'];
    final attempt = json['attempt'];
    return (
      vocabularySaved: saved is num ? saved.toInt() : 0,
      attempt: attempt == null ? null : LessonAttempt.fromJson(_asMap(attempt)),
    );
  }

  // ---------------------------------------------------------------------------
  // Voices / TTS
  // ---------------------------------------------------------------------------

  Future<VoiceCatalog> voices() async {
    final json = await _send('GET', '/v1/voices');
    return VoiceCatalog.fromJson(json);
  }

  /// Synthesises [text], or returns the cached audio. The server reports cache
  /// state and credit cost in headers; both are surfaced so the app can show the
  /// learner when a phrase was free.
  Future<({Uint8List audio, bool cacheHit, int credits})> tts({
    required String text,
    required String script,
    String? voiceId,
    String namespace = 'adhoc',
  }) async {
    final response = await _sendRaw(
      'POST',
      '/v1/tts',
      body: {
        'text': text,
        'script': script,
        'voice_id': ?voiceId,
        'namespace': namespace,
      },
      authenticated: true,
      retryOn401: true,
    );
    return (
      audio: response.bodyBytes,
      cacheHit: response.headers['x-tts-cache'] == 'hit',
      credits: int.tryParse(response.headers['x-tts-credits'] ?? '') ?? 0,
    );
  }

  // ---------------------------------------------------------------------------
  // Speaking
  // ---------------------------------------------------------------------------

  /// Uploads a WAV clip and returns the bounded evaluation.
  ///
  /// [idempotencyKey] must be stable across retries of the *same* attempt: it is
  /// what stops a network retry from being billed twice, and the server answers a
  /// reused key with a different payload as a 409 conflict.
  Future<SpeakingOutcome> transcribe({
    required String promptSlug,
    required Uint8List wav,
    required String idempotencyKey,
    String? lessonAttemptId,
  }) async {
    final json = await _send(
      'POST',
      '/v1/speaking/transcribe',
      body: {
        'prompt_slug': promptSlug,
        'mime_type': 'audio/wav',
        'duration_seconds': _durationOf(wav),
        'audio_base64': base64Encode(wav),
        'lesson_attempt_id': ?lessonAttemptId,
      },
      idempotencyKey: idempotencyKey,
      // A retry after a timeout is exactly the case idempotency exists for.
      retryOnTimeout: true,
    );
    return SpeakingOutcome.fromJson(json);
  }

  /// Typed practice: the same evaluation rules with no provider call and no cost.
  Future<SpeakingEvaluation> evaluate({
    required String promptSlug,
    required String transcript,
  }) async {
    final json = await _send(
      'POST',
      '/v1/speaking/evaluate',
      body: {'prompt_slug': promptSlug, 'transcript': transcript},
    );
    return SpeakingEvaluation.fromJson(_asMap(json['evaluation']));
  }

  Future<List<SpeakingAttempt>> speakingHistory({int limit = 20}) async {
    final json = await _send('GET', '/v1/speaking/history?limit=$limit');
    return _asList(
      json['attempts'],
    ).map((a) => SpeakingAttempt.fromJson(_asMap(a))).toList(growable: false);
  }

  // ---------------------------------------------------------------------------
  // Progress / vocabulary / usage
  // ---------------------------------------------------------------------------

  Future<Progress> progress() async {
    final json = await _send('GET', '/v1/progress');
    return Progress.fromJson(_asMap(json['progress']));
  }

  Future<List<VocabularyItem>> vocabulary() async {
    final json = await _send('GET', '/v1/vocabulary');
    return _asList(
      json['items'],
    ).map((v) => VocabularyItem.fromJson(_asMap(v))).toList(growable: false);
  }

  Future<VocabularyItem> reviewVocabulary(
    String itemId, {
    required String reviewState,
  }) async {
    final json = await _send(
      'POST',
      '/v1/vocabulary/$itemId/review',
      body: {'review_state': reviewState},
    );
    return VocabularyItem.fromJson(_asMap(json['item']));
  }

  Future<UsageSummary> usage() async {
    final json = await _send('GET', '/v1/usage');
    return UsageSummary.fromJson(_asMap(json['usage']));
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  double _durationOf(Uint8List wav) {
    // 16 kHz mono 16-bit, the format the recorder captures.
    const bytesPerSecond = 16000 * 2;
    final pcm = wav.length > 44 ? wav.length - 44 : 0;
    final seconds = pcm / bytesPerSecond;
    // Never report 0: the server rejects a non-positive duration and it would be
    // a silent failure on a very short clip.
    return seconds <= 0 ? 0.1 : double.parse(seconds.toStringAsFixed(2));
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Object? body,
    bool authenticated = true,
    String? idempotencyKey,
    bool retryOnTimeout = false,
  }) async {
    final response = await _sendRaw(
      method,
      path,
      body: body,
      authenticated: authenticated,
      idempotencyKey: idempotencyKey,
      retryOn401: authenticated,
      retryOnTimeout: retryOnTimeout,
    );
    if (response.bodyBytes.isEmpty) return const <String, dynamic>{};
    try {
      final decoded = jsonDecode(utf8.decode(response.bodyBytes));
      return _asMap(decoded);
    } on FormatException {
      throw ApiError.malformed('response was not JSON');
    }
  }

  Future<http.Response> _sendRaw(
    String method,
    String path, {
    Object? body,
    bool authenticated = true,
    String? idempotencyKey,
    bool retryOn401 = false,
    bool retryOnTimeout = false,
  }) async {
    try {
      final first = await _attempt(
        method,
        path,
        body: body,
        authenticated: authenticated,
        idempotencyKey: idempotencyKey,
      );
      if (first.statusCode == 401 && authenticated && retryOn401) {
        // The access token may simply have expired. Refresh once (single-flight so
        // parallel calls share it) and replay; a refresh failure ends the session.
        await _refreshTokens();
        final retried = await _attempt(
          method,
          path,
          body: body,
          authenticated: authenticated,
          idempotencyKey: idempotencyKey,
        );
        return _check(retried, authenticated: authenticated);
      }
      return _check(first, authenticated: authenticated);
    } on TimeoutException {
      if (!retryOnTimeout || idempotencyKey == null) {
        throw ApiError.network('request timed out');
      }
      // Only an idempotent call may be replayed: the server will return the stored
      // response instead of charging again.
      final retried = await _attempt(
        method,
        path,
        body: body,
        authenticated: authenticated,
        idempotencyKey: idempotencyKey,
      );
      return _check(retried, authenticated: authenticated);
    } on http.ClientException catch (error) {
      throw ApiError.network(error.message);
    }
  }

  Future<http.Response> _attempt(
    String method,
    String path, {
    Object? body,
    required bool authenticated,
    String? idempotencyKey,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = <String, String>{'accept': 'application/json'};
    if (body != null) headers['content-type'] = 'application/json';
    if (idempotencyKey != null) headers['idempotency-key'] = idempotencyKey;

    if (authenticated) {
      final tokens = await tokenStore.read();
      if (tokens == null) {
        // No session at all: fail as an auth failure so the app routes to sign-in
        // rather than sending an anonymous request that would 401 anyway.
        throw _sessionExpired();
      }
      headers['authorization'] = 'Bearer ${tokens.accessToken}';
    }

    final request = http.Request(method, uri)..headers.addAll(headers);
    if (body != null) request.body = jsonEncode(body);
    final streamed = await _http.send(request).timeout(requestTimeout);
    return http.Response.fromStream(streamed);
  }

  /// Turns a raw response into either the body or a typed [ApiError].
  ///
  /// A 401 only means "the stored session is gone" on a call that actually sent a
  /// token. On the unauthenticated calls (register, login, refresh) a 401 is the
  /// server's own answer — wrong credentials, revoked refresh token — and must
  /// surface as its real error, otherwise a learner who mistypes a password is
  /// told "something went wrong" and cannot tell it apart from an outage.
  http.Response _check(http.Response response, {required bool authenticated}) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return response;
    }
    if (response.statusCode == 401 && authenticated) throw _sessionExpired();
    throw _parseError(response);
  }

  ApiError _parseError(http.Response response) {
    try {
      final decoded = jsonDecode(utf8.decode(response.bodyBytes));
      final map = _asMap(decoded);
      final error = map['error'];
      if (error is Map) {
        final fields = _asMap(error);
        final code = fields['code'];
        if (code is String) {
          final details = fields['details'];
          return ApiError(
            code: code,
            messageAr: fields['message_ar'] is String
                ? fields['message_ar'] as String
                : 'صار خطأ. جرّب مرة ثانية.',
            messageEn: fields['message_en'] is String
                ? fields['message_en'] as String
                : code,
            retryable: fields['retryable'] == true,
            statusCode: response.statusCode,
            details: details is Map ? _asMap(details) : null,
          );
        }
      }
    } on FormatException {
      // Fall through to the generic mapping below.
    }
    // A non-JSON error body (a proxy, a gateway page) must not crash the app and
    // must not be shown raw to the learner.
    return ApiError(
      code: response.statusCode >= 500 ? 'INTERNAL' : 'MALFORMED_RESPONSE',
      messageAr: response.statusCode >= 500
          ? 'صار خطأ في الخدمة. جرّب مرة ثانية.'
          : 'ما قدرنا ننفذ الطلب. جرّب مرة ثانية.',
      messageEn: 'unexpected status ${response.statusCode}',
      retryable: response.statusCode >= 500,
      statusCode: response.statusCode,
    );
  }

  /// Single-flight refresh: concurrent 401s share one refresh call, so a burst of
  /// requests on app resume cannot invalidate its own rotating token.
  Future<void> _refreshTokens() {
    return _refreshInFlight ??= _performRefresh().whenComplete(
      () => _refreshInFlight = null,
    );
  }

  Future<void> _performRefresh() async {
    final tokens = await tokenStore.read();
    if (tokens == null) throw _sessionExpired();
    try {
      final response = await _attempt(
        'POST',
        '/v1/auth/refresh',
        body: {'refresh_token': tokens.refreshToken},
        authenticated: false,
      );
      // The opaque refresh token is sufficient; an expired access token is not sent.
      final checked = _check(response, authenticated: false);
      final parsed = _asMap(jsonDecode(utf8.decode(checked.bodyBytes)));
      final session = AuthSession.fromJson(parsed);
      if (!session.tokens.isValid) throw _sessionExpired();
      await tokenStore.write(session.tokens);
    } on ApiError {
      await tokenStore.clear();
      // Let the app react (reset navigation) before the caller sees the throw.
      await _onSessionLostCallback?.call();
      throw SessionExpired();
    } on SessionExpired {
      // Also catch our own signal: previously a malformed rotation response threw
      // SessionExpired straight past this handler, so the stale tokens were left in
      // the keystore instead of being cleared.
      await tokenStore.clear();
      await _onSessionLostCallback?.call();
      rethrow;
    }
  }

  SessionExpired _sessionExpired() {
    // Fire and forget: the router reacts via the auth state, and awaiting here
    // would deadlock the request that discovered the expiry.
    final callback = _onSessionLostCallback;
    if (callback != null) unawaited(callback());
    return SessionExpired();
  }

  void _requireValidSession(AuthSession session) {
    if (!session.tokens.isValid) {
      throw ApiError.malformed('auth response carried no usable tokens');
    }
  }

  static Map<String, dynamic> _asMap(Object? value) => value is Map
      ? value.map((k, v) => MapEntry(k.toString(), v))
      : const <String, dynamic>{};

  static List<dynamic> _asList(Object? value) =>
      value is List ? value : const <dynamic>[];
}

/// The session is over and the learner must sign in again.
///
/// Separate from [ApiError] because it is not a failure to *report* — it is a
/// navigation event, and the router handles it before any screen renders an error.
class SessionExpired implements Exception {
  @override
  String toString() => 'SessionExpired';
}
