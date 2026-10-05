param([Parameter(Mandatory)][string]$Control, [Parameter(Mandatory)][string]$Evidence, [Parameter(Mandatory)][string]$Source)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class JournalReader {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  public static string Digest(SafeFileHandle handle) {
    using (var stream = new FileStream(handle, FileAccess.Read, 4096, false)) {
      if (stream.Length < 1 || stream.Length > 33554432) throw new Exception("Journal bound refused");
      stream.Position = 0;
      using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
  }
}
'@
$before = [IO.Directory]::GetAccessControl($Source).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
$file = Join-Path $Control 'journal.bin'
$limit = [DateTime]::UtcNow.AddSeconds(90)
$held = $null
Set-Content -LiteralPath (Join-Path $Evidence 'started') -Value 'ready'
try {
  while ([DateTime]::UtcNow -lt $limit) {
    $held = [JournalReader]::CreateFile($file, 2147483648, 7, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
    if (-not $held.IsInvalid) { break }
    $held.Dispose()
    Start-Sleep -Milliseconds 1
  }
  if ($held.IsInvalid) { throw 'Journal reader deadline exceeded' }
  $blocked = [JournalReader]::CreateFile($file, 2147483648, 1, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
  $code = if ($blocked.IsInvalid) { [Runtime.InteropServices.Marshal]::GetLastWin32Error() } else { 0 }
  $blocked.Dispose()
  # FileStream owns this duplicate wrapper, not the retained kernel handle.
  $first = [JournalReader]::Digest([Microsoft.Win32.SafeHandles.SafeFileHandle]::new($held.DangerousGetHandle(), $false))
  @{ denied = $code; digest = $first } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $Evidence 'ready.json')
  while (-not (Test-Path -LiteralPath (Join-Path $Evidence 'finish')) -and [DateTime]::UtcNow -lt $limit) { Start-Sleep -Milliseconds 10 }
  if (-not (Test-Path -LiteralPath (Join-Path $Evidence 'finish'))) { throw 'Journal reader completion deadline exceeded' }
  $last = [JournalReader]::Digest([Microsoft.Win32.SafeHandles.SafeFileHandle]::new($held.DangerousGetHandle(), $false))
  $current = [JournalReader]::CreateFile($file, 2147483648, 7, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
  if ($current.IsInvalid) { throw 'Restored journal reader refused' }
  $digest = [JournalReader]::Digest($current)
  @{ denied = $code; first = $first; last = $last; current = $digest; restored = ([IO.Directory]::GetAccessControl($Source).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ceq $before) } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $Evidence 'receipt.json')
} finally {
  if ($null -ne $held) { $held.Dispose() }
}
