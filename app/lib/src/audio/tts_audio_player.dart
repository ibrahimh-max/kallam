import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

/// Plays TTS audio that the backend returned as bytes.
///
/// Web playback uses BytesSource; native playback keeps the existing temporary
/// file path so older Android audio backends remain supported.
class TtsAudioPlayer {
  TtsAudioPlayer({AudioPlayer? player}) : _player = player ?? AudioPlayer();

  final AudioPlayer _player;
  String? _currentPath;

  /// Resolves when playback finishes, so a caller can sequence
  /// "play → then show the next step".
  Future<void> play(Uint8List bytes, {required String contentType}) async {
    await stop();
    if (bytes.isEmpty) return;
    if (kIsWeb) {
      final completed = _player.onPlayerComplete.first;
      await _player.play(BytesSource(bytes, mimeType: contentType));
      await completed;
      return;
    }

    final dir = await getTemporaryDirectory();
    final extension = contentType == 'audio/wav' ? 'wav' : 'bin';
    final file = File('${dir.path}${Platform.pathSeparator}tts_${DateTime.now().microsecondsSinceEpoch}.$extension');
    await file.writeAsBytes(bytes, flush: true);
    _currentPath = file.path;
    try {
      await _player.play(DeviceFileSource(file.path));
      await _player.onPlayerComplete.first;
    } finally {
      await _cleanup();
    }
  }

  Future<void> stop() async {
    try {
      await _player.stop();
    } on Exception {
      // Nothing playing.
    }
    await _cleanup();
  }

  Future<void> _cleanup() async {
    final path = _currentPath;
    _currentPath = null;
    if (path == null) return;
    try {
      final file = File(path);
      if (await file.exists()) await file.delete();
    } on FileSystemException {
      // Left for the OS temp cleaner.
    }
  }

  Future<void> dispose() async {
    await _cleanup();
    try {
      await _player.dispose();
    } on Exception {
      // Already disposed.
    }
  }
}
