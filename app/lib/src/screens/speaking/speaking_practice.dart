import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../audio/recorder_service.dart';
import '../../data/models.dart';
import '../../state/providers.dart';
import '../../theme/tokens.dart';
import '../../ui/widgets.dart';

/// The speaking exercise: understand the task in Arabic, say it in English, read
/// bounded corrections in Saudi Arabic, then try again.
///
/// This is the product's core turn, so it is one widget used by the lesson flow
/// and reused anywhere else a speaking attempt is needed. It owns the whole
/// state machine because the states must be exclusive — a learner can never be
/// recording and uploading at the same time.
///
/// What it deliberately does NOT do: invent feedback. Every correction, every
/// encouragement line and the retry decision come from the server's deterministic
/// rules (requirement R1). When the transcript is empty, too short or unmatched,
/// the server asks to retry and the app shows exactly that.
class SpeakingPractice extends ConsumerStatefulWidget {
  const SpeakingPractice({
    super.key,
    required this.prompt,
    this.lessonAttemptId,
    this.onAttemptFinished,
  });

  final SpeakingPrompt prompt;
  final String? lessonAttemptId;

  /// Called once an attempt has been evaluated, so a lesson can record progress.
  final VoidCallback? onAttemptFinished;

  @override
  ConsumerState<SpeakingPractice> createState() => _SpeakingPracticeState();
}

enum _Phase { idle, recording, transcribing, result }

class _SpeakingPracticeState extends ConsumerState<SpeakingPractice> with WidgetsBindingObserver {
  _Phase _phase = _Phase.idle;
  Timer? _recordingTimer;
  Stopwatch? _recordingClock;
  int _recordingElapsedSeconds = 0;
  String? _error;
  bool _consentRequired = false;
  SpeakingOutcome? _outcome;
  final _typedController = TextEditingController();
  bool _typedMode = false;

  /// Stable per attempt: retrying the *same* recording must not be billed twice,
  /// so the key is minted once and reused until the learner records again.
  String _idempotencyKey = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _idempotencyKey = _newKey();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _recordingTimer?.cancel();
    if (_phase == _Phase.recording) {
      unawaited(ref.read(recorderProvider).cancel());
    }
    _typedController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed && _phase == _Phase.recording) {
      unawaited(_cancelRecording('أوقفنا التسجيل لما خرجت من الشاشة.'));
    }
  }

  static String _newKey() =>
      'spk-${DateTime.now().microsecondsSinceEpoch}-${identityHashCode(Object())}';

  Future<void> _startRecording() async {
    setState(() {
      _error = null;
      _consentRequired = false;
      _outcome = null;
    });
    // The mic is never opened without active consent. The server enforces this too
    // (CONSENT_REQUIRED), but refusing here avoids opening the OS microphone at all.
    if (ref.read(authControllerProvider).profile?.voiceConsentGranted != true) {
      setState(() => _consentRequired = true);
      return;
    }
    try {
      final recorder = ref.read(recorderProvider);
      await recorder.start();
      if (!mounted) {
        await recorder.cancel();
        return;
      }
      setState(() {
        _phase = _Phase.recording;
        _recordingElapsedSeconds = 0;
      });
      _recordingClock = Stopwatch()..start();
      _recordingTimer = Timer.periodic(const Duration(milliseconds: 250), (_) {
        final clock = _recordingClock;
        if (!mounted || _phase != _Phase.recording || clock == null) {
          _recordingTimer?.cancel();
          return;
        }
        final elapsed = clock.elapsed;
        if (elapsed.inSeconds != _recordingElapsedSeconds) {
          setState(() => _recordingElapsedSeconds = elapsed.inSeconds);
        }
        if (elapsed >= Duration(seconds: AudioRecorderService.maxSeconds.toInt())) {
          _recordingTimer?.cancel();
          unawaited(_stopAndTranscribe());
        }
      });
    } on MicrophoneUnavailable catch (error) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.idle;
        _error = error.messageAr;
      });
    }
  }

  Future<void> _stopAndTranscribe() async {
    if (_phase != _Phase.recording) return;
    _recordingTimer?.cancel();
    _recordingClock?.stop();
    final recorder = ref.read(recorderProvider);
    setState(() => _phase = _Phase.transcribing);

    Uint8List? wav;
    try {
      wav = await recorder.stop();
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.idle;
        _error = userMessageFor(error);
      });
      return;
    }

    if (wav == null) {
      // Too short to be a spoken attempt. No upload, so no credit was spent.
      if (!mounted) return;
      setState(() {
        _phase = _Phase.idle;
        _error = 'التسجيل كان قصير. جرّب تتكلم جملة كاملة.';
      });
      return;
    }

    try {
      final outcome = await ref.read(apiClientProvider).transcribe(
            promptSlug: widget.prompt.slug,
            wav: wav,
            idempotencyKey: _idempotencyKey,
            lessonAttemptId: widget.lessonAttemptId,
          );
      if (!mounted) return;
      setState(() {
        _outcome = outcome;
        _phase = _Phase.result;
      });
      widget.onAttemptFinished?.call();
    } on Object catch (error) {
      if (!mounted) return;
      final apiError = error is ApiError ? error : null;
      setState(() {
        _phase = _Phase.idle;
        _consentRequired = apiError?.isConsentRequired ?? false;
        _error = userMessageFor(error);
      });
    }
  }

  Future<void> _evaluateTyped() async {
    final text = _typedController.text.trim();
    if (text.isEmpty) {
      setState(() => _error = 'اكتب الجملة أول.');
      return;
    }
    setState(() {
      _phase = _Phase.transcribing;
      _error = null;
    });
    try {
      // Typed practice is free: no provider call, same evaluation rules.
      final evaluation = await ref.read(apiClientProvider).evaluate(
            promptSlug: widget.prompt.slug,
            transcript: text,
          );
      if (!mounted) return;
      setState(() {
        _outcome = SpeakingOutcome(attemptId: '', transcript: text, evaluation: evaluation);
        _phase = _Phase.result;
      });
      widget.onAttemptFinished?.call();
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.idle;
        _error = userMessageFor(error);
      });
    }
  }

  Future<void> _tryAgain() async {
    _recordingTimer?.cancel();
    _recordingClock?.stop();
    await ref.read(recorderProvider).cancel();
    setState(() {
      _outcome = null;
      _error = null;
      _typedController.clear();
      _idempotencyKey = _newKey();
      _phase = _Phase.idle;
    });
  }

  Future<void> _cancelRecording(String message) async {
    if (_phase != _Phase.recording) return;
    _recordingTimer?.cancel();
    _recordingClock?.stop();
    setState(() => _phase = _Phase.transcribing);
    await ref.read(recorderProvider).cancel();
    if (!mounted) return;
    setState(() {
      _phase = _Phase.idle;
      _error = message;
    });
  }

  Future<void> _playModelAnswer() async {
    try {
      await ref.read(ttsProvider).speak(
            text: _outcome?.evaluation.modelAnswer.isNotEmpty == true
                ? _outcome!.evaluation.modelAnswer
                : widget.prompt.modelAnswer,
            script: 'en',
            namespace: 'lesson',
          );
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = userMessageFor(error));
    }
  }

  Future<void> _playTask() async {
    try {
      await ref.read(ttsProvider).speak(
            text: widget.prompt.taskEn,
            script: 'en',
            namespace: 'lesson',
          );
    } on Object catch (error) {
      if (!mounted) return;
      setState(() => _error = userMessageFor(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _TaskCard(prompt: widget.prompt, onPlay: _phase == _Phase.idle ? _playTask : null),
        const SizedBox(height: AppSpace.lg),

        // Shown both when the server refuses with CONSENT_REQUIRED and when consent
        // is simply not active, so a learner who withdrew it in settings is told
        // why the mic is unavailable instead of meeting a dead button.
        if (_consentRequired || auth.profile?.voiceConsentGranted != true)
          ConsentNotice(
            onGrant: () async {
              try {
                await ref.read(authControllerProvider.notifier).grantVoiceConsent();
                if (!mounted) return;
                setState(() {
                  _consentRequired = false;
                  _error = null;
                });
              } on Object catch (error) {
                if (!mounted) return;
                setState(() => _error = userMessageFor(error));
              }
            },
          ),

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

        switch (_phase) {
          _Phase.idle => _IdleControls(
              typedMode: _typedMode,
              controller: _typedController,
              onToggleTyped: () => setState(() {
                _typedMode = !_typedMode;
                _error = null;
              }),
              onRecord: _startRecording,
              onEvaluateTyped: _evaluateTyped,
              micAllowed: auth.profile != null,
            ),
          _Phase.recording => _RecordingControls(
              elapsedSeconds: _recordingElapsedSeconds,
              onStop: _stopAndTranscribe,
            ),
          _Phase.transcribing => const AppCard(
              child: Column(
                children: [
                  CircularProgressIndicator(),
                  SizedBox(height: AppSpace.lg),
                  Text('نسمع كلامك ونقيّمه…'),
                ],
              ),
            ),
          _Phase.result => _ResultView(
              outcome: _outcome!,
              onTryAgain: _tryAgain,
              onPlayModel: _playModelAnswer,
            ),
        },
      ],
    );
  }
}

/// The task in Arabic first — the learner must understand what to say before
/// being asked to say it.
class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.prompt, required this.onPlay});

  final SpeakingPrompt prompt;
  final Future<void> Function()? onPlay;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('مهمتك', style: AppType.label.copyWith(color: AppColors.primaryDark)),
          const SizedBox(height: AppSpace.sm),
          Text(prompt.taskAr, style: AppType.subtitle),
          const SizedBox(height: AppSpace.lg),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpace.lg),
            decoration: BoxDecoration(
              color: AppColors.primarySoft,
              borderRadius: BorderRadius.circular(AppRadius.md),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text('قول هذه الجملة', style: AppType.caption.copyWith(color: AppColors.primaryDark)),
                    const Spacer(),
                    if (onPlay != null)
                      IconButton(
                        tooltip: 'اسمع الجملة',
                        icon: const Icon(Icons.volume_up_outlined, color: AppColors.primaryDark),
                        onPressed: () => onPlay!(),
                      )
                    else
                      const Icon(Icons.volume_up_outlined, color: AppColors.textFaint),
                  ],
                ),
                EnglishPhrase(prompt.modelAnswer, style: AppType.phrase),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _IdleControls extends StatelessWidget {
  const _IdleControls({
    required this.typedMode,
    required this.controller,
    required this.onToggleTyped,
    required this.onRecord,
    required this.onEvaluateTyped,
    required this.micAllowed,
  });

  final bool typedMode;
  final TextEditingController controller;
  final VoidCallback onToggleTyped;
  final Future<void> Function() onRecord;
  final Future<void> Function() onEvaluateTyped;
  final bool micAllowed;

  @override
  Widget build(BuildContext context) {
    if (typedMode) {
      return AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: controller,
              maxLines: 3,
              maxLength: 1000,
              textInputAction: TextInputAction.done,
              decoration: const InputDecoration(
                labelText: 'اكتب جملتك بالإنجليزي',
                counterText: '',
              ),
            ),
            const SizedBox(height: AppSpace.lg),
            PrimaryButton(label: 'قيّم كتابتي', onPressed: onEvaluateTyped),
            const SizedBox(height: AppSpace.sm),
            TextButton(onPressed: onToggleTyped, child: const Text('أرجع للتسجيل الصوتي')),
          ],
        ),
      );
    }
    return Column(
      children: [
        PrimaryButton(
          label: micAllowed ? 'اضغط واتكلم' : 'التسجيل غير متاح',
          icon: Icons.mic_none_rounded,
          onPressed: micAllowed ? onRecord : null,
        ),
        const SizedBox(height: AppSpace.md),
        // Typed practice exists so a learner in a quiet place (or with a denied
        // mic) still gets feedback, and it costs nothing.
        TextButton(onPressed: onToggleTyped, child: const Text('اكتب بدل ما تتكلم')),
      ],
    );
  }
}

class _RecordingControls extends StatelessWidget {
  const _RecordingControls({required this.elapsedSeconds, required this.onStop});

  final int elapsedSeconds;
  final Future<void> Function() onStop;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: const BoxDecoration(color: AppColors.danger, shape: BoxShape.circle),
              ),
              const SizedBox(width: AppSpace.sm),
              Text('جاري التسجيل…', style: AppType.label.copyWith(color: AppColors.danger)),
            ],
          ),
          const SizedBox(height: AppSpace.sm),
          Text(
            '$elapsedSeconds / ${AudioRecorderService.maxSeconds.toInt()} ث',
            style: AppType.caption.copyWith(color: AppColors.textMuted),
          ),
          const SizedBox(height: AppSpace.lg),
          PrimaryButton(label: 'خلاص، قيّم كلامي', icon: Icons.stop_rounded, onPressed: onStop),
        ],
      ),
    );
  }
}

/// The feedback: Arabic encouragement, corrections with the Arabic explanation,
/// the model answer, and the retry that closes the learning loop.
class _ResultView extends StatelessWidget {
  const _ResultView({required this.outcome, required this.onTryAgain, required this.onPlayModel});

  final SpeakingOutcome outcome;
  final Future<void> Function() onTryAgain;
  final Future<void> Function() onPlayModel;

  @override
  Widget build(BuildContext context) {
    final evaluation = outcome.evaluation;
    // The retry state is the server's decision, shown as its own state with its
    // own Arabic reason — never dressed up as a correction.
    final needsRetry = evaluation.retryRequired;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          color: needsRetry ? AppColors.attentionSoft : AppColors.successSoft,
          borderColor: needsRetry ? AppColors.attention : AppColors.success,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    needsRetry ? Icons.refresh_rounded : Icons.check_circle_outline,
                    size: 20,
                    color: needsRetry ? AppColors.attention : AppColors.success,
                  ),
                  const SizedBox(width: AppSpace.sm),
                  Text(
                    needsRetry ? 'نحتاج نجرّب مرة ثانية' : 'أحسنت!',
                    style: AppType.subtitle.copyWith(
                      color: needsRetry ? AppColors.attention : AppColors.success,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: AppSpace.sm),
              Text(evaluation.encouragementAr, style: AppType.body),
              if (needsRetry && evaluation.retryReasonAr != null) ...[
                const SizedBox(height: AppSpace.sm),
                Text(
                  evaluation.retryReasonAr!,
                  style: AppType.body.copyWith(color: AppColors.textMuted),
                ),
              ],
            ],
          ),
        ),

        if (outcome.transcript.trim().isNotEmpty) ...[
          const SizedBox(height: AppSpace.lg),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('سمعنا منك', style: AppType.label.copyWith(color: AppColors.textMuted)),
                const SizedBox(height: AppSpace.sm),
                EnglishText(outcome.transcript, style: AppType.subtitle),
              ],
            ),
          ),
        ],

        if (evaluation.corrections.isNotEmpty) ...[
          const SizedBox(height: AppSpace.lg),
          const SectionTitle('تصحيحات بالعربي'),
          const SizedBox(height: AppSpace.md),
          for (final correction in evaluation.corrections)
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpace.md),
              child: AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Tag(correction.labelAr),
                    const SizedBox(height: AppSpace.md),
                    Row(
                      children: [
                        Expanded(child: EnglishText(correction.original, style: AppType.body.copyWith(color: AppColors.textMuted, decoration: TextDecoration.lineThrough))),
                        const Padding(
                          padding: EdgeInsets.symmetric(horizontal: AppSpace.sm),
                          child: Icon(Icons.arrow_forward, size: 16, color: AppColors.textFaint),
                        ),
                        Expanded(child: EnglishText(correction.suggested, style: AppType.body.copyWith(fontWeight: FontWeight.w600))),
                      ],
                    ),
                    const SizedBox(height: AppSpace.md),
                    Text(correction.explanationAr, style: AppType.body.copyWith(color: AppColors.textMuted)),
                  ],
                ),
              ),
            ),
        ],

        const SizedBox(height: AppSpace.lg),
        AppCard(
          color: AppColors.primarySoft,
          borderColor: AppColors.primarySoft,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('الجملة الصحيحة', style: AppType.label.copyWith(color: AppColors.primaryDark)),
                  const Spacer(),
                  IconButton(
                    tooltip: 'اسمع الجملة الصحيحة',
                    icon: const Icon(Icons.volume_up_outlined, color: AppColors.primaryDark),
                    onPressed: () => onPlayModel(),
                  ),
                ],
              ),
              EnglishPhrase(
                evaluation.modelAnswer.isNotEmpty ? evaluation.modelAnswer : '—',
                style: AppType.phrase,
              ),
            ],
          ),
        ),

        const SizedBox(height: AppSpace.xl),
        PrimaryButton(
          label: needsRetry ? 'جرّب مرة ثانية' : 'تمرين جديد',
          icon: Icons.refresh_rounded,
          onPressed: onTryAgain,
        ),
      ],
    );
  }
}
