import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../ui/widgets.dart';
import 'lesson_screen.dart';

/// Every published lesson, grouped by level so a beginner is never dropped into
/// an advanced topic. The server owns the list and the order; the app only groups.
class LessonListScreen extends ConsumerWidget {
  const LessonListScreen({super.key});

  static const _levelLabels = <String, String>{
    'complete_beginner': 'مبتدئ من الصفر',
    'beginner': 'مبتدئ',
    'elementary': 'أساسي',
    'intermediate': 'متوسط',
    'advanced': 'متقدم',
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lessons = ref.watch(lessonsProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('الدروس')),
      body: lessons.when(
        loading: () => const LoadingState(label: 'نجيب الدروس…'),
        error: (error, _) => ErrorState(
          message: userMessageFor(error),
          onRetry: () async => ref.invalidate(lessonsProvider),
        ),
        data: (data) {
          if (data.isEmpty) {
            return EmptyState(
              icon: Icons.menu_book_outlined,
              title: 'ما فيه دروس منشورة',
              body: 'نضيف دروس جديدة قريب.',
              action: SizedBox(
                width: 220,
                child: PrimaryButton(label: 'حدّث', onPressed: () async => ref.invalidate(lessonsProvider)),
              ),
            );
          }

          // Preserve server order inside each level; levels in first-seen order.
          final grouped = <String, List<Lesson>>{};
          for (final lesson in data) {
            grouped.putIfAbsent(lesson.level, () => <Lesson>[]).add(lesson);
          }

          return ListView(
            padding: const EdgeInsets.fromLTRB(AppSpace.xl, AppSpace.lg, AppSpace.xl, AppSpace.xxl),
            children: [
              for (final entry in grouped.entries) ...[
                SectionTitle(_levelLabels[entry.key] ?? entry.key),
                const SizedBox(height: AppSpace.md),
                for (final lesson in entry.value)
                  Padding(
                    padding: const EdgeInsets.only(bottom: AppSpace.md),
                    child: _LessonTile(lesson: lesson),
                  ),
                const SizedBox(height: AppSpace.lg),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _LessonTile extends ConsumerWidget {
  const _LessonTile({required this.lesson});

  final Lesson lesson;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return InkWell(
      borderRadius: BorderRadius.circular(AppRadius.lg),
      onTap: () async {
        await Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => LessonScreen(lesson: lesson)),
        );
        ref.invalidate(todayLessonProvider);
        ref.invalidate(progressProvider);
      },
      child: AppCard(
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: AppColors.primarySoft,
                borderRadius: BorderRadius.circular(AppRadius.md),
              ),
              child: const Icon(Icons.play_arrow_rounded, color: AppColors.primaryDark),
            ),
            const SizedBox(width: AppSpace.lg),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(lesson.titleAr, style: AppType.label),
                  const SizedBox(height: AppSpace.xs),
                  EnglishText(lesson.title, style: AppType.caption.copyWith(color: AppColors.textMuted)),
                  const SizedBox(height: AppSpace.xs),
                  Text(
                    '${lesson.durationMinutes} دقائق · ${lesson.content.speakingPrompts.length} تمرين كلام',
                    style: AppType.caption.copyWith(color: AppColors.textFaint),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_left, color: AppColors.textFaint),
          ],
        ),
      ),
    );
  }
}
