param([string]$Item, [string]$Ready, [string]$Stop)
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open($Item, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try {
  [IO.File]::WriteAllText($Ready, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while (!(Test-Path -LiteralPath $Stop)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Hold deadline exceeded' }
    Start-Sleep -Milliseconds 20
  }
} finally {
  $stream.Dispose()
}
