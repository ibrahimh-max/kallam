import 'package:flutter_test/flutter_test.dart';
import 'package:saudi_english_tutor/src/data/models.dart';

/// Parsing is defensive on purpose: a shape the server did not intend must surface
/// as a clear failure or a safe default, never as silently wrong data on screen.
void main() {
  group('PublicProfile', () {
    Map<String, dynamic> profileJson() => {
          'id': 'user-1',
          'display_name': 'سارة',
          'english_level': 'complete_beginner',
          'learning_goal': 'travel',
          'daily_goal_minutes': 10,
          'onboarding_completed': true,
          'preferred_arabic_voice': 'ar-uuid',
          'preferred_english_voice': 'en-uuid',
          'voice_consent_granted': true,
        };

    test('parses the documented snake_case wire DTO', () {
      final profile = PublicProfile.fromJson(profileJson());

      expect(profile.id, 'user-1');
      expect(profile.displayName, 'سارة');
      expect(profile.dailyGoalMinutes, 10);
      expect(profile.onboardingCompleted, isTrue);
      expect(profile.voiceConsentGranted, isTrue);
    });

    test('a missing onboarding flag means not completed, so onboarding is not skipped', () {
      final json = profileJson()..remove('onboarding_completed');
      expect(PublicProfile.fromJson(json).onboardingCompleted, isFalse);
    });

    test('a missing consent flag never reads as granted', () {
      final json = profileJson()..remove('voice_consent_granted');
      expect(PublicProfile.fromJson(json).voiceConsentGranted, isFalse);
    });

    test('a wrong type for consent is refused rather than coerced', () {
      // `"true"` as a string is a contract break; treating it as granted would let
      // the app record audio the server would then reject.
      final json = profileJson()..['voice_consent_granted'] = 'true';
      expect(PublicProfile.fromJson(json).voiceConsentGranted, isFalse);
    });

    test('empty or blank names fall back to the Arabic greeting', () {
      expect(PublicProfile.fromJson(profileJson()..remove('display_name')).greetingName, 'هلا');
      expect(PublicProfile.fromJson(profileJson()..['display_name'] = '   ').greetingName, 'هلا');
    });

    test('a real name is shown as given', () {
      expect(PublicProfile.fromJson(profileJson()..['display_name'] = 'نورة').greetingName, 'نورة');
    });

    test('an entirely empty object parses to safe defaults instead of throwing', () {
      final profile = PublicProfile.fromJson(const {});

      expect(profile.id, '');
      expect(profile.displayName, isNull);
      expect(profile.dailyGoalMinutes, isNull);
      expect(profile.onboardingCompleted, isFalse);
      expect(profile.voiceConsentGranted, isFalse);
    });
  });

  group('AuthTokens', () {
    test('is valid only when both tokens are present', () {
      expect(AuthTokens.fromJson(const {'access_token': 'a', 'refresh_token': 'r'}).isValid, isTrue);
      expect(AuthTokens.fromJson(const {'access_token': 'a'}).isValid, isFalse);
      expect(AuthTokens.fromJson(const {'access_token': '', 'refresh_token': 'r'}).isValid, isFalse);
      expect(AuthTokens.fromJson(const {}).isValid, isFalse);
    });
  });

  group('ApiError', () {
    ApiError failure(Map<String, dynamic> details) => ApiError(
          code: 'VALIDATION_FAILED',
          messageAr: 'تحقق من الحقل',
          messageEn: 'bad field',
          retryable: false,
          statusCode: 400,
          details: details,
        );

    test('names the field the server complained about', () {
      expect(failure({'field': 'email'}).field, 'email');
    });

    test('a missing or non-string field is null, not a misleading label', () {
      expect(failure(const {}).field, isNull);
      expect(failure({'field': 42}).field, isNull);
    });

    test('classification is driven by code, never by message text', () {
      expect(failure({'field': 'email'}).isQuotaExhausted, isFalse);
      expect(
        ApiError(code: 'QUOTA_EXHAUSTED', messageAr: 'x', messageEn: 'x', retryable: false).isQuotaExhausted,
        isTrue,
      );
      expect(
        ApiError(code: 'CONSENT_REQUIRED', messageAr: 'x', messageEn: 'x', retryable: false).isConsentRequired,
        isTrue,
      );
      expect(
        ApiError(code: 'RATE_LIMITED', messageAr: 'x', messageEn: 'x', retryable: true).isRateLimited,
        isTrue,
      );
    });

    test('a 401 is an auth failure even when the code is unfamiliar', () {
      expect(
        ApiError(code: 'SOMETHING_NEW', messageAr: 'x', messageEn: 'x', retryable: false, statusCode: 401)
            .isAuthFailure,
        isTrue,
      );
      expect(failure(const {}).isAuthFailure, isFalse);
    });

    test('a transport failure is retryable and carries no provider detail', () {
      final network = ApiError.network('socket closed');
      expect(network.code, 'NETWORK_UNAVAILABLE');
      expect(network.retryable, isTrue);
      expect(network.statusCode, isNull);
    });

    test('a malformed response is reported as malformed, not as a server fault', () {
      expect(ApiError.malformed().code, 'MALFORMED_RESPONSE');
      expect(ApiError.malformed().statusCode, isNull);
    });
  });

  group('Lesson parsing', () {
    test('reads camelCase domain entities inside a snake_case envelope', () {
      final lesson = Lesson.fromJson(const {
        'id': 'lesson-1',
        'slug': 'greetings',
        'title': 'Greetings',
        'titleAr': 'التحيات',
        'description': 'Say hello',
        'level': 'complete_beginner',
        'topic': 'daily',
        'durationMinutes': 5,
        'content': {
          'steps': [
            {
              'id': 'step-1',
              'kind': 'listen',
              'explanationAr': 'استمع للجملة',
              'english': 'Hello, how are you?',
              'arabicMeaning': 'مرحبا، كيف حالك؟',
              'audio': {'englishPhrase': 'Hello, how are you?', 'arabicExplanation': 'استمع'},
            },
          ],
          'comprehension': [
            {'prompt': 'Hello', 'questionAr': 'ما معنى؟', 'options': ['Hello', 'Bye'], 'answerIndex': 0},
          ],
          'speakingPrompts': [
            {'slug': 'greet-1', 'taskAr': 'قل مرحبا', 'taskEn': 'Say hello', 'modelAnswer': 'Hello', 'languageMode': 'english_only'},
          ],
          'vocabulary': [
            {'englishTerm': 'Hello', 'arabicMeaning': 'مرحبا', 'exampleSentence': 'Hello, Sara.'},
          ],
        },
      });

      expect(lesson.slug, 'greetings');
      expect(lesson.titleAr, 'التحيات');
      expect(lesson.durationMinutes, 5);
      expect(lesson.content.steps.single.english, 'Hello, how are you?');
      expect(lesson.content.comprehension.single.options, ['Hello', 'Bye']);
      expect(lesson.content.comprehension.single.answerIndex, 0);
      expect(lesson.content.speakingPrompts.single.slug, 'greet-1');
      expect(lesson.content.vocabulary.single.arabicMeaning, 'مرحبا');
    });

    test('a listen step falls back to its English when no audio cue was authored', () {
      final withAudio = LessonStep.fromJson(const {
        'english': 'Hello',
        'audio': {'englishPhrase': 'Hello there'},
      });
      final withoutAudio = LessonStep.fromJson(const {'english': 'Hello'});

      expect(withAudio.listenText, 'Hello there');
      expect(withoutAudio.listenText, 'Hello');
      expect(LessonStep.fromJson(const {}).listenText, isNull);
    });

    test('absent collections become empty lists, so a lesson screen cannot crash', () {
      final lesson = Lesson.fromJson(const {'id': 'x', 'slug': 'y'});

      expect(lesson.content.steps, isEmpty);
      expect(lesson.content.comprehension, isEmpty);
      expect(lesson.content.speakingPrompts, isEmpty);
      expect(lesson.content.vocabulary, isEmpty);
      expect(lesson.durationMinutes, 0);
      expect(lesson.level, 'complete_beginner');
    });

    test('a null inside a collection does not throw or lose a list slot', () {
      final lesson = Lesson.fromJson(const {
        'id': 'x',
        'content': {
          'vocabulary': [
            null,
            {'englishTerm': 'Thank you', 'arabicMeaning': 'شكرا', 'exampleSentence': 'Thank you.'},
          ],
        },
      });

      expect(lesson.content.vocabulary.length, 2);
      expect(lesson.content.vocabulary.first.englishTerm, '');
      expect(lesson.content.vocabulary.last.englishTerm, 'Thank you');
    });

    test('a wrong-typed collection is treated as absent, not a crash', () {
      final lesson = Lesson.fromJson(const {'id': 'x', 'content': {'vocabulary': 'not-a-list'}});
      expect(lesson.content.vocabulary, isEmpty);
    });
  });

  group('SpeakingEvaluation', () {
    test('a retry-required verdict keeps its Arabic reason separate from a correction', () {
      final evaluation = SpeakingEvaluation.fromJson(const {
        'retry_required': true,
        'retry_reason_ar': 'ما سمعنا كلام واضح',
        'encouragement_ar': 'جرّب مرة ثانية',
        'corrections': [],
      });

      expect(evaluation.retryRequired, isTrue);
      expect(evaluation.retryReasonAr, 'ما سمعنا كلام واضح');
      expect(evaluation.corrections, isEmpty);
    });

    test('a correction keeps its type, original, suggestion and Arabic explanation', () {
      final evaluation = SpeakingEvaluation.fromJson(const {
        'retry_required': false,
        'encouragement_ar': 'أحسنت',
        'match_method': 'exact',
        'corrections': [
          {
            'type': 'grammar',
            'original': 'I am go',
            'suggested': 'I am going',
            'explanation_ar': 'ناقص كلمة',
          },
        ],
      });

      final correction = evaluation.corrections.single;
      expect(correction.type, 'grammar');
      expect(correction.original, 'I am go');
      expect(correction.suggested, 'I am going');
      expect(correction.explanationAr, 'ناقص كلمة');
      expect(evaluation.matchMethod, 'exact');
    });

    test('missing fields default to the no-retry, no-correction case', () {
      final evaluation = SpeakingEvaluation.fromJson(const {});

      expect(evaluation.retryRequired, isFalse);
      expect(evaluation.corrections, isEmpty);
      expect(evaluation.retryReasonAr, isNull);
      expect(evaluation.understood, isFalse);
      expect(evaluation.matchMethod, 'none');
    });

    test('an unknown correction type still gets a readable Arabic label', () {
      // The client must never guess a cause, but it still has to render one.
      expect(Correction.fromJson(const {}).labelAr, 'قواعد');
      expect(Correction.fromJson(const {'type': 'word_choice'}).labelAr, 'اختيار كلمة');
      expect(Correction.fromJson(const {'type': 'invented_by_server'}).labelAr, 'ملاحظة');
    });
  });

  group('SpeakingOutcome', () {
    test('reads the attempt id from the nested entity the server returns', () {
      final outcome = SpeakingOutcome.fromJson(const {
        'attempt': {'id': 'attempt-1'},
        'transcript': 'I am fine',
        'evaluation': {'encouragement_ar': 'أحسنت', 'corrections': []},
      });

      expect(outcome.attemptId, 'attempt-1');
      expect(outcome.transcript, 'I am fine');
      expect(outcome.evaluation.encouragementAr, 'أحسنت');
    });

    test('accepts the flat attempt_id form as a fallback', () {
      expect(SpeakingOutcome.fromJson(const {'attempt_id': 'attempt-2'}).attemptId, 'attempt-2');
    });

    test('an empty transcript is preserved as empty, never invented', () {
      final outcome = SpeakingOutcome.fromJson(const {
        'attempt_id': 'a',
        'transcript': '',
        'evaluation': {},
      });
      expect(outcome.transcript, isEmpty);
    });

    test('a history entry with its transcript cleared by retention still parses', () {
      final attempt = SpeakingAttempt.fromJson(const {
        'id': 'attempt-3',
        'promptSlug': 'greet-1',
        'createdAt': '2026-01-01T00:00:00.000Z',
      });

      expect(attempt.transcript, isNull);
      expect(attempt.evaluation, isNull);
      expect(attempt.promptSlug, 'greet-1');
    });
  });
}
