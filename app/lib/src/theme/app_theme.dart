import 'package:flutter/material.dart';

import 'tokens.dart';

/// Builds the app theme from [AppColors]/[AppType]/[AppSpace].
///
/// No `fontFamily` override: the platform's own Arabic system font (Noto
/// Naskh/SF Arabic) renders Saudi Arabic correctly and ships with the OS, which
/// keeps the bundle small (FAST) and avoids a downloaded font that would break
/// on a low-end device mid-lesson.
///
/// `fontFamilyFallback` is not optional, though. Flutter web renders through
/// CanvasKit, which cannot reach OS fonts and only draws fonts registered with
/// the engine; the bundled Roboto is Latin-only, so every Arabic glyph came out
/// as a missing-glyph box. The fallback names the font bundled in `pubspec.yaml`
/// and is used only when the primary family lacks the glyph, so Android/iOS keep
/// using the OS font exactly as before.
ThemeData buildAppTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: AppColors.primary,
    primary: AppColors.primary,
    surface: AppColors.surface,
    error: AppColors.danger,
  );

  return ThemeData(
    useMaterial3: true,
    fontFamilyFallback: const <String>['NotoNaskhArabic'],
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.surface,
    splashFactory: InkSparkle.splashFactory,
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.surface,
      surfaceTintColor: Colors.transparent,
      foregroundColor: AppColors.text,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: AppType.subtitle,
    ),
    textTheme: const TextTheme(
      displaySmall: AppType.display,
      headlineSmall: AppType.title,
      titleMedium: AppType.subtitle,
      bodyLarge: AppType.body,
      labelLarge: AppType.label,
      bodySmall: AppType.caption,
    ).apply(bodyColor: AppColors.text, displayColor: AppColors.text),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: AppColors.primary,
        foregroundColor: Colors.white,
        disabledBackgroundColor: AppColors.muted,
        disabledForegroundColor: AppColors.textFaint,
        minimumSize: const Size.fromHeight(kMinTouchTarget + 8),
        textStyle: AppType.label.copyWith(fontSize: 16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.primary,
        minimumSize: const Size.fromHeight(kMinTouchTarget + 8),
        textStyle: AppType.label.copyWith(fontSize: 16),
        side: const BorderSide(color: AppColors.border),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.md)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: AppColors.primary, textStyle: AppType.label),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.surfaceRaised,
      contentPadding: const EdgeInsets.symmetric(horizontal: AppSpace.lg, vertical: AppSpace.md),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.md), borderSide: const BorderSide(color: AppColors.border)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.md), borderSide: const BorderSide(color: AppColors.border)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.md), borderSide: const BorderSide(color: AppColors.primary, width: 2)),
      errorBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.md), borderSide: const BorderSide(color: AppColors.danger)),
      focusedErrorBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(AppRadius.md), borderSide: const BorderSide(color: AppColors.danger, width: 2)),
    ),
    cardTheme: CardThemeData(
      color: AppColors.surfaceRaised,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.lg), side: const BorderSide(color: AppColors.border)),
    ),
    dividerTheme: const DividerThemeData(color: AppColors.border, thickness: 1, space: 1),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: AppColors.primary),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppColors.text,
      contentTextStyle: AppType.body.copyWith(color: Colors.white),
      behavior: SnackBarBehavior.floating,
    ),
  );
}

/// The app lays out RTL when the device language is Arabic, and LTR otherwise.
/// English phrases inside an RTL screen are wrapped in [Directionality] locally
/// rather than flipping the whole page.
const List<Locale> kSupportedLocales = [Locale('ar'), Locale('en')];
