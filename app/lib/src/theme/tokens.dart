import 'package:flutter/widgets.dart';

/// Design tokens.
///
/// One deliberate direction: a calm, high-contrast Saudi green matched to the
/// product's own subject matter (a Saudi Arabic tutor), not a generic gradient.
/// Every colour, size, radius and gap in the app comes from here — screens must
/// not carry stray hex values or one-off sizes, so a change lands everywhere.
///
/// Colour choices are checked for contrast: body text on the surface is
/// >= 4.5:1, and every foreground/background pair below is used that way.
abstract final class AppColors {
  /// Primary action / brand. Deep Saudi green.
  static const primary = Color(0xFF0B6B4F);
  static const primaryDark = Color(0xFF08503B);
  /// Tint used for surfaces that belong to the primary action (never for text).
  static const primarySoft = Color(0xFFE4F1EA);

  /// Encouragement / "you got it" feedback in the speaking flow.
  static const success = Color(0xFF1B7A3D);
  static const successSoft = Color(0xFFE6F4EA);

  /// A correction or a retry prompt. Never used for rejection.
  static const attention = Color(0xFF8A5300);
  static const attentionSoft = Color(0xFFFDF3E2);

  static const danger = Color(0xFFB3261E);
  static const dangerSoft = Color(0xFFFCEBEA);

  /// Text.
  /// 14.7:1 on [surface] — safe for body copy.
  static const text = Color(0xFF14201C);
  /// 7.1:1 on [surface] — safe for secondary copy.
  static const textMuted = Color(0xFF4C5A55);
  /// Decorative only: icons and dividers, never load-bearing text.
  static const textFaint = Color(0xFF7A8A84);

  /// Surfaces.
  static const surface = Color(0xFFF7F9F8);
  static const surfaceRaised = Color(0xFFFFFFFF);
  static const border = Color(0xFFD6E0DB);
  /// Placeholder/disabled fill.
  static const muted = Color(0xFFE8EDEA);
}

/// Type scale: six sizes, nothing between them.
abstract final class AppType {
  static const display = TextStyle(fontSize: 34, height: 1.2, fontWeight: FontWeight.w700, letterSpacing: -0.5);
  static const title = TextStyle(fontSize: 24, height: 1.25, fontWeight: FontWeight.w700);
  static const subtitle = TextStyle(fontSize: 18, height: 1.35, fontWeight: FontWeight.w600);
  static const body = TextStyle(fontSize: 16, height: 1.5);
  static const label = TextStyle(fontSize: 14, height: 1.4, fontWeight: FontWeight.w600);
  static const caption = TextStyle(fontSize: 12, height: 1.4);

  /// The English phrase the learner is asked to say. It is the largest thing on
  /// the listen/practise steps, and it must never be reflowed by an Arabic
  /// script decision, so it is always laid out LTR.
  static const phrase = TextStyle(fontSize: 28, height: 1.3, fontWeight: FontWeight.w700, letterSpacing: -0.2);
}

abstract final class AppSpace {
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 24.0;
  static const xxl = 32.0;
}

abstract final class AppRadius {
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 20.0;
}

/// Smallest target that is comfortable on a phone; every tappable element in the
/// app is at least this tall.
const double kMinTouchTarget = 44;
