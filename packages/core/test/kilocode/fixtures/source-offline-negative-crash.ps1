param([string]$Root,[string]$Helper,[string]$Bun,[string]$Mode,[string]$Layout)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NegativeHeld {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long born, out long exited, out long kernel, out long user);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
 [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
 [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr handle, uint code);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$fixture=Join-Path $PSScriptRoot 'source-offline-negative-crash.ts'
$source=Start-Process -FilePath $Bun -ArgumentList ('"{0}" "{1}" "{2}" "{3}"' -f $fixture,$Root,$Helper,$Layout) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Root 'source-stdout.log') -RedirectStandardError (Join-Path $Root 'source-stderr.log')
$owner=[IntPtr]::Zero;$guardian=[IntPtr]::Zero
try {
 $ready=Join-Path $Root 'ready.json';$deadline=[DateTime]::UtcNow.AddSeconds(20)
 while(-not [IO.File]::Exists($ready)){if($source.HasExited -or [DateTime]::UtcNow -gt $deadline){throw 'Negative source failed before native ready'};Start-Sleep -Milliseconds 20}
 $row=Get-Content -LiteralPath $ready -Raw|ConvertFrom-Json
 $guardian=[NegativeHeld]::OpenProcess(0x101001,$false,[uint32]$row.guardianPID)
 $owner=[NegativeHeld]::OpenProcess(0x101001,$false,[uint32]$row.sourcePID)
 foreach($item in @(@{handle=$guardian;birth=$row.guardianBirth},@{handle=$owner;birth=$row.sourceBirth})){
  $born=0L;$exit=0L;$kernel=0L;$user=0L
  if($item.handle -eq [IntPtr]::Zero -or -not [NegativeHeld]::GetProcessTimes($item.handle,[ref]$born,[ref]$exit,[ref]$kernel,[ref]$user) -or $born.ToString() -ne $item.birth){throw 'Exact negative owner birth differs'}
 }
 $native=Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $row.guardianPID)
 if($native.ParentProcessId -ne $row.relayPID -or $native.ExecutablePath -ine $Helper -or (Get-FileHash -LiteralPath $Helper).Hash.ToLowerInvariant() -ne $row.helperDigest){throw 'Negative guardian image/lineage differs'}
 $file=[IO.File]::Open((Join-Path $row.control 'journal.bin'),[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Write -bor [IO.FileShare]::Delete))
 try {
  if($file.Length -le 0 -or $file.Length -gt 33554432){throw 'Negative encrypted journal bound'}
  $bytes=New-Object byte[] ([int]$file.Length);$offset=0
  while($offset -lt $bytes.Length){$read=$file.Read($bytes,$offset,$bytes.Length-$offset);if($read -le 0){throw 'Negative encrypted journal truncated'};$offset+=$read}
  if($file.ReadByte() -ne -1){throw 'Negative encrypted journal changed size'}
 } finally {$file.Dispose()}
 $journal=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 $stream=New-Object IO.MemoryStream(,$journal);$reader=New-Object IO.BinaryReader($stream)
 function text { $size=$reader.ReadUInt32();if($size -gt 32768){throw 'Negative journal field bound'};[Text.Encoding]::Unicode.GetString($reader.ReadBytes($size*2)) }
 if($reader.ReadUInt32() -ne 1 -or $reader.ReadUInt32() -ne 0){throw 'Held journal identity differs'}
 $null=text;$null=$reader.ReadUInt32();$null=text;$count=$reader.ReadUInt32();$parents=0;$original=$null
 for($index=0;$index -lt $count;$index++){
  $file=text;$directory=$reader.ReadUInt32();$null=$reader.ReadUInt32();$null=$reader.ReadUInt32();$null=$reader.ReadUInt32();$acl=text
  if($directory -ne 1){throw 'Negative journal includes captured file'}
  if($file -ieq $row.home){$parents++;$original=$acl;continue}
  if(-not $file.StartsWith($row.control+'\image',[StringComparison]::OrdinalIgnoreCase)){throw 'Negative journal includes sibling namespace'}
 }
 if($parents -ne 1 -or $stream.Position -ne $stream.Length){throw 'Negative journal did not deduplicate exact parent metadata'}
 $reader.Dispose();$stream.Dispose()
 if($Mode -eq 'guardian'){
  if(-not [NegativeHeld]::TerminateProcess($guardian,77)){throw 'Controlled guardian termination failed'}
  [IO.File]::WriteAllText((Join-Path $Root 'permit'),'held native fault')
 } elseif($Mode -eq 'parent'){
  if(-not [NegativeHeld]::TerminateProcess($owner,91)){throw 'Controlled source termination failed'}
 } else {throw 'Negative crash mode invalid'}
 if([NegativeHeld]::WaitForSingleObject($guardian,20000) -ne 0 -or [NegativeHeld]::WaitForSingleObject($owner,20000) -ne 0){throw 'Negative owned exits did not settle'}
 $code=[uint32]0;$sourcecode=[uint32]0
 if(-not [NegativeHeld]::GetExitCodeProcess($guardian,[ref]$code) -or -not [NegativeHeld]::GetExitCodeProcess($owner,[ref]$sourcecode)){throw 'Exact negative native statuses unavailable'}
 if(($Mode -eq 'guardian' -and ($code -ne 77 -or $sourcecode -ne 0)) -or ($Mode -eq 'parent' -and ($code -ne 1 -or $sourcecode -ne 91))){throw 'Controlled fault/ordinary observer statuses differ'}
 $recovery=Join-Path $PSScriptRoot 'source-offline-recover.ts'
 $result=& $Bun $recovery $row.control $Helper 2> (Join-Path $Root 'recovery-stderr.log')
 if($LASTEXITCODE -ne 0 -or -not ($result|ConvertFrom-Json).recovered){throw 'Fresh-process negative recovery refused'}
 $repeated=& $Bun $recovery $row.control $Helper 2> (Join-Path $Root 'repeat-stderr.log')
 if($LASTEXITCODE -ne 0 -or -not ($repeated|ConvertFrom-Json).recovered){throw 'Repeated negative recovery refused'}
 if(-not $original -or (Get-Acl -LiteralPath $row.home).Sddl -ne $row.originalAcl){throw 'Negative exact parent ACL not restored'}
 foreach($file in @($row.first,$row.config,$row.second)){if(Test-Path -LiteralPath $file){throw 'Declared negative source appeared'}}
 if((Get-FileHash -LiteralPath (Join-Path $row.home 'unrelated.bin')).Hash.ToLowerInvariant() -ne $row.siblingDigest){throw 'Excluded sibling bytes changed'}
 [IO.Directory]::CreateDirectory($row.config)|Out-Null
 [IO.Directory]::Delete($row.config)
 foreach($id in @($row.sourcePID,$row.guardianPID,$row.relayPID)){if(Get-Process -Id $id -ErrorAction SilentlyContinue){throw 'Negative owned PID remains'}}
 [pscustomobject]@{mode=$Mode;sourcePID=$row.sourcePID;guardianPID=$row.guardianPID;relayPID=$row.relayPID;sourceCode=$sourcecode;guardianCode=$code;nativeBirthsHeld=$true;exactAclRestored=$true;negativePathsAbsent=$true;siblingUnchanged=$true;journalParentCount=$parents;journalNodes=$count;journalOnlyDirectories=$true;emptyStages=$row.emptyStages;zeroCapturedFiles=$row.zeroCapturedFiles;freshRecovery=$true;repeatedRecovery=$true;ownedPidsAbsent=$true;watchdogForced=$false;captureSuccessful=$false;portableCaptureAuthorized=$false}|ConvertTo-Json -Depth 5
} finally {
 if($owner -ne [IntPtr]::Zero){[NegativeHeld]::CloseHandle($owner)|Out-Null}
 if($guardian -ne [IntPtr]::Zero){[NegativeHeld]::CloseHandle($guardian)|Out-Null}
 if(-not $source.HasExited){$source.Kill();$source.WaitForExit()}
}
