import { check } from "../control/frames"
import { powershell, environment } from "../control/identity"
import { command } from "../control/command"

export async function protection(root: string) {
  const script = `$ErrorActionPreference='Stop';$dir=Get-Item -LiteralPath '${root.replace(/'/g, "''")}';if(!$dir.PSIsContainer -or ($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Managed root differs'};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');$acl=Get-Acl -LiteralPath $dir.FullName;$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if(!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value -or $rules.Count -ne 3 -or @($rules.IdentityReference.Value|Select-Object -Unique).Count -ne 3){throw 'Managed ACL differs'};foreach($rule in $rules){if($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne 'None' -or $rule.IsInherited){throw 'Managed rights differ'}};[ordered]@{sid=$sid.Value;protected=$true}|ConvertTo-Json -Compress`
  const output = await command(
    powershell(),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, env: environment() },
  )
  const value = JSON.parse(output.stdout) as { sid: string; protected: boolean }
  check(value.protected === true, "Managed root protection refused")
  return value.sid
}
