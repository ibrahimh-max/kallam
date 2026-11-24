import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'src/config/app_config.dart';
import 'src/screens/auth/auth_screen.dart';
import 'src/screens/home/home_screen.dart';
import 'src/screens/onboarding/onboarding_screen.dart';
import 'src/state/providers.dart';
import 'src/theme/app_theme.dart';
import 'src/theme/tokens.dart';
import 'src/ui/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ProviderScope(child: SaudiEnglishTutorApp()));
}

/// Registers the bundled Arabic font and rebuilds once it is available.
///
/// Why this is a widget and not a step in `main()`: awaiting the font *before*
/// `runApp` deadlocks startup on web. `FontLoader.load()` never completes there
/// (observed directly — the page stayed blank white, with the engine attached
/// and no console error), so the first frame was never built. Painting first and
/// refreshing when the font arrives has the same end state without risking
/// startup.
///
/// Why refresh at all: Flutter web draws through CanvasKit, which resolves a
/// font only once it has loaded. Text laid out before that does not re-resolve
/// by itself, so the first screen showed missing-glyph boxes until something
/// forced a relayout. The rebuild below is that forced relayout, applied
/// deterministically instead of waiting for an incidental resize.
///
/// On Android and iOS the operating-system Arabic font covers these glyphs
/// already, so this is defence in depth there rather than a behaviour change.
/// A failure to load must never block the app: the platform font still renders
/// Arabic on both mobile platforms.
class _ArabicFontGate extends StatefulWidget {
  const _ArabicFontGate({required this.child});

  final Widget child;

  @override
  State<_ArabicFontGate> createState() => _ArabicFontGateState();
}

class _ArabicFontGateState extends State<_ArabicFontGate> {
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final loader = FontLoader('NotoNaskhArabic')
        ..addFont(rootBundle.load('assets/fonts/NotoNaskhArabic.ttf'));
      await loader.load();
    } catch (error) {
      debugPrint('Arabic font preload failed: $error');
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class SaudiEnglishTutorApp extends StatelessWidget {
  const SaudiEnglishTutorApp({super.key});

  @override
  Widget build(BuildContext context) {
    return _ArabicFontGate(
      child: MaterialApp(
        title: 'Saudi English Tutor',
        debugShowCheckedModeBanner: false,
        theme: buildAppTheme(),
        // Arabic is the app's primary language, so an Arabic device gets Arabic
        // Material strings; English devices fall back to English. The learner's own
        // content stays Arabic-first either way.
        supportedLocales: kSupportedLocales,
        locale: const Locale('ar'),
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        home: const _Root(),
      ),
    );
  }
}

/// Decides which screen the learner sees.
///
/// The decision is driven entirely by [authControllerProvider], which is fed by
/// the server's own `onboarding_completed` flag. That is why a reinstall cannot
/// skip onboarding, and why signing out anywhere in the app lands here rather
/// than on a stale screen.
class _Root extends ConsumerWidget {
  const _Root();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // A release build that was not told where the server is would otherwise talk
    // to an emulator alias. Fail loudly at startup instead.
    if (AppConfig.isMisconfigured) {
      return const Scaffold(
        body: ErrorState(
          message: 'هذا الإصدار ما تم إعداده للاتصال بالخدمة. تواصل مع الدعم.',
        ),
      );
    }

    final auth = ref.watch(authControllerProvider);
    if (auth.checking) {
      // Offline on launch with a still-stored session: the session is unknown, not
      // invalid, so offer a retry instead of a perpetual splash.
      if (auth.offline) {
        return Scaffold(
          body: ErrorState(
            message: 'ما قدرنا نتصل بالخدمة. تأكد من اتصالك بالإنترنت.',
            onRetry: () =>
                ref.read(authControllerProvider.notifier).retryRestore(),
          ),
        );
      }
      return const Scaffold(body: LoadingState(label: 'نجهّز لك الجلسة…'));
    }
    if (!auth.isSignedIn) return const AuthScreen();
    if (auth.needsOnboarding) return const OnboardingScreen();
    return const HomeScreen();
  }
}

/// A language toggle for the app's chrome is deliberately absent: the product is
/// an Arabic-first tutor for Arabic speakers, so a learner never has to switch the
/// interface language to use it.
const Color kAppBarTint = AppColors.surface;
