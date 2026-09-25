param(
  [Parameter(Mandatory = $true)] [string] $Executable
)

$ErrorActionPreference = 'Stop'
$start = [Diagnostics.ProcessStartInfo]::new([IO.Path]::GetFullPath($Executable))
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::Start($start)
$writer = [IO.BinaryWriter]::new($process.StandardInput.BaseStream, [Text.Encoding]::UTF8, $true)
$reader = [IO.BinaryReader]::new($process.StandardOutput.BaseStream, [Text.Encoding]::UTF8, $true)
$session = '11111111111111111111111111111111'
$nonce = '33333333333333333333333333333333'

function Invoke-Request([string] $type, [string] $request, [long] $sequence, [string] $expectedType, [string] $expectedCode) {
  $frame = [ordered]@{
    v = 1
    type = $type
    session = $session
    request = $request
    sequence = $sequence
    nonce = $nonce
    windowID = '0'
    pid = 0
    scene = 0
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject $frame))
  $writer.Write([uint32] $bytes.Length)
  $writer.Write($bytes)
  $writer.Write([uint32] 0)
  $writer.Flush()
  $length = $reader.ReadUInt32()
  if ($length -le 0 -or $length -gt 4096) { throw "Invalid broker response length $length" }
  $header = $reader.ReadBytes($length)
  if ($header.Length -ne $length -or $reader.ReadUInt32() -ne 0) { throw 'Invalid broker response frame' }
  $reply = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($header))
  if ($reply.v -ne 1 -or $reply.type -ne $expectedType -or $reply.code -ne $expectedCode -or
      $reply.session -ne $session -or $reply.request -ne $request -or $reply.sequence -ne $sequence) {
    throw "Unexpected broker response: $($reply | ConvertTo-Json -Compress)"
  }
}

try {
  Invoke-Request 'hello' '22222222222222222222222222222222' 0 'ready' 'ok'
  Invoke-Request 'quiescent' '44444444444444444444444444444444' 1 'quiescent' 'ok'
  Invoke-Request 'quiescent' '44444444444444444444444444444444' 2 'refused' 'duplicate'
  Invoke-Request 'cancel' '55555555555555555555555555555555' 3 'cancelled' 'ok'
  Invoke-Request 'quiescent' '66666666666666666666666666666666' 4 'quiescent' 'ok'
  Write-Output 'desktop input broker pipe test passed'
} finally {
  $writer.Dispose()
  if (-not $process.WaitForExit(2000)) { $process.Kill(); $process.WaitForExit() }
  $reader.Dispose()
  $process.Dispose()
}
