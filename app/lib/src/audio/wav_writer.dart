import 'dart:typed_data';

/// Wraps raw 16-bit little-endian mono PCM in a minimal RIFF/WAVE container.
///
/// Why the app does this instead of asking the recorder for an `.m4a`: the
/// provider rejects the MP4 family unless the container has its `moov` atom
/// *before* the media data, and the platform recorders do not promise that
/// (recorded in `docs/audit-initialization.md` as risk R4). Capturing raw PCM and
/// writing a 44-byte header ourselves makes the upload `audio/wav`, which the
/// provider's accepted-container list covers unconditionally — so the core
/// speaking flow cannot fail on a real device because of an encoder setting.
///
/// The header is exactly the canonical 44-byte form; [wavHeader] and
/// [wrapPcmAsWav] are separate so the byte layout can be asserted directly in a
/// unit test without touching a microphone.
class WavWriter {
  const WavWriter._();

  static const int headerBytes = 44;

  /// Byte rate/block align depend on these; the server plays back at 16 kHz mono
  /// which is what speech recognition wants and keeps the upload small (FAST).
  static const int defaultSampleRate = 16000;
  static const int channels = 1;
  static const int bitsPerSample = 16;

  /// The 44-byte canonical WAVE header for [pcmByteLength] of little-endian PCM.
  static Uint8List wavHeader({
    required int pcmByteLength,
    int sampleRate = defaultSampleRate,
  }) {
    final byteRate = sampleRate * channels * (bitsPerSample ~/ 8);
    final blockAlign = channels * (bitsPerSample ~/ 8);
    final header = ByteData(headerBytes);

    void ascii(int offset, String value) {
      for (var i = 0; i < value.length; i++) {
        header.setUint8(offset + i, value.codeUnitAt(i));
      }
    }

    ascii(0, 'RIFF');
    header.setUint32(4, 36 + pcmByteLength, Endian.little); // chunk size
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    header.setUint32(16, 16, Endian.little); // PCM fmt chunk size
    header.setUint16(20, 1, Endian.little); // audio format: PCM integer
    header.setUint16(22, channels, Endian.little);
    header.setUint32(24, sampleRate, Endian.little);
    header.setUint32(28, byteRate, Endian.little);
    header.setUint16(32, blockAlign, Endian.little);
    header.setUint16(34, bitsPerSample, Endian.little);
    ascii(36, 'data');
    header.setUint32(40, pcmByteLength, Endian.little);
    return header.buffer.asUint8List();
  }

  /// Header + PCM. Returns an empty list for empty input rather than a header-only
  /// file, so an accidental empty recording is rejected as "no audio" instead of
  /// being uploaded as a valid-sounding 44-byte clip that would waste a credit.
  static Uint8List wrapPcmAsWav(Uint8List pcm, {int sampleRate = defaultSampleRate}) {
    if (pcm.isEmpty) return Uint8List(0);
    final out = Uint8List(headerBytes + pcm.length);
    out.setRange(0, headerBytes, wavHeader(pcmByteLength: pcm.length, sampleRate: sampleRate));
    out.setRange(headerBytes, out.length, pcm);
    return out;
  }

  /// Duration of a WAV payload, read back from its own header.
  ///
  /// The server requires an accurate `duration_seconds`, and it is what STT is
  /// billed on, so it is measured from the bytes actually being sent — not from a
  /// stopwatch that includes time spent starting the recorder.
  static double durationSecondsOf(Uint8List wav, {int sampleRate = defaultSampleRate}) {
    if (wav.length <= headerBytes) return 0;
    final pcmBytes = wav.length - headerBytes;
    final bytesPerSecond = sampleRate * channels * (bitsPerSample ~/ 8);
    return pcmBytes / bytesPerSecond;
  }
}
