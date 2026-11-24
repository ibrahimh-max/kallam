/// Domain models mirrored from the server's `server/src/domain/models.ts`.
///
/// Wire rule (verified against the running server in `server/tests/e2e-journey.mjs`):
/// request and control fields are `snake_case`, and a returned *domain entity*
/// keeps the developer-facing camelCase shape declared in the server's models.
/// `PublicProfile` is the documented exception — it is an explicit wire DTO and is
/// fully snake_case. Both are parsed here exactly as observed; `unknown` values are
/// never coerced into a wrong type, so a contract change surfaces as a clear
/// parse error instead of silently wrong data on screen.
library;

/// Parses only when the value really is a JSON object.
Map<String, dynamic> _obj(Object? value) =>
    value is Map ? value.map((k, v) => MapEntry(k.toString(), v)) : const <String, dynamic>{};

List<dynamic> _list(Object? value) => value is List ? value : const <dynamic>[];

String? _string(Object? value) => value is String ? value : null;
int? _int(Object? value) => value is num ? value.toInt() : null;
bool _bool(Object? value) => value == true;

/// A server-issued error, parsed from the documented `{ error: {...} }` body.
///
/// The app branches on [code] (never on message text) so a retry decision is not
/// affected by wording, and shows [messageAr] to the learner.
class ApiError implements Exception {
  ApiError({
    required this.code,
    required this.messageAr,
    required this.messageEn,
    required this.retryable,
    this.statusCode,
    this.details,
  });

  /// Socket/transport failure — never had a response, so no server code exists.
  factory ApiError.network([String? detail]) => ApiError(
        code: 'NETWORK_UNAVAILABLE',
        messageAr: 'ما قدرنا نوصل للخدمة. تأكد من الإنترنت وجرّب مرة ثانية.',
        messageEn: detail ?? 'Could not reach the server.',
        retryable: true,
      );

  /// A response that did not match the documented contract.
  factory ApiError.malformed([String? detail]) => ApiError(
        code: 'MALFORMED_RESPONSE',
        messageAr: 'صار خطأ غير متوقع. جرّب مرة ثانية.',
        messageEn: detail ?? 'Unexpected response shape.',
        retryable: true,
      );

  final String code;
  final String messageAr;
  final String messageEn;
  final bool retryable;
  final int? statusCode;
  final Map<String, dynamic>? details;

  /// The field a validation failure names, when the server said which one.
  String? get field {
    final value = details?['field'];
    return value is String ? value : null;
  }

  /// The session is gone (expired, revoked, or the account was deleted) and the
  /// app must send the learner back to sign-in.
  bool get isAuthFailure => code == 'UNAUTHORIZED' || code == 'TOKEN_EXPIRED' || statusCode == 401;

  bool get isQuotaExhausted => code == 'QUOTA_EXHAUSTED';
  bool get isConsentRequired => code == 'CONSENT_REQUIRED';
  bool get isRateLimited => code == 'RATE_LIMITED';

  @override
  String toString() => 'ApiError($code, $statusCode): $messageEn';
}

/// The learner's profile, exactly as `GET /v1/profile` returns it.
class PublicProfile {
  const PublicProfile({
    required this.id,
    required this.displayName,
    required this.englishLevel,
    required this.learningGoal,
    required this.dailyGoalMinutes,
    required this.onboardingCompleted,
    required this.preferredArabicVoice,
    required this.preferredEnglishVoice,
    required this.voiceConsentGranted,
  });

  factory PublicProfile.fromJson(Map<String, dynamic> json) => PublicProfile(
        id: _string(json['id']) ?? '',
        displayName: _string(json['display_name']),
        englishLevel: _string(json['english_level']),
        learningGoal: _string(json['learning_goal']),
        dailyGoalMinutes: _int(json['daily_goal_minutes']),
        // A missing flag is "not completed", which routes to onboarding. Guessing
        // `true` would let an incomplete profile into the lessons screen.
        onboardingCompleted: _bool(json['onboarding_completed']),
        preferredArabicVoice: _string(json['preferred_arabic_voice']),
        preferredEnglishVoice: _string(json['preferred_english_voice']),
        // Missing means "not granted": consent must never be assumed, and the
        // settings switch has to show what the server will actually enforce.
        voiceConsentGranted: _bool(json['voice_consent_granted']),
      );

  final String id;
  final String? displayName;
  final String? englishLevel;
  final String? learningGoal;
  final int? dailyGoalMinutes;
  final bool onboardingCompleted;
  final String? preferredArabicVoice;
  final String? preferredEnglishVoice;
  final bool voiceConsentGranted;

  /// Greeting name with a warm Arabic fallback, so the home screen never shows
  /// an empty string where a name belongs.
  String get greetingName {
    final name = displayName?.trim();
    return (name == null || name.isEmpty) ? 'هلا' : name;
  }
}

class AuthTokens {
  const AuthTokens({required this.accessToken, required this.refreshToken});

  factory AuthTokens.fromJson(Map<String, dynamic> json) => AuthTokens(
        accessToken: _string(json['access_token']) ?? '',
        refreshToken: _string(json['refresh_token']) ?? '',
      );

  final String accessToken;
  final String refreshToken;

  bool get isValid => accessToken.isNotEmpty && refreshToken.isNotEmpty;
}

/// A successful auth response: tokens plus the profile they belong to.
class AuthSession {
  const AuthSession({required this.tokens, required this.profile});

  factory AuthSession.fromJson(Map<String, dynamic> json) => AuthSession(
        tokens: AuthTokens.fromJson(_obj(json['tokens'])),
        profile: PublicProfile.fromJson(_obj(json['profile'])),
      );

  final AuthTokens tokens;
  final PublicProfile profile;
}

class LessonStep {
  const LessonStep({
    required this.id,
    required this.kind,
    required this.explanationAr,
    required this.english,
    required this.arabicMeaning,
    required this.audioEnglish,
    required this.audioArabic,
  });

  factory LessonStep.fromJson(Map<String, dynamic> json) {
    final audio = _obj(json['audio']);
    return LessonStep(
      id: _string(json['id']) ?? '',
      kind: _string(json['kind']) ?? 'intro',
      explanationAr: _string(json['explanationAr']),
      english: _string(json['english']),
      arabicMeaning: _string(json['arabicMeaning']),
      audioEnglish: _string(audio['englishPhrase']),
      audioArabic: _string(audio['arabicExplanation']),
    );
  }

  final String id;
  final String kind;
  final String? explanationAr;
  final String? english;
  final String? arabicMeaning;
  final String? audioEnglish;
  final String? audioArabic;

  /// The text the listen step synthesises. Prefers the explicit audio cue, and
  /// falls back to the step's own English so a step authored without an `audio`
  /// block still has something to play rather than a silent button.
  String? get listenText => audioEnglish ?? english;
}

class ComprehensionQuestion {
  const ComprehensionQuestion({
    required this.prompt,
    required this.questionAr,
    required this.options,
    required this.answerIndex,
  });

  factory ComprehensionQuestion.fromJson(Map<String, dynamic> json) => ComprehensionQuestion(
        prompt: _string(json['prompt']) ?? '',
        questionAr: _string(json['questionAr']) ?? '',
        options: _list(json['options']).map((o) => o.toString()).toList(growable: false),
        answerIndex: _int(json['answerIndex']) ?? 0,
      );

  final String prompt;
  final String questionAr;
  final List<String> options;
  final int answerIndex;
}

class SpeakingPrompt {
  const SpeakingPrompt({
    required this.slug,
    required this.taskAr,
    required this.taskEn,
    required this.modelAnswer,
    required this.languageMode,
  });

  factory SpeakingPrompt.fromJson(Map<String, dynamic> json) => SpeakingPrompt(
        slug: _string(json['slug']) ?? '',
        taskAr: _string(json['taskAr']) ?? '',
        taskEn: _string(json['taskEn']) ?? '',
        modelAnswer: _string(json['modelAnswer']) ?? '',
        languageMode: _string(json['languageMode']) ?? 'english_only',
      );

  final String slug;
  final String taskAr;
  final String taskEn;
  final String modelAnswer;
  final String languageMode;
}

class VocabularyWord {
  const VocabularyWord({required this.englishTerm, required this.arabicMeaning, required this.exampleSentence});

  factory VocabularyWord.fromJson(Map<String, dynamic> json) => VocabularyWord(
        englishTerm: _string(json['englishTerm']) ?? '',
        arabicMeaning: _string(json['arabicMeaning']) ?? '',
        exampleSentence: _string(json['exampleSentence']) ?? '',
      );

  final String englishTerm;
  final String arabicMeaning;
  final String exampleSentence;
}

class LessonContent {
  const LessonContent({
    required this.steps,
    required this.comprehension,
    required this.speakingPrompts,
    required this.vocabulary,
  });

  factory LessonContent.fromJson(Map<String, dynamic> json) => LessonContent(
        steps: _list(json['steps']).map((s) => LessonStep.fromJson(_obj(s))).toList(growable: false),
        comprehension: _list(json['comprehension']).map((q) => ComprehensionQuestion.fromJson(_obj(q))).toList(growable: false),
        speakingPrompts: _list(json['speakingPrompts']).map((p) => SpeakingPrompt.fromJson(_obj(p))).toList(growable: false),
        vocabulary: _list(json['vocabulary']).map((v) => VocabularyWord.fromJson(_obj(v))).toList(growable: false),
      );

  final List<LessonStep> steps;
  final List<ComprehensionQuestion> comprehension;
  final List<SpeakingPrompt> speakingPrompts;
  final List<VocabularyWord> vocabulary;
}

class Lesson {
  const Lesson({
    required this.id,
    required this.slug,
    required this.title,
    required this.titleAr,
    required this.description,
    required this.level,
    required this.topic,
    required this.durationMinutes,
    required this.content,
  });

  factory Lesson.fromJson(Map<String, dynamic> json) => Lesson(
        id: _string(json['id']) ?? '',
        slug: _string(json['slug']) ?? '',
        title: _string(json['title']) ?? '',
        titleAr: _string(json['titleAr']) ?? '',
        description: _string(json['description']) ?? '',
        level: _string(json['level']) ?? 'complete_beginner',
        topic: _string(json['topic']) ?? '',
        durationMinutes: _int(json['durationMinutes']) ?? 0,
        content: LessonContent.fromJson(_obj(json['content'])),
      );

  final String id;
  final String slug;
  final String title;
  final String titleAr;
  final String description;
  final String level;
  final String topic;
  final int durationMinutes;
  final LessonContent content;
}

/// Today's lesson as the server chooses it: the lesson, any resumable attempt,
/// and whether the learner already finished it.
class TodayLesson {
  const TodayLesson({required this.lesson, required this.attempt, required this.completed});

  final Lesson? lesson;
  final LessonAttempt? attempt;
  final bool completed;
}

class LessonAttempt {
  const LessonAttempt({required this.id, required this.lessonId, required this.status});

  factory LessonAttempt.fromJson(Map<String, dynamic> json) => LessonAttempt(
        id: _string(json['id']) ?? '',
        lessonId: _string(json['lessonId']) ?? '',
        status: _string(json['status']) ?? 'in_progress',
      );

  final String id;
  final String lessonId;
  final String status;
}

class Correction {
  const Correction({required this.type, required this.original, required this.suggested, required this.explanationAr});

  factory Correction.fromJson(Map<String, dynamic> json) => Correction(
        type: _string(json['type']) ?? 'grammar',
        original: _string(json['original']) ?? '',
        suggested: _string(json['suggested']) ?? '',
        explanationAr: _string(json['explanation_ar']) ?? '',
      );

  final String type;
  final String original;
  final String suggested;
  final String explanationAr;

  /// Plain Arabic name for the correction family, used as a small chip label.
  String get labelAr => switch (type) {
        'grammar' => 'قواعد',
        'word_choice' => 'اختيار كلمة',
        'style' => 'أسلوب',
        'missing_word' => 'كلمة ناقصة',
        _ => 'ملاحظة',
      };
}

/// Bounded feedback. Every field comes from the server's deterministic rules —
/// the client never invents a correction or a score (requirement R1).
class SpeakingEvaluation {
  const SpeakingEvaluation({
    required this.understood,
    required this.taskCompleted,
    required this.corrections,
    required this.modelAnswer,
    required this.encouragementAr,
    required this.retryRequired,
    required this.retryReasonAr,
    required this.matchMethod,
  });

  factory SpeakingEvaluation.fromJson(Map<String, dynamic> json) => SpeakingEvaluation(
        understood: _bool(json['understood']),
        taskCompleted: _bool(json['task_completed']),
        corrections: _list(json['corrections']).map((c) => Correction.fromJson(_obj(c))).toList(growable: false),
        modelAnswer: _string(json['model_answer']) ?? '',
        encouragementAr: _string(json['encouragement_ar']) ?? '',
        retryRequired: _bool(json['retry_required']),
        retryReasonAr: _string(json['retry_reason_ar']),
        matchMethod: _string(json['match_method']) ?? 'none',
      );

  final bool understood;
  final bool taskCompleted;
  final List<Correction> corrections;
  final String modelAnswer;
  final String encouragementAr;
  final bool retryRequired;
  final String? retryReasonAr;
  final String matchMethod;
}

/// One speaking attempt as `GET /v1/speaking/history` returns it.
class SpeakingAttempt {
  const SpeakingAttempt({
    required this.id,
    required this.promptSlug,
    required this.transcript,
    required this.evaluation,
    required this.createdAt,
  });

  factory SpeakingAttempt.fromJson(Map<String, dynamic> json) {
    final evaluation = json['evaluation'];
    return SpeakingAttempt(
      id: _string(json['id']) ?? '',
      promptSlug: _string(json['promptSlug']) ?? _string(json['prompt_slug']) ?? '',
      transcript: _string(json['transcript']),
      // The transcript is cleared by the retention job, so an attempt with no
      // text is normal, not an error.
      evaluation: evaluation is Map ? SpeakingEvaluation.fromJson(_obj(evaluation)) : null,
      createdAt: _string(json['createdAt']) ?? _string(json['created_at']) ?? '',
    );
  }

  final String id;
  final String promptSlug;
  final String? transcript;
  final SpeakingEvaluation? evaluation;
  final String createdAt;
}

/// The result of the speaking route: the transcript plus its evaluation.
class SpeakingOutcome {
  const SpeakingOutcome({required this.attemptId, required this.transcript, required this.evaluation});

  factory SpeakingOutcome.fromJson(Map<String, dynamic> json) {
    final attempt = _obj(json['attempt']);
    return SpeakingOutcome(
      attemptId: _string(attempt['id']) ?? _string(json['attempt_id']) ?? '',
      transcript: _string(json['transcript']) ?? '',
      evaluation: SpeakingEvaluation.fromJson(_obj(json['evaluation'])),
    );
  }

  final String attemptId;
  final String transcript;
  final SpeakingEvaluation evaluation;
}

class VocabularyItem {
  const VocabularyItem({
    required this.id,
    required this.englishTerm,
    required this.arabicMeaning,
    required this.exampleSentence,
    required this.reviewState,
  });

  factory VocabularyItem.fromJson(Map<String, dynamic> json) => VocabularyItem(
        id: _string(json['id']) ?? '',
        englishTerm: _string(json['englishTerm']) ?? _string(json['english_term']) ?? '',
        arabicMeaning: _string(json['arabicMeaning']) ?? _string(json['arabic_meaning']) ?? '',
        exampleSentence: _string(json['exampleSentence']) ?? _string(json['example_sentence']) ?? '',
        reviewState: _string(json['reviewState']) ?? _string(json['review_state']) ?? 'new',
      );

  final String id;
  final String englishTerm;
  final String arabicMeaning;
  final String exampleSentence;
  final String reviewState;

  bool get isMastered => reviewState == 'mastered';
}

class Progress {
  const Progress({
    required this.lessonsCompleted,
    required this.lessonsStarted,
    required this.speakingAttempts,
    required this.vocabularyLearned,
    required this.vocabularyDueForReview,
    required this.weeklyMinutes,
    required this.currentStreakDays,
    required this.commonMistakes,
  });

  factory Progress.fromJson(Map<String, dynamic> json) => Progress(
        lessonsCompleted: _int(json['lessons_completed']) ?? 0,
        lessonsStarted: _int(json['lessons_started']) ?? 0,
        speakingAttempts: _int(json['speaking_attempts']) ?? 0,
        vocabularyLearned: _int(json['vocabulary_learned']) ?? 0,
        vocabularyDueForReview: _int(json['vocabulary_due_for_review']) ?? 0,
        weeklyMinutes: _int(json['weekly_minutes']) ?? 0,
        currentStreakDays: _int(json['current_streak_days']) ?? 0,
        commonMistakes: _list(json['common_mistakes'])
            .map((m) => CommonMistake.fromJson(_obj(m)))
            .toList(growable: false),
      );

  static const empty = Progress(
    lessonsCompleted: 0,
    lessonsStarted: 0,
    speakingAttempts: 0,
    vocabularyLearned: 0,
    vocabularyDueForReview: 0,
    weeklyMinutes: 0,
    currentStreakDays: 0,
    commonMistakes: [],
  );

  final int lessonsCompleted;
  final int lessonsStarted;
  final int speakingAttempts;
  final int vocabularyLearned;
  final int vocabularyDueForReview;
  final int weeklyMinutes;
  final int currentStreakDays;
  final List<CommonMistake> commonMistakes;
}

class CommonMistake {
  const CommonMistake({required this.type, required this.count, required this.labelAr});

  factory CommonMistake.fromJson(Map<String, dynamic> json) => CommonMistake(
        type: _string(json['type']) ?? '',
        count: _int(json['count']) ?? 0,
        labelAr: _string(json['label_ar']) ?? '',
      );

  final String type;
  final int count;
  final String labelAr;
}

/// Daily allowance as the server reports it. The app shows this rather than
/// guessing a limit locally, so the two can never disagree.
class UsageSummary {
  const UsageSummary({
    required this.speakingUsed,
    required this.speakingLimit,
    required this.ttsRequestsUsed,
    required this.ttsRequestsLimit,
    required this.creditsUsedToday,
    required this.creditsTodayBudget,
    required this.ttsCacheHitsToday,
  });

  factory UsageSummary.fromJson(Map<String, dynamic> json) => UsageSummary(
        speakingUsed: _int(json['speaking_attempts_used']) ?? 0,
        speakingLimit: _int(json['speaking_attempts_limit']) ?? 0,
        ttsRequestsUsed: _int(json['tts_requests_used']) ?? 0,
        ttsRequestsLimit: _int(json['tts_requests_limit']) ?? 0,
        creditsUsedToday: _int(json['credits_used_today']) ?? 0,
        creditsTodayBudget: _int(json['credits_today_budget']) ?? 0,
        ttsCacheHitsToday: _int(json['tts_cache_hits_today']) ?? 0,
      );

  final int speakingUsed;
  final int speakingLimit;
  final int ttsRequestsUsed;
  final int ttsRequestsLimit;
  final int creditsUsedToday;
  final int creditsTodayBudget;
  final int ttsCacheHitsToday;

  int get speakingRemaining => (speakingLimit - speakingUsed).clamp(0, speakingLimit);
}

class VoiceOption {
  const VoiceOption({
    required this.id,
    required this.label,
    required this.dialect,
    required this.languages,
    required this.gender,
  });

  factory VoiceOption.fromJson(Map<String, dynamic> json) => VoiceOption(
        id: _string(json['id']) ?? '',
        label: _string(json['label']) ?? '',
        dialect: _string(json['dialect']) ?? '',
        languages: _list(json['languages']).map((l) => l.toString()).toList(growable: false),
        gender: _string(json['gender']),
      );

  final String id;
  final String label;
  final String dialect;
  final List<String> languages;
  final String? gender;
}

class VoiceCatalog {
  const VoiceCatalog({required this.voices, required this.defaultArabicVoiceId, required this.defaultEnglishVoiceId});

  factory VoiceCatalog.fromJson(Map<String, dynamic> json) => VoiceCatalog(
        voices: _list(json['voices']).map((v) => VoiceOption.fromJson(_obj(v))).toList(growable: false),
        defaultArabicVoiceId: _string(json['default_arabic_voice_id']),
        defaultEnglishVoiceId: _string(json['default_english_voice_id']),
      );

  final List<VoiceOption> voices;
  final String? defaultArabicVoiceId;
  final String? defaultEnglishVoiceId;
}
