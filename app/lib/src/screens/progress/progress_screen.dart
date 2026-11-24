import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../ui/widgets.dart';

/// Progress, stated honestly. The most important number is the largest thing on
/// the screen, and a learner with nothing yet sees the next action rather than a
/// wall of zeroes.
class ProgressScreen extends ConsumerWidget {
  const ProgressScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final progress = ref.watch(progressProvider);
    final usage = ref.watch(usageProvider);
    final history = ref.watch(speakingHistoryProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('تقدمي')),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(progressProvider);
          ref.invalidate(usageProvider);
          ref.invalidate(speakingHistoryProvider);
        },
        child: ListView(
          padding: const EdgeInsets.fromLTRB(AppSpace.xl, AppSpace.lg, AppSpace.xl, AppSpace.xxl),
          children: [
            progress.when(
              loading: () => const SizedBox(height: 160, child: LoadingState()),
              error: (error, _) => ErrorState(
                message: userMessageFor(error),
                onRetry: () async => ref.invalidate(progressProvider),
              ),
              data: (data) => _Overview(progress: data),
            ),

            const SizedBox(height: AppSpace.xl),
            usage.when(
              loading: () => const SizedBox.shrink(),
              error: (error, _) => const SizedBox.shrink(),
              data: (data) => _UsageCard(usage: data),
            ),

            const SizedBox(height: AppSpace.xl),
            const SectionTitle('آخر تمارينك'),
            const SizedBox(height: AppSpace.md),
            history.when(
              loading: () => const SizedBox(height: 120, child: LoadingState()),
              error: (error, _) => AppCard(
                child: Text(userMessageFor(error), style: AppType.body.copyWith(color: AppColors.textMuted)),
              ),
              data: (attempts) {
                if (attempts.isEmpty) {
                  return const AppCard(
                    child: Text(
                      'ما فيه تمارين كلام بعد. ابدأ درس وتمرّن — نعرض هنا كل محاولة وتصحيحها.',
                      style: AppType.body,
                    ),
                  );
                }
                return Column(
                  children: [
                    for (final attempt in attempts) _AttemptTile(attempt: attempt),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _Overview extends StatelessWidget {
  const _Overview({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context) {
    final streak = progress.currentStreakDays;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('درس مكتمل', style: AppType.caption.copyWith(color: AppColors.textMuted)),
              const SizedBox(height: AppSpace.xs),
              // The headline number, deliberately the largest thing here.
              Text('${progress.lessonsCompleted}', style: AppType.display),
              const SizedBox(height: AppSpace.sm),
              Text(
                streak > 0
                    ? 'متواصل $streak ${streak == 1 ? 'يوم' : 'أيام'} — كمّل على نفس الروتين.'
                    : 'ابدأ درس اليوم وتبدأ سلسلتك.',
                style: AppType.body.copyWith(color: AppColors.textMuted),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpace.md),
        Row(
          children: [
            Expanded(child: _MiniStat(value: '${progress.speakingAttempts}', label: 'تمرين كلام')),
            const SizedBox(width: AppSpace.md),
            Expanded(child: _MiniStat(value: '${progress.vocabularyLearned}', label: 'كلمة محفوظة')),
            const SizedBox(width: AppSpace.md),
            Expanded(child: _MiniStat(value: '${progress.weeklyMinutes}', label: 'دقيقة/أسبوع')),
          ],
        ),
        if (progress.commonMistakes.isNotEmpty) ...[
          const SizedBox(height: AppSpace.xl),
          const SectionTitle('أكثر ما يتكرر عليك'),
          const SizedBox(height: AppSpace.md),
          AppCard(
            child: Column(
              children: [
                for (final mistake in progress.commonMistakes)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpace.sm),
                    child: Row(
                      children: [
                        Expanded(child: Text(mistake.labelAr, style: AppType.body)),
                        Tag('${mistake.count}'),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _MiniStat extends StatelessWidget {
  const _MiniStat({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.md, vertical: AppSpace.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: AppType.title),
          const SizedBox(height: AppSpace.xs),
          Text(label, style: AppType.caption.copyWith(color: AppColors.textMuted)),
        ],
      ),
    );
  }
}

/// The daily allowance, shown from the server's numbers so the app and the
/// backend can never disagree about what is left today.
class _UsageCard extends StatelessWidget {
  const _UsageCard({required this.usage});

  final UsageSummary usage;

  @override
  Widget build(BuildContext context) {
    final remaining = usage.speakingRemaining;
    final exhausted = usage.speakingLimit > 0 && remaining == 0;
    return AppCard(
      color: exhausted ? AppColors.attentionSoft : null,
      borderColor: exhausted ? AppColors.attention : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('استخدامك اليوم', style: AppType.label),
              const Spacer(),
              Tag(exhausted ? 'وصلت الحد' : 'باقي $remaining'),
            ],
          ),
          const SizedBox(height: AppSpace.md),
          LinearProgressIndicator(
            value: usage.speakingLimit == 0
                ? 0
                : (usage.speakingUsed / usage.speakingLimit).clamp(0.0, 1.0),
            minHeight: 6,
            backgroundColor: AppColors.border,
            valueColor: AlwaysStoppedAnimation(exhausted ? AppColors.attention : AppColors.primary),
          ),
          const SizedBox(height: AppSpace.md),
          Text(
            '${usage.speakingUsed} من ${usage.speakingLimit} تمرين كلام. '
            'الجمل المسموعة من قبل ما تستهلك رصيد.',
            style: AppType.caption.copyWith(color: AppColors.textMuted),
          ),
        ],
      ),
    );
  }
}

class _AttemptTile extends StatelessWidget {
  const _AttemptTile({required this.attempt});

  final SpeakingAttempt attempt;

  @override
  Widget build(BuildContext context) {
    final evaluation = attempt.evaluation;
    final transcript = attempt.transcript;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpace.md),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  evaluation == null
                      ? Icons.hourglass_empty
                      : evaluation.retryRequired
                          ? Icons.refresh_rounded
                          : Icons.check_circle_outline,
                  size: 18,
                  color: evaluation == null
                      ? AppColors.textFaint
                      : evaluation.retryRequired
                          ? AppColors.attention
                          : AppColors.success,
                ),
                const SizedBox(width: AppSpace.sm),
                Expanded(child: Text(attempt.promptSlug, style: AppType.label)),
              ],
            ),
            const SizedBox(height: AppSpace.sm),
            if (transcript != null && transcript.trim().isNotEmpty)
              EnglishText(transcript, style: AppType.body.copyWith(color: AppColors.textMuted))
            else
              // The retention job clears transcripts, so this is expected, not a bug.
              Text(
                'النص محذوف حسب سياسة الاحتفاظ.',
                style: AppType.caption.copyWith(color: AppColors.textFaint),
              ),
            if (evaluation != null && evaluation.encouragementAr.isNotEmpty) ...[
              const SizedBox(height: AppSpace.sm),
              Text(evaluation.encouragementAr, style: AppType.body.copyWith(color: AppColors.textMuted)),
            ],
          ],
        ),
      ),
    );
  }
}
