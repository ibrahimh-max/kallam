// Scans the app's Dart sources for characters that are wrong in Arabic copy but
// look identical on screen: Farsi/Urdu letter forms and stray control codes.
//
// Why a scanner and not a one-off fix: these defects are invisible to review and
// to `flutter analyze`, and the UI is entirely Arabic, so this needs to be
// repeatable rather than a manual pass.
//
// Run: dart run tool/script_hygiene.dart
import 'dart:convert';
import 'dart:io';

/// Letter forms that exist only in Farsi/Urdu. Arabic has its own codepoints for
/// the same shapes (e.g. Farsi yeh U+06CC vs Arabic yeh U+064A), and using the
/// wrong one renders in a different fallback font in some contexts and breaks
/// text matching/search.
const Map<int, String> kForeignLetterForms = {
  0x06CC: 'FARSI YEH (use Arabic U+064A)',
  0x06A9: 'KEHEH (use Arabic U+0643)',
  0x06AF: 'GAF (no Arabic equivalent)',
  0x067E: 'PEH (no Arabic equivalent)',
  0x0686: 'TCHEH (use Arabic U+062C)',
  0x0698: 'JEH (no Arabic equivalent)',
  0x06D2: 'YEH BARREE',
  0x06C0: 'HEH WITH YEH ABOVE',
  0x06BE: 'HEH DOACHASHMEE',
};

/// Control characters that must never appear in source. A stray BEL or an
/// accidental backslash-escape shows up as an invisible glyph in learner-facing
/// copy, or silently truncates a string.
bool _isStrayControl(int code) {
  if (code == 0x09 || code == 0x0A || code == 0x0D) return false; // tab/LF/CR
  return code < 0x20 || code == 0x7F;
}

void main() {
  final root = Directory('lib');
  if (!root.existsSync()) {
    stderr.writeln('run from the app/ directory');
    exit(2);
  }

  var problems = 0;
  final files = root
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => f.path.endsWith('.dart'))
      .toList()
    ..sort((a, b) => a.path.compareTo(b.path));

  for (final file in files) {
    // Read as bytes and decode UTF-8 explicitly: the default on Windows is the
    // ANSI codepage, which would mangle every Arabic string before we inspect it.
    final lines = utf8.decode(file.readAsBytesSync()).split('\n');
    for (var i = 0; i < lines.length; i++) {
      final line = lines[i];
      for (final rune in line.runes) {
        final foreign = kForeignLetterForms[rune];
        if (foreign != null) {
          problems++;
          stdout.writeln('${file.path}:${i + 1}: U+${rune.toRadixString(16).toUpperCase()} $foreign');
          stdout.writeln('    $line');
        } else if (_isStrayControl(rune)) {
          problems++;
          stdout.writeln('${file.path}:${i + 1}: stray control U+${rune.toRadixString(16).toUpperCase().padLeft(4, '0')}');
          stdout.writeln('    $line');
        }
      }
    }
  }

  stdout.writeln(problems == 0 ? 'clean: ${files.length} files scanned' : 'found $problems problem(s)');
  exit(problems == 0 ? 0 : 1);
}
