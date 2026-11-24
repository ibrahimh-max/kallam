import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../ui/widgets.dart';
import '../lesson/lesson_screen.dart';
import '../lesson/lesson_list_screen.dart';
import '../profile/profile_screen.dart';
import '../progress/progress_screen.dart';
import '../vocabulary/vocabulary_screen.dart';

/// The learner's home: today's lesson, the daily allowance, and the way in to
/// everything else.
///
/// Hierarchy rule from the design direction: the lesson being offered right now is
/// the largest thing on the screen, and there is exactly one primary action
/// ("ابدأ الدرس"). Everything else is quiet.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    final today = ref.watch(todayLessonProvider);
    final progress = ref.watch(progressProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text('هلا، ${auth.profile?.greetingName ?? ''}'),
        actions: [
          IconButton(
            tooltip: 'الإعدادات',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const ProfileScreen()),
            ),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(todayLessonProvider);
          ref.invalidate(progressProvider);
          ref.invalidate(usageProvider);
          await ref.read(todayLessonProvider.future).catchError((_) => TodayLesson(lesson: null, attempt: null, completed: false));
        },
        child: ListView(
          padding: const EdgeInsets.fromLTRB(AppSpace.xl, AppSpace.lg, AppSpace.xl, AppSpace.xxl),
          children: [
            progress.when(
              loading: () => const SizedBox(height: 96, child: LoadingState()),
              error: (error, _) => AppCard(
                color: AppColors.attentionSoft,
                borderColor: AppColors.attention,
                child: Text(userMessageFor(error), style: AppType.body.copyWith(color: AppColors.attention)),
              ),
              data: (data) => _ProgressStrip(progress: data),
            ),
            const SizedBox(height: AppSpace.xl),
            today.when(
              loading: () => const SizedBox(height: 220, child: LoadingState(label: 'نجهّز درسك…')),
              error: (error, _) => _TodayError(error: error, ref: ref),
              data: (data) {
                final lesson = data.lesson;
                if (lesson == null) {
                  return EmptyState(
                    icon: Icons.menu_book_outlined,
                    title: 'ما فيه دروس متوفرة حالياً',
                    body: 'نضيف دروس جديدة قريب. ارجع لنا بعد شوي.',
                    action: SizedBox(
                      width: 220,
                      child: PrimaryButton(
                        label: 'حدّث الصفحة',
                        onPressed: () async => ref.invalidate(todayLessonProvider),
                      ),
                    ),
                  );
                }
                return _TodayLessonCard(
                  lesson: lesson,
                  completed: data.completed,
                  hasAttempt: data.attempt != null,
                );
              },
            ),
            const SizedBox(height: AppSpace.xl),
            _QuickLinks(progress: progress.valueOrNull),
          ],
        ),
      ),
    );
  }
}

/// The most important numbers, stated plainly. A missing streak is not shamed.
class _ProgressStrip extends StatelessWidget {
  const _ProgressStrip({required this.progress});

  final Progress progress;

  @override
  Widget build(BuildContext context) {
    final streak = progress.currentStreakDays;
    return Row(
      children: [
        Expanded(
          child: _Stat(
            value: '${progress.lessonsCompleted}',
            label: 'درس مكتمل',
          ),
        ),
        const SizedBox(width: AppSpace.md),
        Expanded(
          child: _Stat(
            value: '${progress.weeklyMinutes}',
            label: 'دقيقة هذا الأسبوع',
          ),
        ),
        const SizedBox(width: AppSpace.md),
        Expanded(
          child: _Stat(
            value: streak > 0 ? '$streak' : '—',
            label: streak > 0 ? 'يوم متواصل' : 'ابدأ سلسلتك',
          ),
        ),
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.label});

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

class _TodayLessonCard extends ConsumerWidget {
  const _TodayLessonCard({required this.lesson, required this.completed, required this.hasAttempt});

  final Lesson lesson;
  final bool completed;
  final bool hasAttempt;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final actionLabel = completed
        ? 'راجع الدرس'
        : hasAttempt
            ? 'أكمل الدرس'
            : 'ابدأ الدرس';
    return AppCard(
      padding: const EdgeInsets.all(AppSpace.xl),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Tag(completed ? 'مكتمل' : 'درس اليوم', icon: completed ? Icons.check_circle_outline : Icons.today_outlined),
              const Spacer(),
              Text('${lesson.durationMinutes} دقائق', style: AppType.caption.copyWith(color: AppColors.textMuted)),
            ],
          ),
          const SizedBox(height: AppSpace.lg),
          Text(lesson.titleAr, style: AppType.title),
          const SizedBox(height: AppSpace.xs),
          EnglishText(lesson.title, style: AppType.subtitle.copyWith(color: AppColors.textMuted)),
          const SizedBox(height: AppSpace.md),
          Text(
            lesson.description,
            style: AppType.body.copyWith(color: AppColors.textMuted),
          ),
          const SizedBox(height: AppSpace.xl),
          PrimaryButton(
            label: actionLabel,
            icon: Icons.play_arrow_rounded,
            onPressed: () async {
              await Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => LessonScreen(lesson: lesson)),
              );
              ref.invalidate(todayLessonProvider);
              ref.invalidate(progressProvider);
              ref.invalidate(usageProvider);
            },
          ),
        ],
      ),
    );
  }
}

class _TodayError extends StatelessWidget {
  const _TodayError({required this.error, required this.ref});

  final Object error;
  final WidgetRef ref;

  @override
  Widget build(BuildContext context) {
    // A learner with no lesson published yet is not an error condition worth
    // shouting about; the server says so with UNKNOWN_LESSON.
    final isNoLessons = error is ApiError && (error as ApiError).code == 'UNKNOWN_LESSON';
    if (isNoLessons) {
      return EmptyState(
        icon: Icons.menu_book_outlined,
        title: 'ما فيه دروس متوفرة حالياً',
        body: 'نضيف دروس جديدة قريب. ارجع لنا بعد شوي.',
        action: SizedBox(
          width: 220,
          child: PrimaryButton(label: 'حدّث الصفحة', onPressed: () async => ref.invalidate(todayLessonProvider)),
        ),
      );
    }
    return ErrorState(
      message: userMessageFor(error),
      onRetry: () async => ref.invalidate(todayLessonProvider),
    );
  }
}

class _QuickLinks extends StatelessWidget {
  const _QuickLinks({required this.progress});

  final Progress? progress;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionTitle('تصفّح'),
        const SizedBox(height: AppSpace.md),
        Row(
          children: [
            Expanded(
              child: _QuickLink(
                icon: Icons.trending_up,
                label: 'تقدمي',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => const ProgressScreen()),
                ),
              ),
            ),
            const SizedBox(width: AppSpace.md),
            Expanded(
              child: _QuickLink(
                icon: Icons.style_outlined,
                label: 'كلماتي',
                badge: (progress?.vocabularyDueForReview ?? 0) > 0 ? '${progress!.vocabularyDueForReview}' : null,
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => const VocabularyScreen()),
                ),
              ),
            ),
            const SizedBox(width: AppSpace.md),
            Expanded(
              child: _QuickLink(
                icon: Icons.menu_book_outlined,
                label: 'الدروس',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => const LessonListScreen()),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _QuickLink extends StatelessWidget {
  const _QuickLink({required this.icon, required this.label, required this.onTap, this.badge});

  final IconData icon;
  final String label;
  final String? badge;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.lg),
      child: Container(
        constraints: const BoxConstraints(minHeight: 84),
        padding: const EdgeInsets.all(AppSpace.md),
        decoration: BoxDecoration(
          color: AppColors.surfaceRaised,
          borderRadius: BorderRadius.circular(AppRadius.lg),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Row(
              children: [
                Icon(icon, size: 20, color: AppColors.primary),
                const Spacer(),
                if (badge != null) Tag(badge!, icon: Icons.priority_high),
              ],
            ),
            const SizedBox(height: AppSpace.sm),
            Text(label, style: AppType.label),
          ],
        ),
      ),
    );
  }
}
