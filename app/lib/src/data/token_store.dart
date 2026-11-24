import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../data/models.dart';

/// Persists the session in the OS keychain/keystore.
///
/// Deliberately not `shared_preferences`: a refresh token is a long-lived
/// credential and a plaintext file readable by a rooted device or a backup is not
/// an acceptable place for it.
///
/// The abstraction exists so tests can use an in-memory store, and so a future
/// "sign out of all devices" can swap the implementation without touching the API
/// client.
abstract interface class TokenStore {
  Future<AuthTokens?> read();
  Future<void> write(AuthTokens tokens);
  Future<void> clear();
}

class SecureTokenStore implements TokenStore {
  SecureTokenStore({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              // flutter_secure_storage 11 encrypts by default on Android
              // (AES-GCM data with RSA-OAEP key wrapping in the Keystore), so no
              // extra option is needed; iOS gets first-unlock Keychain access so a
              // background refresh still works while the screen is locked.
              aOptions: AndroidOptions(),
              iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
            );

  final FlutterSecureStorage _storage;

  static const _key = 'session_tokens_v1';

  @override
  Future<AuthTokens?> read() async {
    final raw = await _storage.read(key: _key);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final tokens = AuthTokens.fromJson(decoded.map((k, v) => MapEntry(k.toString(), v)));
      return tokens.isValid ? tokens : null;
    } on FormatException {
      // A corrupted entry must not wedge the app on every launch: drop it and
      // fall through to the sign-in screen.
      await clear();
      return null;
    }
  }

  @override
  Future<void> write(AuthTokens tokens) async {
    await _storage.write(
      key: _key,
      value: jsonEncode({'access_token': tokens.accessToken, 'refresh_token': tokens.refreshToken}),
    );
  }

  @override
  Future<void> clear() async {
    await _storage.delete(key: _key);
  }
}

/// In-memory store for widget/unit tests.
class InMemoryTokenStore implements TokenStore {
  AuthTokens? _tokens;

  @override
  Future<AuthTokens?> read() async => _tokens;

  @override
  Future<void> write(AuthTokens tokens) async => _tokens = tokens;

  @override
  Future<void> clear() async => _tokens = null;
}
