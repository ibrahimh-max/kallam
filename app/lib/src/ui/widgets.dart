import 'package:flutter/material.dart';

import '../theme/tokens.dart';

/// Shared, reusable UI. Small widgets with one job, kept in one place so screens
/// stay readable and a change lands everywhere at once.

/// The English phrase the learner must say or read.
///
/// Always laid out LTR inside its own directionality: an English sentence in an
/// RTL page would otherwise get its punctuation and numbers reordered, which is
/// exactly the text the learner is being taught to read.
class EnglishPhrase extends StatelessWidget {
  const EnglishPhrase(this.text, {super.key, this.style, this.textAlign});

  final String text;
  final TextStyle? style;
  final TextAlign? textAlign;

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Text(
        text,
        style: (style ?? AppType.phrase).copyWith(color: AppColors.text),
        textAlign: textAlign ?? TextAlign.start,
      ),
    );
  }
}

/// Shorter English fragment: option text, vocabulary term, an inline correction.
class EnglishText extends StatelessWidget {
  const EnglishText(this.text, {super.key, this.style, this.maxLines});

  final String text;
  final TextStyle? style;
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Text(
        text,
        style: style ?? AppType.body.copyWith(color: AppColors.text),
        maxLines: maxLines,
        overflow: maxLines == null ? TextOverflow.clip : TextOverflow.ellipsis,
      ),
    );
  }
}

/// A titled content block. Used instead of nesting cards inside cards.
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpace.lg),
    this.color,
    this.borderColor,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? color;
  final Color? borderColor;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: color ?? AppColors.surfaceRaised,
        borderRadius: BorderRadius.circular(AppRadius.lg),
        border: Border.all(color: borderColor ?? AppColors.border),
      ),
      child: child,
    );
  }
}

/// The single primary action on a screen.
///
/// Handles its own in-flight state: while [onPressed] awaits, the button is
/// disabled and shows a spinner, which is what stops a double submit creating two
/// attempts or two billed transcriptions.
class PrimaryButton extends StatefulWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.busyLabel,
    this.icon,
  });

  final String label;
  final String? busyLabel;
  final IconData? icon;

  /// Returning a future keeps the button busy until the work really finished.
  final Future<void> Function()? onPressed;

  @override
  State<PrimaryButton> createState() => _PrimaryButtonState();
}

class _PrimaryButtonState extends State<PrimaryButton> {
  bool _busy = false;

  Future<void> _handle() async {
    final action = widget.onPressed;
    if (action == null || _busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onPressed != null && !_busy;
    return FilledButton(
      onPressed: enabled ? _handle : null,
      child: _busy
          ? Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                ),
                const SizedBox(width: AppSpace.md),
                Text(widget.busyLabel ?? 'لحظة…'),
              ],
            )
          : Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (widget.icon != null) ...[
                  Icon(widget.icon, size: 20),
                  const SizedBox(width: AppSpace.sm),
                ],
                Flexible(child: Text(widget.label, textAlign: TextAlign.center)),
              ],
            ),
    );
  }
}

/// Full-screen state for "we could not load this".
///
/// Always says what happened and offers the retry, and it is a real button so the
/// learner is never stuck on a dead screen (error state requirement).
class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.message, this.onRetry, this.retryLabel = 'جرّب مرة ثانية'});

  final String message;
  final Future<void> Function()? onRetry;
  final String retryLabel;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpace.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_outlined, size: 40, color: AppColors.textFaint),
            const SizedBox(height: AppSpace.lg),
            Text(message, textAlign: TextAlign.center, style: AppType.body.copyWith(color: AppColors.textMuted)),
            if (onRetry != null) ...[
              const SizedBox(height: AppSpace.xl),
              SizedBox(
                width: 220,
                child: PrimaryButton(label: retryLabel, onPressed: onRetry),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Empty state: explains what is missing and always offers the next action.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, required this.body, this.action});

  final IconData icon;
  final String title;
  final String body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpace.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: AppColors.textFaint),
            const SizedBox(height: AppSpace.lg),
            Text(title, textAlign: TextAlign.center, style: AppType.subtitle),
            const SizedBox(height: AppSpace.sm),
            Text(body, textAlign: TextAlign.center, style: AppType.body.copyWith(color: AppColors.textMuted)),
            if (action != null) ...[
              const SizedBox(height: AppSpace.xl),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}

class LoadingState extends StatelessWidget {
  const LoadingState({super.key, this.label});

  final String? label;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(),
          if (label != null) ...[
            const SizedBox(height: AppSpace.lg),
            Text(label!, style: AppType.body.copyWith(color: AppColors.textMuted)),
          ],
        ],
      ),
    );
  }
}

/// A small Arabic tag: correction type, cache state, streak.
///
/// Named [Tag] rather than `Chip` so it does not collide with Material's own
/// `Chip` in screens that import both `material.dart` and this file.
class Tag extends StatelessWidget {
  const Tag(this.label, {super.key, this.background, this.foreground, this.icon});

  final String label;
  final Color? background;
  final Color? foreground;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final bg = background ?? AppColors.primarySoft;
    final fg = foreground ?? AppColors.primaryDark;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.md, vertical: AppSpace.sm),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(AppRadius.sm)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 14, color: fg),
            const SizedBox(width: AppSpace.xs),
          ],
          Text(label, style: AppType.caption.copyWith(color: fg, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

/// Section heading used across the lesson and progress screens.
class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key, this.trailing});

  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(child: Text(text, style: AppType.subtitle)),
        ?trailing,
      ],
    );
  }
}

/// Shown when the learner must agree to voice processing before the mic is used.
///
/// It is presented as our own consent, and the app never records before it is
/// granted (the server also refuses with CONSENT_REQUIRED as a second check).
class ConsentNotice extends StatelessWidget {
  const ConsentNotice({super.key, required this.onGrant, this.busy = false});

  final Future<void> Function() onGrant;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      color: AppColors.attentionSoft,
      borderColor: AppColors.attention,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.privacy_tip_outlined, size: 18, color: AppColors.attention),
              const SizedBox(width: AppSpace.sm),
              Text('نحتاج موافقتك على المايك', style: AppType.label.copyWith(color: AppColors.attention)),
            ],
          ),
          const SizedBox(height: AppSpace.sm),
          Text(
            'نسجل صوتك فقط وقت التمرين، ونرسله لتحويل الكلام إلى نص. ما نحفظ التسجيل بعد انتهاء المحاولة.',
            style: AppType.body.copyWith(color: AppColors.textMuted),
          ),
          const SizedBox(height: AppSpace.lg),
          PrimaryButton(label: 'أوافق', onPressed: busy ? null : onGrant),
        ],
      ),
    );
  }
}
