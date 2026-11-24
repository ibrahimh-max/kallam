// Widget tests for the flows that only exist in the UI, driven by a fake backend
// (`support/fake_server.dart`).
//
// These cover the gap the backend suite cannot reach: which screen the learner
// lands on, whether a local gate really prevents the request it claims to, and
// whether an error is rendered next to the field the server named.
//
// Every test pumps the real widget tree and the real [ApiClient]; only the
// token store is swapped for the in-memory implementation, so no OS keystore is
// needed on the test host.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:saudi_english_tutor/main.dart';
import 'package:saudi_english_tutor/src/data/api_client.dart';
import 'package:saudi_english_tutor/src/data/models.dart';
import 'package:saudi_english_tutor/src/data/token_store.dart';
import 'package:saudi_english_tutor/src/screens/auth/auth_screen.dart';
import 'package:saudi_english_tutor/src/screens/home/home_screen.dart';
import 'package:saudi_english_tutor/src/screens/onboarding/onboarding_screen.dart';
import 'package:saudi_english_tutor/src/state/providers.dart';

import 'support/fake_server.dart';

void main() {
  late FakeBackend backend;
  late InMemoryTokenStore store;

  setUp(() async {
    backend = await FakeBackend.start();
    store = InMemoryTokenStore();
  });

  tearDown(() async => backend.close());

  /// Pumps the shipped app, with its real [ApiClient] talking to the fake
  /// backend through `package:http`'s client interface.
  ///
  /// Injected rather than dialled: a socket to a loopback server cannot complete
  /// inside `testWidgets`, because its completion belongs to the real event loop
  /// while the binding is advancing a fake one. See `support/fake_server.dart`.
  ///
  /// `settle: false` is used where a screen would spin forever: a busy
  /// [PrimaryButton] shows a `CircularProgressIndicator`, and `pumpAndSettle`
  /// waits for animations to stop, so it would time out on a screen that is
  /// working correctly.
  Future<void> pumpApp(WidgetTester tester, {bool settle = true}) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(store),
          apiClientProvider.overrideWith(
            (ref) => ApiClient(
              baseUrl: backend.baseUrl,
              tokenStore: store,
              httpClient: backend,
            ),
          ),
        ],
        child: const SaudiEnglishTutorApp(),
      ),
    );
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      await tester.pump();
    }
  }

  Future<void> signIn(WidgetTester tester) async {
    // A stored, server-validated session is what puts a learner on the routing
    // decision at all.
    await store.write(
      const AuthTokens(accessToken: 'access-1', refreshToken: 'refresh-1'),
    );
  }

  group('startup routing', () {
    testWidgets('no stored session lands on the sign-in screen', (
      tester,
    ) async {
      await pumpApp(tester);

      expect(find.byType(AuthScreen), findsOneWidget);
      expect(find.byType(HomeScreen), findsNothing);
      expect(find.byType(OnboardingScreen), findsNothing);
      // Nothing was sent to the server: a signed-out device must not call the API.
      expect(backend.requestCount, 0);
    });

    testWidgets(
      'a validated session with onboarding pending lands on onboarding',
      (tester) async {
        await signIn(tester);
        backend.profile = {...backend.profile, 'onboarding_completed': false};

        await pumpApp(tester);

        // The decision comes from the server's own flag, which is why a reinstall
        // cannot skip onboarding.
        expect(find.byType(OnboardingScreen), findsOneWidget);
        expect(find.byType(HomeScreen), findsNothing);
        expect(find.byType(AuthScreen), findsNothing);
      },
    );

    testWidgets('a validated session with onboarding complete lands on home', (
      tester,
    ) async {
      await signIn(tester);
      backend.profile = {...backend.profile, 'onboarding_completed': true};

      await pumpApp(tester);

      expect(find.byType(HomeScreen), findsOneWidget);
      expect(find.byType(OnboardingScreen), findsNothing);
      expect(find.byType(AuthScreen), findsNothing);
      // The greeting is the learner's own name from the server profile.
      expect(find.textContaining('سارة'), findsWidgets);
    });
  });

  group('unreachable server at startup', () {
    testWidgets('offers a retry and keeps the session instead of signing out', (
      tester,
    ) async {
      await signIn(tester);
      backend
        ..failPath = '/v1/profile'
        ..dropConnection = true;

      await pumpApp(tester);

      // A dropped connection means the session is *unknown*, not invalid. Showing
      // the sign-in screen here would silently discard a perfectly good session.
      expect(find.byType(AuthScreen), findsNothing);
      expect(find.textContaining('ما قدرنا نتصل بالخدمة'), findsOneWidget);

      // The retry affordance must exist: a splash with no way forward is a dead
      // end. Asserted as the learner sees it - a real button carrying the retry
      // label - because asserting one Material class instead is how this test
      // could name a widget the screen never builds.
      expect(
        find.widgetWithText(FilledButton, 'جرّب مرة ثانية'),
        findsOneWidget,
      );

      // And the stored tokens are still there to retry with.
      expect(await store.read(), isNotNull);
    });
  });

  group('registration consent', () {
    Future<void> fillRegisterForm(
      WidgetTester tester, {
      bool acceptPolicies = true,
    }) async {
      await tester.tap(find.text('ما عندي حساب — أنشئ حساب جديد'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.widgetWithText(TextFormField, 'البريد الإلكتروني'),
        'sara@example.com',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'كلمة المرور'),
        'a-good-password',
      );
      await tester.pump();
      if (acceptPolicies) {
        await tester.ensureVisible(find.byType(CheckboxListTile).first);
        await tester.tap(find.byType(CheckboxListTile).at(0));
        await tester.pump();
        await tester.ensureVisible(find.byType(CheckboxListTile).at(1));
        await tester.tap(find.byType(CheckboxListTile).at(1));
        await tester.pump();
      }
    }

    Future<void> finishOnboarding(
      WidgetTester tester, {
      required bool grantVoiceConsent,
    }) async {
      expect(find.byType(OnboardingScreen), findsOneWidget);

      await tester.tap(find.text('مبتدئ تماماً'));
      await tester.pump();
      await tester.tap(find.text('التالي'));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('السفر'));
      await tester.tap(find.text('السفر'));
      await tester.pump();
      await tester.tap(find.text('التالي'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('التالي'));
      await tester.pumpAndSettle();
      expect(find.byType(CheckboxListTile), findsOneWidget);
      if (grantVoiceConsent) {
        await tester.tap(find.byType(CheckboxListTile));
        await tester.pump();
      }

      await tester.tap(find.text('ابدأ التعلم'));
      await tester.pumpAndSettle();
      expect(find.byType(HomeScreen), findsOneWidget);
    }

    Future<void> signInAfterRegistration(WidgetTester tester) async {
      expect(find.byType(AuthScreen), findsOneWidget);
      expect(
        find.text(
          'أرسلنا رابط التحقق إذا كان البريد متاحاً. أكّد بريدك أولاً، ثم سجّل الدخول.',
        ),
        findsOneWidget,
      );
      expect(
        await store.read(),
        isNull,
        reason: 'registration must not create an authenticated session',
      );
      await tester.tap(find.text('تسجيل الدخول'));
      await tester.pumpAndSettle();
      expect(find.byType(OnboardingScreen), findsOneWidget);
    }

    testWidgets(
      'new learner completes onboarding without granting optional voice consent',
      (tester) async {
        await pumpApp(tester);
        await fillRegisterForm(tester);

        await tester.tap(find.text('أنشئ حسابي'));
        await tester.pumpAndSettle();

        final calls = backend.requestsTo('/v1/auth/register');
        expect(calls, hasLength(1));
        expect(calls.single.body['voice_consent'], isFalse);
        expect(calls.single.body['accept_terms'], isTrue);
        expect(calls.single.body['accept_privacy_policy'], isTrue);
        expect(calls.single.body['email'], 'sara@example.com');
        expect(backend.profile['voice_consent_granted'], isFalse);

        await signInAfterRegistration(tester);
        await finishOnboarding(tester, grantVoiceConsent: false);
        expect(
          backend.requestsTo('/v1/profile').last.body['complete_onboarding'],
          isTrue,
        );
        expect(backend.requestsTo('/v1/consent/grant'), isEmpty);
        expect(backend.profile['voice_consent_granted'], isFalse);
      },
    );

    testWidgets(
      'new learner can explicitly grant voice consent during onboarding',
      (tester) async {
        await pumpApp(tester);
        await fillRegisterForm(tester);
        await tester.tap(find.text('أنشئ حسابي'));
        await tester.pumpAndSettle();

        await signInAfterRegistration(tester);
        await finishOnboarding(tester, grantVoiceConsent: true);

        expect(backend.requestsTo('/v1/consent/grant'), hasLength(1));
        expect(backend.profile['voice_consent_granted'], isTrue);
      },
    );

    testWidgets(
      'registration is blocked until both legal policies are accepted',
      (tester) async {
        await pumpApp(tester);
        await fillRegisterForm(tester, acceptPolicies: false);
        await tester.ensureVisible(find.text('أنشئ حسابي'));
        await tester.tap(find.text('أنشئ حسابي'));
        await tester.pumpAndSettle();

        expect(
          find.textContaining('وافق على شروط الخدمة وسياسة الخصوصية'),
          findsOneWidget,
        );
        expect(backend.requestsTo('/v1/auth/register'), isEmpty);
      },
    );
  });

  group('server-side validation error', () {
    testWidgets(
      'is shown next to the field the server named, not as a generic failure',
      (tester) async {
        backend
          ..failPath = '/v1/auth/login'
          ..failure = {
            'status': 400,
            'code': 'VALIDATION_FAILED',
            'message_ar': 'صيغة البريد غير صحيحة.',
            'message_en': 'invalid email',
            'details': {'field': 'email'},
          };

        await pumpApp(tester);

        await tester.enterText(
          find.widgetWithText(TextFormField, 'البريد الإلكتروني'),
          'sara@example.com',
        );
        await tester.enterText(
          find.widgetWithText(TextFormField, 'كلمة المرور'),
          'a-good-password',
        );
        await tester.tap(find.text('تسجيل الدخول'));
        await tester.pumpAndSettle();

        // The server's own Arabic message reaches the learner, attached to the
        // field it named.
        expect(find.text('صيغة البريد غير صحيحة.'), findsOneWidget);
        expect(find.textContaining('صار خطأ غير متوقع'), findsNothing);
      },
    );

    testWidgets(
      'a wrong password is reported as invalid credentials, not as an outage',
      (tester) async {
        backend
          ..failPath = '/v1/auth/login'
          ..failure = {
            'status': 401,
            'code': 'UNAUTHORIZED',
            'message_ar': 'البريد أو كلمة المرور غير صحيحة.',
            'message_en': 'invalid credentials',
          };

        await pumpApp(tester);

        await tester.enterText(
          find.widgetWithText(TextFormField, 'البريد الإلكتروني'),
          'sara@example.com',
        );
        await tester.enterText(
          find.widgetWithText(TextFormField, 'كلمة المرور'),
          'wrong-password',
        );
        await tester.tap(find.text('تسجيل الدخول'));
        await tester.pumpAndSettle();

        // A 401 on the unauthenticated login route is the server's answer, not an
        // expired session, so the learner must see the real reason.
        expect(
          find.textContaining('البريد أو كلمة المرور غير صحيحة'),
          findsOneWidget,
        );
        expect(find.textContaining('صار خطأ في الخدمة'), findsNothing);
      },
    );
  });

  group('local field validation', () {
    testWidgets('rejects a malformed email before any round trip', (
      tester,
    ) async {
      await pumpApp(tester);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'البريد الإلكتروني'),
        'not-an-email',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'كلمة المرور'),
        'a-good-password',
      );
      await tester.tap(find.text('تسجيل الدخول'));
      await tester.pumpAndSettle();

      expect(find.text('صيغة البريد غير صحيحة.'), findsOneWidget);
      expect(backend.requestsTo('/v1/auth/login'), isEmpty);
    });
  });

  group('email verification and recovery', () {
    testWidgets(
      'resend and recovery actions use the entered email without creating a session',
      (tester) async {
        await pumpApp(tester);
        await tester.enterText(
          find.widgetWithText(TextFormField, 'البريد الإلكتروني'),
          'sara@example.com',
        );

        await tester.tap(find.text('إعادة إرسال رسالة التحقق'));
        await tester.pumpAndSettle();
        expect(
          backend
              .requestsTo('/v1/auth/resend-verification')
              .single
              .body['email'],
          'sara@example.com',
        );
        expect(
          find.text('إذا كان البريد يحتاج تحقق، بنرسل رسالة جديدة.'),
          findsOneWidget,
        );

        await tester.tap(find.text('نسيت كلمة المرور؟'));
        await tester.pumpAndSettle();
        expect(
          backend.requestsTo('/v1/auth/forgot-password').single.body['email'],
          'sara@example.com',
        );
        expect(
          find.text(
            'إذا كان للحساب بريد مؤكد، بنرسل رابط استعادة كلمة المرور.',
          ),
          findsOneWidget,
        );
        expect(await store.read(), isNull);
      },
    );

    testWidgets('email actions reject a malformed address locally', (
      tester,
    ) async {
      await pumpApp(tester);
      await tester.enterText(
        find.widgetWithText(TextFormField, 'البريد الإلكتروني'),
        'not-an-email',
      );
      await tester.tap(find.text('نسيت كلمة المرور؟'));
      await tester.pumpAndSettle();

      expect(find.text('اكتب بريدك الإلكتروني بصيغة صحيحة.'), findsOneWidget);
      expect(backend.requestsTo('/v1/auth/forgot-password'), isEmpty);
    });
  });
}
