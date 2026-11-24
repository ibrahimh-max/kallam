import 'package:flutter/foundation.dart';

/// Where the app gets its server address from.
///
/// Compile-time via `--dart-define=API_BASE_URL=...`, never a hardcoded
/// production host in source, so the same build works against a laptop, a staging
/// server and production without a code change.
///
/// Development defaults are platform-aware: Chrome uses loopback, while the
/// Android emulator uses its host-machine alias. Release builds must provide an
/// explicit, non-local API origin.
class AppConfig {
  const AppConfig._();

  static const String _configuredBaseUrl = String.fromEnvironment('API_BASE_URL');

  /// True when the build was told about a real server explicitly.
  static const bool hasExplicitBaseUrl = bool.hasEnvironment('API_BASE_URL');

  static String get apiBaseUrl {
    final baseUrl = hasExplicitBaseUrl
        ? _configuredBaseUrl
        : kIsWeb
            ? 'http://127.0.0.1:8080'
            : 'http://10.0.2.2:8080';
    return baseUrl.replaceAll(RegExp(r'/+$'), '');
  }

  /// A release build must be given a real server. Checked by the app's startup
  /// and by `flutter test`, which fails fast instead of shipping a build that
  /// points at a developer machine or emulator alias.
  static bool get isMisconfigured =>
      const bool.fromEnvironment('dart.vm.product') &&
      (!hasExplicitBaseUrl ||
          apiBaseUrl.contains('10.0.2.2') ||
          apiBaseUrl.contains('localhost') ||
          apiBaseUrl.contains('127.0.0.1'));
}
