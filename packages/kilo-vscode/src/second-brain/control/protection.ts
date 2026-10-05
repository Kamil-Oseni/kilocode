import { command as execute } from "./command"
import { check } from "./frames"
import { directory, powershell, environment } from "./identity"
const script =
  "$ErrorActionPreference='Stop'\nSet-StrictMode -Version Latest\n$dir=[IO.Path]::GetFullPath('__ROOT__')\n$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\\','/')+[IO.Path]::DirectorySeparatorChar\nif(!$dir.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or !(Split-Path $dir -Leaf).StartsWith('raya-memory-control-')){throw 'Owned temporary root required'}\n$item=Get-Item -LiteralPath $dir -Force\nif(!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or @(Get-ChildItem -LiteralPath $dir -Force).Count){throw 'Empty regular root required'}\n$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User\n$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544')\n$flags=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'\n$acl=[Security.AccessControl.DirectorySecurity]::new()\n$acl.SetOwner($sid);$acl.SetGroup($sid);$acl.SetAccessRuleProtection($true,$false)\nforeach($value in $allowed){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value),[Security.AccessControl.FileSystemRights]::FullControl,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}\nSet-Acl -LiteralPath $dir -AclObject $acl\n$actual=Get-Acl -LiteralPath $dir\n$rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))\nif(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value -or $rules.Count -ne 3 -or @($rules.IdentityReference.Value|Select-Object -Unique).Count -ne 3){throw 'Protection differs'}\nforeach($rule in $rules){if($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $flags -or $rule.PropagationFlags -ne 'None' -or $rule.IsInherited){throw 'Effective rights differ'}}\n[ordered]@{protected=$true;aclSHA=([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($actual.Sddl)))).Replace('-','').ToLowerInvariant();identities=3}|ConvertTo-Json -Compress\n"

export async function protect(root: string) {
  await directory(root)
  const command = script.replace("__ROOT__", root.replace(/'/g, "''"))
  const output = await execute(
    powershell(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    { windowsHide: true, env: environment() },
  )
  const value = JSON.parse(output.stdout) as { protected: boolean; aclSHA: string; identities: number }
  check(
    value.protected === true && value.identities === 3 && /^[a-f0-9]{64}$/.test(value.aclSHA),
    "Protected root refused",
  )
  return value
}
