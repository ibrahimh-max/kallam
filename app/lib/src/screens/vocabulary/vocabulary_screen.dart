import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/models.dart';
import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../ui/widgets.dart';

/// Spaced review. Words come from lessons the learner actually finished, so the
/// list is never somebody else's vocabulary.
///
/// A review is one tap — "I knew it" / "review again" — because the app's job is
/// to bring the word back at the right time, not to run a quiz engine.
class VocabularyScreen extends ConsumerWidget {
  const VocabularyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vocabulary = ref.watch(vocabularyProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('كلماتي')),
      body: vocabulary.when(
        loading: () => const LoadingState(label: 'نجيب كلماتك…'),
        error: (error, _) => ErrorState(
          message: userMessageFor(error),
          onRetry: () async => ref.invalidate(vocabularyProvider),
        ),
        data: (items) {
          if (items.isEmpty) {
            return const EmptyState(
              icon: Icons.style_outlined,
              title: 'لسه ما فيه كلمات',
              body: 'أكمل أول درس ونضيف كلماته هنا تلقائياً للمراجعة.',
            );
          }
          final due = items.where((i) => !i.isMastered).toList(growable: false);
          final mastered = items.where((i) => i.isMastered).toList(growable: false);

          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(vocabularyProvider),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(AppSpace.xl, AppSpace.lg, AppSpace.xl, AppSpace.xxl),
              children: [
                if (due.isNotEmpty) ...[
                  SectionTitle('للمراجعة', trailing: Tag('${due.length}')),
                  const SizedBox(height: AppSpace.md),
                  for (final item in due) _VocabularyTile(item: item),
                  const SizedBox(height: AppSpace.xl),
                ],
                if (mastered.isNotEmpty) ...[
                  SectionTitle('حفظتها', trailing: Tag('${mastered.length}', background: AppColors.successSoft, foreground: AppColors.success)),
                  const SizedBox(height: AppSpace.md),
                  for (final item in mastered) _VocabularyTile(item: item),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}

class _VocabularyTile extends ConsumerStatefulWidget {
  const _VocabularyTile({required this.item});

  final VocabularyItem item;

  @override
  ConsumerState<_VocabularyTile> createState() => _VocabularyTileState();
}

class _VocabularyTileState extends ConsumerState<_VocabularyTile> {
  bool _busy = false;
  String? _error;

  Future<void> _review(String reviewState) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).reviewVocabulary(widget.item.id, reviewState: reviewState);
      ref.invalidate(vocabularyProvider);
      ref.invalidate(progressProvider);
    } on Object catch (error) {
      if (!mounted) return;
      // The card stays exactly as it was, so the learner can retry the same tap.
      setState(() => _error = userMessageFor(error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpace.md),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: EnglishPhrase(item.englishTerm, style: AppType.title)),
                if (item.isMastered)
                  const Icon(Icons.check_circle_outline, size: 18, color: AppColors.success),
              ],
            ),
            const SizedBox(height: AppSpace.xs),
            Text(item.arabicMeaning, style: AppType.body.copyWith(color: AppColors.textMuted)),
            if (item.exampleSentence.trim().isNotEmpty) ...[
              const SizedBox(height: AppSpace.sm),
              EnglishText(item.exampleSentence, style: AppType.caption.copyWith(color: AppColors.textFaint)),
            ],
            if (_error != null) ...[
              const SizedBox(height: AppSpace.sm),
              Text(_error!, style: AppType.caption.copyWith(color: AppColors.attention)),
            ],
            const SizedBox(height: AppSpace.lg),
            if (!item.isMastered)
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _busy ? null : () => _review('learning'),
                      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(kMinTouchTarget)),
                      child: const Text('راجعها لاحقاً'),
                    ),
                  ),
                  const SizedBox(width: AppSpace.md),
                  Expanded(
                    child: FilledButton(
                      onPressed: _busy ? null : () => _review('mastered'),
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(kMinTouchTarget)),
                      child: const Text('حفظتها'),
                    ),
                  ),
                ],
              )
            else
              OutlinedButton(
                onPressed: _busy ? null : () => _review('learning'),
                style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(kMinTouchTarget)),
                child: const Text('راجعها مرة ثانية'),
              ),
          ],
        ),
      ),
    );
  }
}
