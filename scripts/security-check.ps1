$ErrorActionPreference = 'Stop'
$repoRoot = (Split-Path -Parent $PSScriptRoot).Replace('\', '/')
Set-Location -LiteralPath $repoRoot

# Keep the check deterministic in managed workspaces where Git may consider the
# checkout owner different from the process owner. This does not alter global or
# repository configuration.
$gitSafeArgs = @('-c', "safe.directory=$repoRoot")

$blocked = @(
  '(password|secret|token|api[_-]?key)[[:space:]]*[:=][[:space:]]*["''][^"'']{8,}',
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----',
  'mongodb(\+srv)?://[^[:space:]]+:[^[:space:]]+@',
  'postgres(ql)?://[^[:space:]]+:[^[:space:]]+@'
)

$tracked = git @gitSafeArgs ls-files
if ($LASTEXITCODE -ne 0) { throw 'Git repository is not initialized.' }

$forbiddenExtensions = @('.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.p12', '.pfx', '.pem', '.key', '.db', '.sqlite')
$forbidden = $tracked | Where-Object { $forbiddenExtensions -contains [IO.Path]::GetExtension($_).ToLowerInvariant() }
if ($forbidden) {
  Write-Error ("Sensitive/binary runtime files are tracked:`n" + ($forbidden -join "`n"))
}

foreach ($pattern in $blocked) {
  # .env.example intentionally contains non-secret local placeholders.
  $matches = git @gitSafeArgs grep -n -I -i -E -- $pattern -- . ':!.env.example'
  $grepExitCode = $LASTEXITCODE
  if ($grepExitCode -eq 0 -and $matches) {
    Write-Error ("Potential secret detected for pattern ${pattern}:`n${matches}")
  }
  if ($grepExitCode -gt 1) { throw "Git secret scan failed for pattern: $pattern" }
}

Write-Host 'Security check passed: no forbidden artifacts or obvious embedded secrets found.' -ForegroundColor Green
exit 0
