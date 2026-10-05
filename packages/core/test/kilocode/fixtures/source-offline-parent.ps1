$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HeldOffline {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long born, out long exited, out long kernel, out long user);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
 [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$dir=Join-Path $env:TEMP ('raya-offline-parent-check-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($dir)|Out-Null
$ready=Join-Path $dir 'ready.json'
$fixture=Join-Path $PSScriptRoot 'source-offline-native.ts'
$source=Start-Process -FilePath $env:RAYA_SOURCE_OFFLINE_TEST_BUN -ArgumentList ('"{0}" --parent-death "{1}"' -f $fixture,$ready) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'stdout.log') -RedirectStandardError (Join-Path $dir 'stderr.log')
$deadline=[DateTime]::UtcNow.AddSeconds(20)
while(-not [IO.File]::Exists($ready)) {if($source.HasExited -or [DateTime]::UtcNow -gt $deadline){throw 'Owned parent never became held-ready'};Start-Sleep -Milliseconds 25}
$row=Get-Content -LiteralPath $ready -Raw|ConvertFrom-Json
$handle=[HeldOffline]::OpenProcess(0x101000,$false,[uint32]$row.guardianPID)
if($handle -eq [IntPtr]::Zero){throw 'Exact guardian native handle missing'}
$owner=[IntPtr]::Zero
try {
 $born=0L;$exited=0L;$kernel=0L;$user=0L
 if(-not [HeldOffline]::GetProcessTimes($handle,[ref]$born,[ref]$exited,[ref]$kernel,[ref]$user) -or $born.ToString() -ne $row.guardianBirth){throw 'Guardian birth changed'}
 $native=Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $row.guardianPID)
 if($native.ParentProcessId -ne $row.relayPID -or $native.ExecutablePath -ine $row.helper -or (Get-FileHash -LiteralPath $row.helper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $row.helperDigest){throw 'Guardian exact relay/image pin changed'}
 $owner=[HeldOffline]::OpenProcess(0x101000,$false,[uint32]$row.sourcePID)
 $born=0L
 if($owner -eq [IntPtr]::Zero -or -not [HeldOffline]::GetProcessTimes($owner,[ref]$born,[ref]$exited,[ref]$kernel,[ref]$user) -or $born.ToString() -ne $row.sourceBirth){throw 'Exact source kernel birth changed'}
 [IO.File]::WriteAllText($ready+'.permit','native handle held')
 $sourcecode=[uint32]0
 if([HeldOffline]::WaitForSingleObject($owner,20000) -ne 0 -or -not [HeldOffline]::GetExitCodeProcess($owner,[ref]$sourcecode) -or $sourcecode -ne 0){throw 'Source parent did not exit naturally0'}
 if([HeldOffline]::WaitForSingleObject($handle,20000) -ne 0){throw 'Guardian did not join rollback after parent death'}
 $code=[uint32]0
 if(-not [HeldOffline]::GetExitCodeProcess($handle,[ref]$code) -or $code -ne 1){throw "Parent-death capture native code was $code; profile $($row.root)"}
 $exact=(Get-Acl -LiteralPath $row.source).Sddl -eq $row.original
 if(-not $exact){throw 'Independent source DACL differs after parent death'}
 [IO.File]::WriteAllText((Join-Path $row.source 'after-parent-death.txt'),'restored')
 [pscustomobject]@{driver=$dir;profile=$row.root;sourcePID=$source.Id;sourceBirth=$row.sourceBirth;sourceCode=$sourcecode;guardianPID=$row.guardianPID;guardianBirth=$row.guardianBirth;guardianCode=$code;nativeHandleHeldBeforeParentDeath=$true;exactDaclRestored=$exact;sourceWritable=$true;captureSuccessful=$false;portableCaptureAuthorized=$false}|ConvertTo-Json -Depth 8
} finally {if($owner -ne [IntPtr]::Zero){[HeldOffline]::CloseHandle($owner)|Out-Null};[HeldOffline]::CloseHandle($handle)|Out-Null}
