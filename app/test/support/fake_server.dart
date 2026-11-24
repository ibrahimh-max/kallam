// A fake implementation of the backend's documented wire contract, driven
// through `package:http`'s own client interface so that widget tests exercise the
// real [ApiClient]: request paths, headers, JSON envelopes and error shapes are
// all handled exactly as the shipped app handles them.
//
// Why an injected client and not a socket to a loopback server: `testWidgets`
// runs the test body inside `AutomatedTestWidgetsFlutterBinding`, which controls
// the clock and the event loop. A real socket's completion events belong to the
// real event loop, so they are never delivered while fake async is advancing and
// the request simply never finishes. That is also why the binding installs
// `_MockHttpOverrides` (a 400 for every request) and why its own documentation
// says: "To test code that needs an HttpClient, provide your own HttpClient
// implementation to the code under test" (`_binding_io.dart:90-92`).
//
// So TCP transport is deliberately not tested here. It is covered where it can
// be tested for real: `server/tests/e2e-journey.mjs` drives the actual Node
// server over real HTTP and asserts the same journey. This file covers the layer
// above the transport - which screen the learner lands on, whether a local gate
// really prevents the request it claims to, and where an error is rendered.
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// One recorded inbound request, so a test can prove *whether* - and with what
/// body - the app called the server.
class FakeRequestRecord {
  FakeRequestRecord({
    required this.method,
    required this.path,
    required this.body,
    required this.headers,
  });

  final String method;
  final String path;
  final Map<String, dynamic> body;
  final Map<String, String> headers;

  String? get authorization => headers['authorization'];
}

class FakeBackend extends http.BaseClient {
  FakeBackend._();

  /// A syntactically valid origin. It is never dialled: every request is
  /// answered in memory by [send], so the value only has to be parseable by
  /// `Uri.parse` for the client to build request URIs.
  final String baseUrl = 'http://backend.test';

  /// Every request received, in order. Tests assert on this to distinguish
  /// "the UI showed an error" from "the UI showed an error *and never called the
  /// server*", which is the difference between a real gate and a message.
  final List<FakeRequestRecord> requests = <FakeRequestRecord>[];

  /// The profile returned by `GET /v1/profile`. Mutate it to change what the
  /// client sees between calls.
  Map<String, dynamic> profile = {
    'id': '11111111-1111-1111-1111-111111111111',
    'display_name': 'سارة',
    'english_level': 'beginner',
    'learning_goal': 'travel',
    'daily_goal_minutes': 15,
    'onboarding_completed': false,
    'preferred_arabic_voice': null,
    'preferred_english_voice': null,
    'voice_consent_granted': false,
  };

  /// When set, every request to [failPath] matches this canned error instead of
  /// succeeding. Format: `{status, code, message_ar}`.
  Map<String, dynamic>? failure;
  String? failPath;

  /// When true, requests to [failPath] fail at the transport instead of being
  /// answered, which is what an offline device actually looks like to the client
  /// (a thrown transport error, not an HTTP status).
  bool dropConnection = false;

  int get requestCount => requests.length;

  List<FakeRequestRecord> requestsTo(String path) =>
      requests.where((r) => r.path == path).toList();

  static Future<FakeBackend> start() async => FakeBackend._();

  /// Overrides [http.BaseClient.close] and releases nothing: this client owns no
  /// connection. Declared because tests close the backend in `tearDown`.
  @override
  Future<void> close() async {}

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final path = request.url.path;
    final rawBody = await request.finalize().bytesToString();

    Map<String, dynamic> body = const {};
    if (rawBody.isNotEmpty) {
      final decoded = jsonDecode(rawBody);
      if (decoded is Map) {
        body = decoded.map((k, v) => MapEntry(k.toString(), v));
      }
    }
    final headers = <String, String>{};
    request.headers.forEach(
      (name, value) => headers[name.toLowerCase()] = value,
    );

    requests.add(
      FakeRequestRecord(
        method: request.method,
        path: path,
        body: body,
        headers: headers,
      ),
    );

    if (failPath != null && failPath == path) {
      if (dropConnection) {
        // A thrown ClientException is how `package:http` reports a transport
        // failure, which is the same shape a refused connection or a dead
        // network produces against the real backend.
        throw http.ClientException('connection closed', request.url);
      }
      final failure = this.failure!;
      return _json(failure['status'] as int, {
        'error': {
          'code': failure['code'],
          'message_ar': failure['message_ar'],
          'message_en': failure['message_en'] ?? failure['code'],
          'retryable': failure['retryable'] ?? false,
          if (failure.containsKey('details')) 'details': failure['details'],
        },
      }, request);
    }

    if (path == '/v1/profile' && request.method == 'PATCH') {
      profile = {
        ...profile,
        if (body['display_name'] is String)
          'display_name': body['display_name'],
        if (body['english_level'] is String)
          'english_level': body['english_level'],
        if (body['learning_goal'] is String)
          'learning_goal': body['learning_goal'],
        if (body['daily_goal_minutes'] is int)
          'daily_goal_minutes': body['daily_goal_minutes'],
        if (body['complete_onboarding'] == true) 'onboarding_completed': true,
      };
      return _json(200, {'ok': true, 'profile': profile}, request);
    }

    if (path == '/v1/consent/grant') {
      profile = {...profile, 'voice_consent_granted': true};
      return _json(200, {
        'ok': true,
        'voice_processing_consent': true,
      }, request);
    }

    if (path == '/v1/consent/withdraw') {
      profile = {...profile, 'voice_consent_granted': false};
      return _json(200, {
        'ok': true,
        'voice_processing_consent': false,
      }, request);
    }

    return switch (path) {
      '/v1/auth/register' => _json(202, {
        'ok': true,
        'message_ar':
            'أرسلنا رابط التحقق إذا كان البريد متاحاً. أكّد بريدك أولاً، ثم سجّل الدخول.',
        'message_en': 'Check your email for a verification link, then sign in.',
      }, request),
      '/v1/auth/resend-verification' => _json(202, {'ok': true}, request),
      '/v1/auth/forgot-password' => _json(202, {'ok': true}, request),
      '/v1/auth/login' => _json(200, {
        'ok': true,
        'tokens': {'access_token': 'access-1', 'refresh_token': 'refresh-1'},
        'profile': profile,
      }, request),
      '/v1/profile' => _json(200, {'ok': true, 'profile': profile}, request),
      // No lesson authored in the fixture: the home screen must render its empty
      // state rather than crash on a missing object.
      '/v1/lessons/today' => _json(200, {'ok': true, 'lesson': null}, request),
      '/v1/lessons' => _json(200, {
        'ok': true,
        'lessons': const <dynamic>[],
      }, request),
      '/v1/progress' => _json(200, {
        'ok': true,
        'progress': const <String, dynamic>{},
      }, request),
      '/v1/vocabulary' => _json(200, {
        'ok': true,
        'vocabulary': const <dynamic>[],
      }, request),
      '/v1/usage' => _json(200, {
        'ok': true,
        'usage': const <String, dynamic>{},
      }, request),
      '/v1/voices' => _json(200, {
        'ok': true,
        'voices': const <dynamic>[],
      }, request),
      _ => _json(200, {'ok': true}, request),
    };
  }

  Future<http.StreamedResponse> _json(
    int status,
    Map<String, dynamic> payload,
    http.BaseRequest request,
  ) async {
    final bytes = utf8.encode(jsonEncode(payload));
    return http.StreamedResponse(
      Stream<List<int>>.value(bytes),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
      request: request,
    );
  }
}
