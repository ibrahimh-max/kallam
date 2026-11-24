import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../ui/widgets.dart';
import '../speaking/speaking_practice.dart';

/// The lesson journey, in the order the product requires:
///
///   understand in Saudi Arabic → listen in English → check comprehension →
///   speak in English → get Arabic feedback → practise again → summary.
///
/// The attempt is created on the server *before* the learner reaches the speaking
/// step, so a dropped connection mid-lesson still leaves a resumable attempt.
class LessonScreen extends ConsumerStatefulWidget {
  const LessonScreen({super.key, required this.lesson});

  final Lesson lesson;

  @override
  ConsumerState<LessonScreen> createState() => _LessonScreenState();
}

class _LessonScreenState extends ConsumerState<LessonScreen> {
  late List<LessonStep> _steps;
  int _stepIndex = 0;

  /// 0 = steps, 1 = comprehension, 2 = speaking, 3 = summary
  int _stage = 0;
  int _questionIndex = 0;
  final List<int> _answers = [];
  int _promptIndex = 0;

  LessonAttempt? _attempt;
  bool _starting = true;
  String? _error;
  bool _finishing = false;
  int _vocabularySaved = 0;

  @override
  void initState() {
    super.initState();
    _steps = widget.lesson.content.steps;
    _start();
  }

  Future<void> _start() async {
    try {
      final attempt = await ref.read(apiClientProvider).startAttempt(widget.lesson.id);
      if (!mounted) return;
      setState(() {
        _attempt = attempt;
        _starting = false;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _starting = false;
        _error = userMessageFor(error);
      });
    }
  }

  void _advance() {
    setState(() {
      if (_steps.isEmpty) {
        _stage = widget.lesson.content.comprehension.isEmpty ? 2 : 1;
      } else if (_stepIndex + 1 < _steps.length) {
        _stepIndex++;
      } else {
        _stage = widget.lesson.content.comprehension.isEmpty ? 2 : 1;
      }
    });
  }

  void _answer(int optionIndex) {
    _answers.add(optionIndex);
    setState(() {
      if (_questionIndex + 1 < widget.lesson.content.comprehension.length) {
        _questionIndex++;
      } else {
        _stage = 2;
      }
    });
  }

  /// Comprehension is a count, not a grade the learner has to defend. A wrong
  /// answer is information for the next lesson, not a failure screen.
  double get _comprehensionScore {
    final questions = widget.lesson.content.comprehension;
    if (questions.isEmpty) return 1;
    var correct = 0;
    for (var i = 0; i < _answers.length && i < questions.length; i++) {
      if (_answers[i] == questions[i].answerIndex) correct++;
    }
    return correct / questions.length;
  }

  Future<void> _play(String text, {String script = 'en'}) async {
    try {
      await ref.read(ttsProvider).speak(text: text, script: script, namespace: 'lesson');
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = userMessageFor(error));
    }
  }

  Future<void> _finish() async {
    setState(() {
      _finishing = true;
      _error = null;
    });
    final attempt = _attempt;
    try {
      if (attempt != null) {
        final result = await ref.read(apiClientProvider).completeAttempt(
              attemptId: attempt.id,
              comprehensionScore: _comprehensionScore,
            );
        _vocabularySaved = result.vocabularySaved;
      }
      // The lesson is finished even if the progress write failed: making the
      // learner repeat a whole lesson because a write failed is worse than a
      // missing row, and the server reconciles on the next completion.
      ref.invalidate(todayLessonProvider);
      ref.invalidate(progressProvider);
      ref.invalidate(vocabularyProvider);
      if (!mounted) return;
      setState(() {
        _finishing = false;
        _stage = 3;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _finishing = false;
        _error = userMessageFor(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_starting) {
      return Scaffold(
        appBar: AppBar(title: Text(widget.lesson.titleAr)),
        body: const LoadingState(label: 'نجهّز الدرس…'),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.lesson.titleAr),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(4),
          child: _StageBar(stage: _stage, stepIndex: _stepIndex, totalSteps: _steps.length),
        ),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(AppSpace.xl, AppSpace.lg, AppSpace.xl, AppSpace.xxl),
          children: [
            if (_error != null) ...[
              AppCard(
                color: AppColors.attentionSoft,
                borderColor: AppColors.attention,
                child: Row(
                  children: [
                    const Icon(Icons.info_outline, size: 18, color: AppColors.attention),
                    const SizedBox(width: AppSpace.sm),
                    Expanded(child: Text(_error!, style: AppType.body.copyWith(color: AppColors.attention))),
                  ],
                ),
              ),
              const SizedBox(height: AppSpace.lg),
            ],
            switch (_stage) {
              0 => _StepsStage(
                  steps: _steps,
                  index: _stepIndex,
                  onPlay: _play,
                  onNext: _advance,
                ),
              1 => _ComprehensionStage(
                  question: widget.lesson.content.comprehension[_questionIndex],
                  index: _questionIndex,
                  total: widget.lesson.content.comprehension.length,
                  onPlay: _play,
                  onAnswer: _answer,
                ),
              2 => _SpeakingStage(
                  prompts: widget.lesson.content.speakingPrompts,
                  promptIndex: _promptIndex,
                  attemptId: _attempt?.id,
                  onPlay: _play,
                  onNextPrompt: () => setState(() => _promptIndex++),
                  onDone: _finish,
                  busy: _finishing,
                ),
              _ => _SummaryStage(
                  lesson: widget.lesson,
                  comprehensionScore: _comprehensionScore,
                  vocabularySaved: _vocabularySaved,
                ),
            },
          ],
        ),
      ),
    );
  }
}

class _StageBar extends StatelessWidget {
  const _StageBar({required this.stage, required this.stepIndex, required this.totalSteps});

  final int stage;
  final int stepIndex;
  final int totalSteps;

  @override
  Widget build(BuildContext context) {
    // A lesson is three stages plus the steps inside the first; the bar shows
    // overall position so the learner always knows how much is left.
    const stageCount = 4;
    final stepFraction = totalSteps == 0 ? 1.0 : (stepIndex + 1) / totalSteps;
    final progress = ((stage + (stage == 0 ? stepFraction : 1)) / stageCount).clamp(0.0, 1.0);
    return LinearProgressIndicator(
      value: progress,
      minHeight: 4,
      backgroundColor: AppColors.border,
      valueColor: const AlwaysStoppedAnimation(AppColors.primary),
    );
  }
}

class _StepsStage extends StatelessWidget {
  const _StepsStage({required this.steps, required this.index, required this.onPlay, required this.onNext});

  final List<LessonStep> steps;
  final int index;
  final Future<void> Function(String text, {String script}) onPlay;
  final VoidCallback onNext;

  @override
  Widget build(BuildContext context) {
    if (steps.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const EmptyState(
            icon: Icons.article_outlined,
            title: 'هذا الدرس بدون خطوات شرح',
            body: 'ننتقل مباشرة للتمرين العملي.',
          ),
          const SizedBox(height: AppSpace.lg),
          PrimaryButton(label: 'نكمل', onPressed: () async => onNext()),
        ],
      );
    }

    final step = steps[index];
    final listen = step.listenText;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('الخطوة ${index + 1} من ${steps.length}', style: AppType.caption.copyWith(color: AppColors.textMuted)),
        const SizedBox(height: AppSpace.md),

        // 1) Understand in Saudi Arabic. This comes first, always.
        if ((step.explanationAr ?? '').isNotEmpty)
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text('افهم بالعربي', style: AppType.label.copyWith(color: AppColors.primaryDark)),
                    const Spacer(),
                    if ((step.audioArabic ?? '').isNotEmpty)
                      IconButton(
                        tooltip: 'اسمع الشرح',
                        icon: const Icon(Icons.hearing_outlined, color: AppColors.primaryDark),
                        onPressed: () => onPlay(step.audioArabic!, script: 'ar'),
                      ),
                  ],
                ),
                const SizedBox(height: AppSpace.sm),
                Text(step.explanationAr!, style: AppType.body),
              ],
            ),
          ),

        // 2) Listen in English. The English phrase sits LTR inside the RTL page.
        if (listen != null || (step.english ?? '').isNotEmpty) ...[
          const SizedBox(height: AppSpace.lg),
          AppCard(
            color: AppColors.primarySoft,
            borderColor: AppColors.primarySoft,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text('اسمع بالإنجليزي', style: AppType.label.copyWith(color: AppColors.primaryDark)),
                    const Spacer(),
                    IconButton(
                      tooltip: 'اسمع الجملة',
                      icon: const Icon(Icons.volume_up_outlined, color: AppColors.primaryDark),
                      onPressed: () => onPlay(listen ?? step.english!),
                    ),
                  ],
                ),
                const SizedBox(height: AppSpace.sm),
                EnglishPhrase(step.english ?? listen!, style: AppType.phrase),
                if ((step.arabicMeaning ?? '').isNotEmpty) ...[
                  const SizedBox(height: AppSpace.md),
                  Text('المعنى: ${step.arabicMeaning}', style: AppType.body.copyWith(color: AppColors.textMuted)),
                ],
              ],
            ),
          ),
        ],

        const SizedBox(height: AppSpace.xl),
        PrimaryButton(
          label: index + 1 < steps.length ? 'الخطوة التالية' : 'التمرين',
          icon: Icons.arrow_forward_rounded,
          onPressed: () async => onNext(),
        ),
      ],
    );
  }
}

class _ComprehensionStage extends StatelessWidget {
  const _ComprehensionStage({
    required this.question,
    required this.index,
    required this.total,
    required this.onPlay,
    required this.onAnswer,
  });

  final ComprehensionQuestion question;
  final int index;
  final int total;
  final Future<void> Function(String text, {String script}) onPlay;
  final void Function(int optionIndex) onAnswer;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('سؤال ${index + 1} من $total', style: AppType.caption.copyWith(color: AppColors.textMuted)),
        const SizedBox(height: AppSpace.md),
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('اسمع مرة ثانية', style: AppType.label.copyWith(color: AppColors.primaryDark)),
                  const Spacer(),
                  IconButton(
                    tooltip: 'اسمع',
                    icon: const Icon(Icons.volume_up_outlined, color: AppColors.primaryDark),
                    onPressed: () => onPlay(question.prompt),
                  ),
                ],
              ),
              EnglishPhrase(question.prompt, style: AppType.phrase),
            ],
          ),
        ),
        const SizedBox(height: AppSpace.lg),
        Text(question.questionAr, style: AppType.subtitle),
        const SizedBox(height: AppSpace.md),
        // Answers are full-width tap targets (well above 44px) because this is a
        // phone-first app used one-handed.
        for (var i = 0; i < question.options.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpace.md),
            child: OutlinedButton(
              onPressed: () => onAnswer(i),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(56),
                alignment: AlignmentDirectional.centerStart,
                side: const BorderSide(color: AppColors.border),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.lg)),
              ),
              child: EnglishText(question.options[i], style: AppType.body),
            ),
          ),
      ],
    );
  }
}

class _SpeakingStage extends ConsumerWidget {
  const _SpeakingStage({
    required this.prompts,
    required this.promptIndex,
    required this.attemptId,
    required this.onPlay,
    required this.onNextPrompt,
    required this.onDone,
    required this.busy,
  });

  final List<SpeakingPrompt> prompts;
  final int promptIndex;
  final String? attemptId;
  final Future<void> Function(String text, {String script}) onPlay;
  final VoidCallback onNextPrompt;
  final Future<void> Function() onDone;
  final bool busy;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (prompts.isEmpty) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const EmptyState(
            icon: Icons.record_voice_over_outlined,
            title: 'ما فيه تمرين كلام في هذا الدرس',
            body: 'تقدر ترجع له لاحقاً.',
          ),
          const SizedBox(height: AppSpace.lg),
          PrimaryButton(label: 'أنهي الدرس', onPressed: onDone),
        ],
      );
    }

    final isLast = promptIndex + 1 >= prompts.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionTitle(
          'تمرين الكلام ${promptIndex + 1} من ${prompts.length}',
          trailing: Tag('تكلّم'),
        ),
        const SizedBox(height: AppSpace.md),
        SpeakingPractice(
          // Rebuilding the widget for each prompt gives every attempt a fresh
          // state machine and a fresh idempotency key, which is what keeps two
          // different prompts from sharing one cached result.
          key: ValueKey('prompt-$promptIndex'),
          prompt: prompts[promptIndex],
          lessonAttemptId: attemptId,
        ),
        const SizedBox(height: AppSpace.xl),
        if (!isLast)
          OutlinedButton(
            onPressed: onNextPrompt,
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: const Text('التمرين التالي'),
          )
        else
          PrimaryButton(label: 'أنهي الدرس', icon: Icons.flag_outlined, onPressed: onDone),
        if (busy) ...[
          const SizedBox(height: AppSpace.lg),
          const LoadingState(label: 'نحفظ تقدمك…'),
        ],
      ],
    );
  }
}

class _SummaryStage extends StatelessWidget {
  const _SummaryStage({
    required this.lesson,
    required this.comprehensionScore,
    required this.vocabularySaved,
  });

  final Lesson lesson;
  final double comprehensionScore;
  final int vocabularySaved;

  @override
  Widget build(BuildContext context) {
    final percent = (comprehensionScore * 100).round();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          color: AppColors.successSoft,
          borderColor: AppColors.success,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(Icons.check_circle_outline, size: 22, color: AppColors.success),
                  const SizedBox(width: AppSpace.sm),
                  Text('خلصت الدرس', style: AppType.subtitle.copyWith(color: AppColors.success)),
                ],
              ),
              const SizedBox(height: AppSpace.md),
              Text(lesson.titleAr, style: AppType.label),
              const SizedBox(height: AppSpace.sm),
              Text(
                'فهمت $percent٪ من أسئلة الفهم.',
                style: AppType.body.copyWith(color: AppColors.textMuted),
              ),
              if (vocabularySaved > 0) ...[
                const SizedBox(height: AppSpace.sm),
                Text(
                  'أضفنا $vocabularySaved كلمات لمراجعتك.',
                  style: AppType.body.copyWith(color: AppColors.textMuted),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: AppSpace.xl),
        PrimaryButton(
          label: 'ارجع للرئيسية',
          icon: Icons.home_outlined,
          onPressed: () async => Navigator.of(context).pop(),
        ),
      ],
    );
  }
}
