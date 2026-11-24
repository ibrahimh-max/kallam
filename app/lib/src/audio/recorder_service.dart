import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

import '../data/models.dart';
import 'wav_writer.dart';

/// Raised when the learner has not granted microphone access, or the OS refused
/// the recorder. The UI turns this into a clear "we need the mic" state with a
/// route to Settings — never a silent failure.
class MicrophoneUnavailable implements Exception {
  MicrophoneUnavailable(this.messageAr, [this.detail]);
  final String messageAr;
  final String? detail;
  @override
  String toString() => 'MicrophoneUnavailable($messageAr)';
}

/// Captures a short spoken answer and hands back a WAV payload.
///
/// Contract with the rest of the app: [stop] returns `null` when nothing usable
/// was captured (too short to be speech, or the file could not be read). The
/// caller shows "let's try that again" rather than uploading a useless clip and
/// spending a credit on silence.
class AudioRecorderService {
  AudioRecorderService({AudioRecorder? recorder}) : _recorder = recorder ?? AudioRecorder();

  final AudioRecorder _recorder;

  /// A clip shorter than this is not a spoken attempt: the provider would be
  /// billed for silence and the learner would get a confusing retry. 0.4 s is
  /// below any real word.
  static const double minUsefulSeconds = 0.4;

  /// Upper bound mirrors the server's own limit so the learner gets a clear
  /// "keep it short" message locally instead of a rejected upload.
  static const double maxSeconds = 15;

  BytesBuilder? _pcm;
  StreamSubscription<Uint8List>? _recordingSubscription;
  Object? _captureError;
  DateTime? _startedAt;

  bool get isRecording => _pcm != null;

  Future<bool> hasPermission() async {
    try {
      return await _recorder.hasPermission();
    } catch (_) {
      // A platform without the permission API must not crash startup.
      return false;
    }
  }

  /// Starts capturing raw PCM. Raw PCM (not a compressed container) is the point:
  /// [WavWriter] turns it into a WAV the provider accepts on every device.
  Future<void> start() async {
    if (!await hasPermission()) {
      throw MicrophoneUnavailable('لازم تسمح باستخدام المايك أول.', 'microphone permission denied');
    }
    try {
      final stream = await _recorder.startStream(
        const RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: WavWriter.defaultSampleRate,
          numChannels: WavWriter.channels,
        ),
      );
      final pcm = BytesBuilder(copy: false);
      _pcm = pcm;
      _captureError = null;
      _recordingSubscription = stream.listen(
        pcm.add,
        onError: (Object error) => _captureError ??= error,
      );
      _startedAt = DateTime.now();
    } on Exception catch (error) {
      throw MicrophoneUnavailable('ما قدرنا نبدأ التسجيل. جرّب مرة ثانية.', error.toString());
    }
  }

  /// Stops and returns the WAV bytes from memory, or `null` if unusable.
  Future<Uint8List?> stop() async {
    final pcm = _pcm;
    final startedAt = _startedAt;
    if (pcm == null) return null;

    _pcm = null;
    _startedAt = null;
    final subscription = _recordingSubscription;
    _recordingSubscription = null;

    Object? stopError;
    try {
      await _recorder.stop();
    } on Exception catch (error) {
      stopError = error;
    }
    try {
      await subscription?.cancel();
    } on Exception catch (error) {
      stopError ??= error;
    }
    final captureError = _captureError;
    _captureError = null;
    if (stopError != null || captureError != null) {
      pcm.takeBytes();
      throw MicrophoneUnavailable(
        'ما قدرنا نقرأ التسجيل. جرّب مرة ثانية.',
        (stopError ?? captureError).toString(),
      );
    }

    final elapsed = startedAt == null ? 0.0 : DateTime.now().difference(startedAt).inMilliseconds / 1000;
    if (elapsed < minUsefulSeconds) {
      pcm.takeBytes();
      return null;
    }

    final wav = WavWriter.wrapPcmAsWav(pcm.takeBytes());
    if (wav.isEmpty) return null;
    if (WavWriter.durationSecondsOf(wav) < minUsefulSeconds) return null;
    return wav;
  }

  /// Cancels and discards the in-memory take when the learner leaves the screen.
  Future<void> cancel() async {
    final pcm = _pcm;
    _pcm = null;
    _startedAt = null;
    _captureError = null;
    final subscription = _recordingSubscription;
    _recordingSubscription = null;
    if (pcm == null) return;

    try {
      await _recorder.stop();
    } on Exception {
      // The recorder may already have stopped.
    }
    try {
      await subscription?.cancel();
    } on Exception {
      // The stream may already have closed.
    }
    pcm.takeBytes();
  }

  Future<void> dispose() async {
    await cancel();
    try {
      await _recorder.dispose();
    } on Exception {
      // Already gone.
    }
  }

}

/// Plays cached TTS audio returned by the backend.
///
/// The bytes come from `POST /v1/tts`, which is cache-first, so replaying the
/// same phrase costs nothing. Playback writes to a temp file purely because the
/// player needs a path; it is deleted as soon as playback ends.
abstract class AudioPlayerService {
  Future<void> playBytes(Uint8List bytes, {required String contentType});

  Future<void> stop();

  Future<void> dispose();
}

/// The failure a speaking attempt can be turned into for display.
class SpeakingFailure implements Exception {
  SpeakingFailure(this.error);
  final ApiError error;
  String get messageAr => error.messageAr;
}
