import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../ui/widgets.dart';

/// Onboarding: four short questions, all in Saudi Arabic.
///
/// The answers are what make the lessons personal (level, goal, daily goal), and
/// the last step is the voice consent — the mic is never used before it. Choices
/// come from the server's own vocabulary (`ENGLISH_LEVELS`/`LEARNING_GOALS` in
/// `server/src/domain/models.ts`), so the app cannot send a level the server does
/// not understand.
class OnboardingScreen extends ConsumerStatefulWidget {
  const OnboardingScreen({super.key});

  @override
  ConsumerState<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends ConsumerState<OnboardingScreen> {
  static const _levels = <({String value, String label, String hint})>[
    (value: 'complete_beginner', label: 'مبتدئ تماماً', hint: 'أبدأ من الصفر'),
    (value: 'few_words', label: 'أعرف كلمات بسيطة', hint: 'كلمات متفرقة'),
    (value: 'simple_understanding', label: 'أفهم إنجليزي بسيط', hint: 'أفهم وأرد بصعوبة'),
    (value: 'basic_conversation', label: 'أقدر أسوي محادثة بسيطة', hint: 'أتحدث بجُمل قصيرة'),
  ];

  static const _goals = <({String value, String label})>[
    (value: 'everyday', label: 'محادثات يومية'),
    (value: 'work', label: 'العمل والوظيفة'),
    (value: 'travel', label: 'السفر'),
    (value: 'study', label: 'الدراسة'),
    (value: 'general', label: 'إنجليزي عام'),
  ];

  static const _dailyGoals = <int>[5, 10, 15];

  int _step = 0;
  String? _level;
  String? _goal;
  int _dailyGoal = 10;

  /// Consent is an explicit choice, never a default. Account creation and lessons
  /// do not depend on microphone access.
  bool _voiceConsentGranted = false;
  String? _error;
  bool _saving = false;

  bool get _canContinue => switch (_step) {
        0 => _level != null,
        1 => _goal != null,
        2 => true,
        // The microphone step is a real decision, never a forced one: the learner
        // can decline and still use the app, which is what the spec requires
        // ("obtain clear consent before microphone use"). Declining therefore
        // disables speaking practice rather than blocking onboarding.
        _ => true,
      };

  Future<void> _finish() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final auth = ref.read(authControllerProvider.notifier);
      await auth.completeOnboarding(
        englishLevel: _level ?? 'complete_beginner',
        learningGoal: _goal ?? 'everyday',
        dailyGoalMinutes: _dailyGoal,
      );
      // Apply only the learner's explicit decision. Existing accounts created by
      // older versions may already have consent; a decline must withdraw it.
      final hasVoiceConsent = ref.read(authControllerProvider).profile?.voiceConsentGranted ?? false;
      if (_voiceConsentGranted && !hasVoiceConsent) {
        await auth.grantVoiceConsent();
      } else if (!_voiceConsentGranted && hasVoiceConsent) {
        await auth.withdrawVoiceConsent();
      }
      // Routing follows authControllerProvider: onboarding_completed is now true,
      // so the router shows the home screen. No manual navigation here.
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = userMessageFor(error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('خطوة ${_step + 1} من 4'),
        automaticallyImplyLeading: false,
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(3),
          child: LinearProgressIndicator(
            value: (_step + 1) / 4,
            backgroundColor: AppColors.muted,
          ),
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(AppSpace.xl),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 520),
                  child: switch (_step) {
                    0 => _LevelStep(
                        levels: _levels,
                        selected: _level,
                        onSelect: (value) => setState(() => _level = value),
                      ),
                    1 => _GoalStep(
                        goals: _goals,
                        selected: _goal,
                        onSelect: (value) => setState(() => _goal = value),
                      ),
                    2 => _DailyGoalStep(
                        goals: _dailyGoals,
                        selected: _dailyGoal,
                        onSelect: (value) => setState(() => _dailyGoal = value),
                      ),
                    _ => _ConsentStep(
                        granted: _voiceConsentGranted,
                        onChanged: (value) => setState(() {
                          _voiceConsentGranted = value;
                          _error = null;
                        }),
                      ),
                  },
                ),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: AppSpace.xl),
                child: AppCard(
                  color: AppColors.dangerSoft,
                  borderColor: AppColors.danger,
                  child: Text(_error!, style: AppType.body.copyWith(color: AppColors.danger)),
                ),
              ),
            Padding(
              padding: const EdgeInsets.all(AppSpace.xl),
              child: Row(
                children: [
                  if (_step > 0)
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _saving ? null : () => setState(() => _step -= 1),
                        child: const Text('رجوع'),
                      ),
                    ),
                  if (_step > 0) const SizedBox(width: AppSpace.md),
                  Expanded(
                    flex: 2,
                    child: PrimaryButton(
                      label: _step == 3 ? 'ابدأ التعلم' : 'التالي',
                      busyLabel: 'نحفظ…',
                      onPressed: !_canContinue || _saving
                          ? null
                          : () async {
                              if (_step == 3) {
                                await _finish();
                              } else {
                                setState(() => _step += 1);
                              }
                            },
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Shared layout for a question: the prompt is the largest thing on the screen.
class _StepShell extends StatelessWidget {
  const _StepShell({required this.question, required this.hint, required this.children});

  final String question;
  final String hint;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(question, style: AppType.title),
        const SizedBox(height: AppSpace.sm),
        Text(hint, style: AppType.body.copyWith(color: AppColors.textMuted)),
        const SizedBox(height: AppSpace.xl),
        ...children,
      ],
    );
  }
}

/// One selectable answer. Tall enough to tap comfortably and marked with a
/// check as well as a border, so the choice is not colour-only.
class _ChoiceTile extends StatelessWidget {
  const _ChoiceTile({
    required this.label,
    required this.selected,
    required this.onTap,
    this.hint,
  });

  final String label;
  final String? hint;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpace.md),
      child: Semantics(
        button: true,
        selected: selected,
        label: label,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadius.md),
          child: Container(
            constraints: const BoxConstraints(minHeight: kMinTouchTarget + 12),
            padding: const EdgeInsets.all(AppSpace.lg),
            decoration: BoxDecoration(
              color: selected ? AppColors.primarySoft : AppColors.surfaceRaised,
              borderRadius: BorderRadius.circular(AppRadius.md),
              border: Border.all(
                color: selected ? AppColors.primary : AppColors.border,
                width: selected ? 2 : 1,
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(label, style: AppType.label.copyWith(fontSize: 16)),
                      if (hint != null) ...[
                        const SizedBox(height: AppSpace.xs),
                        Text(hint!, style: AppType.caption.copyWith(color: AppColors.textMuted)),
                      ],
                    ],
                  ),
                ),
                if (selected) const Icon(Icons.check_circle, color: AppColors.primary, size: 22),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _LevelStep extends StatelessWidget {
  const _LevelStep({required this.levels, required this.selected, required this.onSelect});

  final List<({String value, String label, String hint})> levels;
  final String? selected;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    return _StepShell(
      question: 'كم تعرف إنجليزي؟',
      hint: 'اختر الأقرب لك. ما فيه إجابة غلط.',
      children: [
        for (final level in levels)
          _ChoiceTile(
            label: level.label,
            hint: level.hint,
            selected: selected == level.value,
            onTap: () => onSelect(level.value),
          ),
      ],
    );
  }
}

class _GoalStep extends StatelessWidget {
  const _GoalStep({required this.goals, required this.selected, required this.onSelect});

  final List<({String value, String label})> goals;
  final String? selected;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    return _StepShell(
      question: 'ليش تبي تتعلم إنجليزي؟',
      hint: 'راح نرتب الدروس على أساس هدفك.',
      children: [
        for (final goal in goals)
          _ChoiceTile(
            label: goal.label,
            selected: selected == goal.value,
            onTap: () => onSelect(goal.value),
          ),
      ],
    );
  }
}

class _DailyGoalStep extends StatelessWidget {
  const _DailyGoalStep({required this.goals, required this.selected, required this.onSelect});

  final List<int> goals;
  final int selected;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    return _StepShell(
      question: 'كم دقيقة تبي تتدرب كل يوم؟',
      hint: 'الأهم إنك ترجع كل يوم، حتى لو دقايق قليلة.',
      children: [
        for (final minutes in goals)
          _ChoiceTile(
            label: '$minutes دقائق',
            selected: selected == minutes,
            onTap: () => onSelect(minutes),
          ),
      ],
    );
  }
}

class _ConsentStep extends StatelessWidget {
  const _ConsentStep({required this.granted, required this.onChanged});

  final bool granted;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return _StepShell(
      question: 'آخر شي: موافقتك على الصوت',
      hint: 'تمارين الكلام تحتاج المايك.',
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('شنو نسوي بصوتك؟', style: AppType.label.copyWith(fontSize: 16)),
              const SizedBox(height: AppSpace.sm),
              Text(
                '• نسجّل صوتك وقت التمرين فقط.\n'
                '• نرسله لتحويل الكلام إلى نص ونقيّم الكلام.\n'
                '• ما نحفظ التسجيل الصوتي بعد انتهاء المحاولة.\n'
                '• تقدر تسحب موافقتك من الإعدادات في أي وقت.',
                style: AppType.body.copyWith(color: AppColors.textMuted),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpace.lg),
        CheckboxListTile(
          value: granted,
          onChanged: (value) => onChanged(value ?? false),
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          title: Text('أوافق على معالجة صوتي', style: AppType.label),
          subtitle: Text('بدونها ما نقدر نشغّل تمارين الكلام.', style: AppType.caption.copyWith(color: AppColors.textMuted)),
        ),
      ],
    );
  }
}
