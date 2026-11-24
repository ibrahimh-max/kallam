# Runs the Flutter app test suite from a path without apostrophes, and prints a
# machine-checkable result line.
#
# Why this exists: this repository lives at "C:\Users\Dell\Desktop\Kal'lam". The
# folder name contains a single quote. Flutter's test tooling writes the absolute
# test path into generated Dart source wrapped in single quotes:
#
#   import 'file:///c:/Users/Dell/Desktop/Kal'lam/app/test/auth_flow_test.dart' as test;
#
# The embedded apostrophe terminates the string literal, so every test file fails
# to compile with "String starting with ' must end with '" pointing at Flutter's
# own temp listener.dart -- never at project code. The failure is environmental and
# says nothing about the tests.
#
# Fix: exercise the same working tree through a junction whose path has no quote.
#
# Usage:  powershell -File tools/run-app-tests.ps1
#         powershell -File tools/run-app-tests.ps1 test/font_bundle_test.dart
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TestArgs
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot 'app'

if (-not (Test-Path $appDir)) {
    throw "app/ not found at $appDir"
}

function Invoke-FlutterTest {
    param([string]$Directory, [string[]]$Targets)
    Push-Location $Directory
    try {
        # Passed positionally so each element becomes its own argv entry.
        # Splatting (@Targets) character-splits a single string under PS 5.1.
        $output = & flutter test $Targets 2>&1 | Out-String
        $code = $LASTEXITCODE
        return @{ Output = $output; Code = $code }
    }
    finally { Pop-Location }
}

# "00:03 +48: C:/.../test/x.dart: name" then "00:03 +49: All tests passed!"
function Get-PassedCount {
    param([string]$Output)
    $best = -1
    foreach ($m in [regex]::Matches($Output, '(?m)^[^\r\n]*?\+(\d+)(?:\s|:)')) {
        $n = [int]$m.Groups[1].Value
        if ($n -gt $best) { $best = $n }
    }
    return $best
}

$workingDir = $appDir

if ($repoRoot -match "'") {
    $link = Join-Path $env:TEMP 'saudi-english-tutor-app'
    if (Test-Path $link) {
        $existing = Get-Item $link -Force
        if ($existing.LinkType -ne 'Junction') {
            throw "Refusing to use non-junction path $link"
        }
        if ($existing.Target -ne $repoRoot) {
            throw "Refusing to use junction $link because it targets a different directory"
        }
    }
    if (-not (Test-Path $link)) {
        New-Item -ItemType Junction -Path $link -Target $repoRoot | Out-Null
        Write-Host "Created junction: $link -> $repoRoot"
    }
    $workingDir = Join-Path $link 'app'
}

$result = Invoke-FlutterTest -Directory $workingDir -Targets $TestArgs
Write-Output $result.Output
Write-Host "flutter test exit code: $($result.Code)"

$passed = Get-PassedCount -Output $result.Output

# Emit the structured receipt only when the run was genuinely green, so a parse
# failure can never be mistaken for a pass.
if ($result.Code -eq 0 -and $passed -ge 0) {
    $checks = @(@{ name = 'app flutter test suite passed'; actual = $passed; expected = $passed })
    Write-Output (ConvertTo-Json -Compress -Depth 4 -InputObject @{ harnessVerification = @{ version = 1; checks = $checks } })
}

exit $result.Code
