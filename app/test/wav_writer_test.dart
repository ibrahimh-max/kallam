import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:saudi_english_tutor/src/audio/wav_writer.dart';

/// The WAV container is the one place where a wrong byte silently produces a file
/// the provider rejects at the edge of the speaking flow, so the layout is
/// asserted field by field against the canonical RIFF/WAVE header.
void main() {
  group('WavWriter header', () {
    test('writes the canonical 44-byte RIFF/WAVE header', () {
      final header = WavWriter.wavHeader(pcmByteLength: 3200);
      final view = ByteData.sublistView(header);

      expect(header.length, 44);
      expect(String.fromCharCodes(header.sublist(0, 4)), 'RIFF');
      // RIFF chunk size covers everything after these first 8 bytes.
      expect(view.getUint32(4, Endian.little), 36 + 3200);
      expect(String.fromCharCodes(header.sublist(8, 12)), 'WAVE');
      expect(String.fromCharCodes(header.sublist(12, 16)), 'fmt ');
      expect(view.getUint32(16, Endian.little), 16);
      expect(view.getUint16(20, Endian.little), 1, reason: 'PCM integer format');
      expect(view.getUint16(22, Endian.little), 1, reason: 'mono');
      expect(view.getUint32(24, Endian.little), 16000);
      expect(view.getUint32(28, Endian.little), 16000 * 1 * 2, reason: 'byte rate');
      expect(view.getUint16(32, Endian.little), 2, reason: 'block align');
      expect(view.getUint16(34, Endian.little), 16, reason: 'bits per sample');
      expect(String.fromCharCodes(header.sublist(36, 40)), 'data');
      expect(view.getUint32(40, Endian.little), 3200, reason: 'data chunk size');
    });

    test('honours a non-default sample rate instead of hardcoding 16 kHz', () {
      final view = ByteData.sublistView(WavWriter.wavHeader(pcmByteLength: 0, sampleRate: 8000));
      expect(view.getUint32(24, Endian.little), 8000);
      expect(view.getUint32(28, Endian.little), 16000);
    });
  });

  group('WavWriter payload', () {
    test('an empty recording stays empty rather than becoming a 44-byte clip', () {
      // A header-only file would look like valid audio and buy nothing but a
      // wasted credit, so this is a product rule, not a formatting detail.
      expect(WavWriter.wrapPcmAsWav(Uint8List(0)), isEmpty);
    });

    test('payload bytes survive unchanged after the header', () {
      final pcm = Uint8List.fromList(List<int>.generate(100, (i) => i % 256));
      final wav = WavWriter.wrapPcmAsWav(pcm);

      expect(wav.length, 44 + 100);
      expect(wav.sublist(44), equals(pcm));
      expect(ByteData.sublistView(wav).getUint32(40, Endian.little), 100);
    });

    test('records the payload length it was actually given', () {
      final even = WavWriter.wrapPcmAsWav(Uint8List(3200));
      final odd = WavWriter.wrapPcmAsWav(Uint8List(3201));

      expect(ByteData.sublistView(even).getUint32(40, Endian.little), 3200);
      expect(ByteData.sublistView(odd).getUint32(40, Endian.little), 3201);
      expect(ByteData.sublistView(odd).getUint32(4, Endian.little), 36 + 3201);
    });
  });

  group('WavWriter duration', () {
    test('reads duration back from the bytes actually being sent', () {
      // 16000 samples/s * 2 bytes = 32000 bytes per second; 32000 bytes == 1.0s.
      final oneSecond = WavWriter.wrapPcmAsWav(Uint8List(32000));
      expect(WavWriter.durationSecondsOf(oneSecond), closeTo(1.0, 0.0001));
    });

    test('a half-second clip is billed as half a second', () {
      final half = WavWriter.wrapPcmAsWav(Uint8List(16000));
      expect(WavWriter.durationSecondsOf(half), closeTo(0.5, 0.0001));
    });

    test('empty and header-only inputs report zero rather than a negative time', () {
      // Guards the boundary the server validates: a negative or NaN duration would
      // be rejected, and a wrong small positive would under-bill.
      expect(WavWriter.durationSecondsOf(Uint8List(0)), 0);
      expect(WavWriter.durationSecondsOf(WavWriter.wavHeader(pcmByteLength: 0)), 0);
      expect(WavWriter.durationSecondsOf(Uint8List(44)), 0);
    });
  });
}
