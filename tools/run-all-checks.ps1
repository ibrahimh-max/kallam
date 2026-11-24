# Full regression gate for the Saudi English Tutor repository.
#
# Runs every baseline check that can run in this environment and prints ONE
# machine-checkable harnessVerification line. Checks that require an external
# credential or service (live Supabase / additional paid HUMAIN calls) are
# deliberately NOT here -- they are reported as blocked instead of faked.
#
# The Flutter steps run through tools/run-app-tests.ps1 because this repository's
# path contains an apostrophe, which breaks `flutter test` directly (see that
# script's header, and docs/development-log.md).
#
# Usage: powershell -File tools/run-all-checks.ps1
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $repoRoot 'server'
$appDir = Join-Path $repoRoot 'app'
$checks = @()

function Add-Check {
    param([string]$Name, $Actual, $Expected)
    $script:checks += @{ name = $Name; actual = $Actual; expected = $Expected }
}

# --- 1. Backend typecheck -----------------------------------------------------
Push-Location $serverDir
try {
    $tscOut = & npx tsc --noEmit -p tsconfig.json 2>&1 | Out-String
    $tscCode = $LASTEXITCODE
}
finally { Pop-Location }
Add-Check 'server typecheck exits clean' $tscCode 0
if ($tscCode -ne 0) { Write-Host "tsc output:`n$tscOut" }

# --- 2. Backend test suite ----------------------------------------------------
Push-Location $serverDir
try {
    $testOut = & npm test 2>&1 | Out-String
}
finally { Pop-Location }

$ran = if ($testOut -match 'tests\s+(\d+)') { [int]$Matches[1] } else { -1 }
$passed = if ($testOut -match 'pass\s+(\d+)') { [int]$Matches[1] } else { -1 }
$failed = if ($testOut -match 'fail\s+(\d+)') { [int]$Matches[1] } else { -1 }
Add-Check 'server test suite passes with no failing tests' $failed 0
Add-Check 'server test suite discovers tests' ([int]($ran -gt 0)) 1
Add-Check 'server test suite passes every discovered test' $passed $ran
if ($failed -ne 0) { Write-Host "npm test output:`n$testOut" }

# --- 3. Flutter static analysis ----------------------------------------------
Push-Location $appDir
try {
    $anOut = & flutter analyze 2>&1 | Out-String
}
finally { Pop-Location }

$issueCount = if ($anOut -match 'No issues found') { 0 }
elseif ($anOut -match '(\d+)\s+issues?\s+found') { [int]$Matches[1] } else { -1 }
Add-Check 'flutter analyze reports no issues' $issueCount 0
if ($issueCount -ne 0) { Write-Host "flutter analyze output:`n$anOut" }

# --- 4. Flutter test suite (via the apostrophe-safe runner) -------------------
$appTests = & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-app-tests.ps1') 2>&1 | Out-String
$flutterPassed = -1
foreach ($m in [regex]::Matches($appTests, '(?m)^[^\r\n]*?\+(\d+)(?:\s|:)')) {
    $n = [int]$m.Groups[1].Value
    if ($n -gt $flutterPassed) { $flutterPassed = $n }
}
if ($appTests -match 'flutter test exit code: (\d+)') { $flutterExit = [int]$Matches[1] } else { $flutterExit = -1 }
Add-Check 'app flutter test command exits cleanly' $flutterExit 0
Add-Check 'app flutter test suite discovers tests' ([int]($flutterPassed -gt 0)) 1
if ($flutterExit -ne 0 -or $flutterPassed -lt 1) { Write-Host "flutter test output:`n$appTests" }

# --- 5. End-to-end learner journey against a fresh mock-backed server ---------
$portListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$portListener.Start()
$e2ePort = $portListener.LocalEndpoint.Port
$portListener.Stop()

$serverProcess = $null
$e2eOut = ''
$e2eCode = 1
$retentionObserved = $false
$logStem = Join-Path $env:TEMP ('saudi-english-tutor-e2e-' + [Guid]::NewGuid().ToString('N'))
$stdoutPath = $logStem + '.out'
$stderrPath = $logStem + '.err'
$envNames = @('NODE_ENV', 'VOICE_PROVIDER', 'EMAIL_PROVIDER', 'AUTH_DRIVER', 'REPOSITORY_DRIVER', 'LOCAL_JWT_SECRET', 'PORT', 'E2E_BASE_URL')
$oldEnv = @{}
foreach ($name in $envNames) { $oldEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

try {
    $env:NODE_ENV = 'test'
    $env:VOICE_PROVIDER = 'mock'
    $env:EMAIL_PROVIDER = 'mock'
    $env:AUTH_DRIVER = 'local'
    $env:REPOSITORY_DRIVER = 'memory'
    $env:LOCAL_JWT_SECRET = 'test-only-e2e-secret-with-at-least-32-characters'
    $env:PORT = [string]$e2ePort

    $serverProcess = Start-Process -FilePath 'node' -ArgumentList @('src/server.ts') `
        -WorkingDirectory $serverDir -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if ($serverProcess.HasExited) { break }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$e2ePort/health" -TimeoutSec 2
            if ($health.voice_provider -eq 'mock' -and $health.repository -eq 'memory') {
                $ready = $true
                break
            }
        }
        catch { }
        Start-Sleep -Milliseconds 200
    }

    if ($ready) {
        Push-Location $serverDir
        try {
            $env:E2E_BASE_URL = "http://127.0.0.1:$e2ePort"
            $e2eOut = & node tests/e2e-journey.mjs 2>&1 | Out-String
            $e2eCode = $LASTEXITCODE
        }
        finally { Pop-Location }
    }
    else {
        $e2eOut = "Fresh mock-backed server did not become ready.`n"
        if (Test-Path $stdoutPath) { $e2eOut += Get-Content $stdoutPath -Raw }
        if (Test-Path $stderrPath) { $e2eOut += Get-Content $stderrPath -Raw }
    }
}
finally {
    if ($serverProcess -and -not $serverProcess.HasExited) {
        Stop-Process -Id $serverProcess.Id -Force
    }
    foreach ($name in $envNames) {
        [Environment]::SetEnvironmentVariable($name, $oldEnv[$name], 'Process')
    }
}

$serverLog = ''
if (Test-Path $stdoutPath) { $serverLog += Get-Content $stdoutPath -Raw -ErrorAction SilentlyContinue }
if (Test-Path $stderrPath) { $serverLog += Get-Content $stderrPath -Raw -ErrorAction SilentlyContinue }
$retentionObserved = $serverLog.Contains('"msg":"retention.completed"')
Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

$e2ePassed = if ($e2eOut -match '(\d+) checks passed, (\d+) failed') { [int]$Matches[1] } else { -1 }
$e2eFailed = if ($e2eOut -match '(\d+) checks passed, (\d+) failed') { [int]$Matches[2] } else { -1 }
Add-Check 'fresh-server learner journey exits cleanly' $e2eCode 0
Add-Check 'retention job runs on fresh server startup' ([int]$retentionObserved) 1
Add-Check 'live MVP journey discovers checks' ([int]($e2ePassed -gt 0)) 1
Add-Check 'live MVP journey passes every discovered check' $e2ePassed ($e2ePassed + $e2eFailed)
Add-Check 'live MVP journey has no failed checks' $e2eFailed 0
if ($e2eCode -ne 0 -or $e2eFailed -ne 0) { Write-Host "e2e output:`n$e2eOut" }

# --- Report -------------------------------------------------------------------
Write-Host ("Observed test counts: backend={0}/{1}; Flutter={2}; end-to-end={3}/{4}" -f `
    $passed, $ran, $flutterPassed, $e2ePassed, ($e2ePassed + $e2eFailed))
$allPassed = $true
foreach ($c in $checks) {
    $ok = ($c.actual -eq $c.expected)
    if (-not $ok) { $allPassed = $false }
    $mark = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("  [{0}] {1}: actual={2} expected={3}" -f $mark, $c.name, $c.actual, $c.expected)
}

Write-Output (ConvertTo-Json -Compress -Depth 4 -InputObject @{ harnessVerification = @{ version = 1; checks = $checks } })

if (-not $allPassed -or $ran -ne $passed) { exit 1 }
exit 0
