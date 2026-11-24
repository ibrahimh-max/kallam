import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Guards the Arabic font packaging.
///
/// Flutter web renders through CanvasKit, which cannot reach the operating
/// system's fonts and only draws fonts registered with the engine. The bundled
/// Roboto is Latin-only, so before this font was declared every Arabic glyph in
/// the app rendered as a missing-glyph box (observed in a real browser). These
/// tests fail loudly if the declaration or the file is ever removed, because
/// that regression is invisible to Android/iOS and to widget tests.
void main() {
  final pubspec = File('pubspec.yaml');

  test('pubspec declares the bundled Arabic font family', () {
    expect(pubspec.existsSync(), isTrue, reason: 'pubspec.yaml not found');

    final text = pubspec.readAsStringSync();

    expect(
      text.contains('family: NotoNaskhArabic'),
      isTrue,
      reason: 'the Arabic family must stay declared or web renders tofu boxes',
    );
    expect(
      text.contains('assets/fonts/NotoNaskhArabic.ttf'),
      isTrue,
      reason: 'the declared family needs its asset entry',
    );
  });

  test('the declared font file exists and is a real font', () {
    final font = File('assets/fonts/NotoNaskhArabic.ttf');

    expect(font.existsSync(), isTrue, reason: 'font asset missing from the tree');

    final bytes = font.readAsBytesSync();
    expect(bytes.length, greaterThan(100000), reason: 'too small to be a font');

    // A TrueType/OpenType font starts with 0x00010000, 'OTTO' or 'true'.
    final tag = String.fromCharCodes(bytes.sublist(0, 4));
    final ok = tag == 'OTTO' ||
        tag == 'true' ||
        bytes.sublist(0, 4).join(',') == '0,1,0,0';
    expect(ok, isTrue, reason: 'unexpected file signature: $tag');
  });

  test('the theme names the bundled family as its fallback', () {
    final theme = File('lib/src/theme/app_theme.dart').readAsStringSync();

    expect(
      theme.contains("fontFamilyFallback: const <String>['NotoNaskhArabic']"),
      isTrue,
      reason: 'theme must fall back to the bundled family it ships',
    );
  });

  /// Guards the startup deadlock, which no other test in this repo can see.
  ///
  /// Awaiting `FontLoader.load()` before `runApp` hangs on web: the future never
  /// completes, `runApp` is never reached, and the app serves a permanently blank
  /// white page with the engine attached and nothing in the console. It was
  /// measured in a real browser against the built bundle. The load therefore has
  /// to happen after the first frame.
  test('startup does not await the font before the first frame', () {
    final main = File('lib/main.dart').readAsStringSync();

    expect(
      RegExp(r'Future<void>\s+main\s*\(\s*\)\s*async').hasMatch(main),
      isFalse,
      reason: 'an async main() invites awaiting the font before runApp, which '
          'deadlocks web startup',
    );
    expect(
      main.contains('await _loadArabicFont'),
      isFalse,
      reason: 'awaiting the font before runApp leaves web on a blank first frame',
    );
    expect(
      main.contains('runApp('),
      isTrue,
      reason: 'main() must still start the app',
    );
  });

  test('the font is loaded after the first frame and triggers one rebuild', () {
    final main = File('lib/main.dart').readAsStringSync();

    expect(
      main.contains("FontLoader('NotoNaskhArabic')"),
      isTrue,
      reason: 'the bundled family must actually be loaded',
    );
    expect(
      main.contains('initState'),
      isTrue,
      reason: 'the load must start after the widget tree is mounted',
    );
    // The rebuild is what makes already-laid-out text re-resolve the font.
    expect(
      main.contains('setState('),
      isTrue,
      reason: 'text laid out before the font arrived must be forced to relayout',
    );
  });
}
