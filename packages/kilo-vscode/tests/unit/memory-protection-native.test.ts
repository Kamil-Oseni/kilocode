import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { protect } from "../../src/second-brain/control/protection"
import { directory, environment, image, powershell } from "../../src/second-brain/control/identity"
import * as commands from "../../src/second-brain/control/command"
import { interpreter } from "../../src/second-brain/managed/catalog"
import { protection as previous } from "../../src/second-brain/managed/protection"
import { protection } from "../../src/second-brain/managed/protection-native"

const native = process.platform === "win32" ? test : test.skip
// Owned fixture restoration requests WRITE_DAC alone after a rights downgrade.
// OWNER is restored only for the owner fixture, which retains its full allow ACE.
const reset = `import ctypes,pathlib,sys,tempfile
from ctypes import wintypes as w
root=pathlib.Path(sys.argv[1]);sid=sys.argv[2];owner=sys.argv[3]=='1';inherited=len(sys.argv)>4 and sys.argv[4]=='inherited'
assert root.is_absolute() and root.resolve()==root and root.name.startswith('raya-memory-control-') and root.is_relative_to(pathlib.Path(tempfile.gettempdir()))
native=ctypes.WinDLL('advapi32',use_last_error=True);kernel=ctypes.WinDLL('kernel32',use_last_error=True);pointer=w.LPVOID
native.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes=[w.LPCWSTR,w.DWORD,ctypes.POINTER(pointer),ctypes.POINTER(w.DWORD)];native.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype=w.BOOL
native.GetSecurityDescriptorDacl.argtypes=[pointer,ctypes.POINTER(w.BOOL),ctypes.POINTER(pointer),ctypes.POINTER(w.BOOL)];native.GetSecurityDescriptorDacl.restype=w.BOOL
native.GetSecurityDescriptorOwner.argtypes=[pointer,ctypes.POINTER(pointer),ctypes.POINTER(w.BOOL)];native.GetSecurityDescriptorOwner.restype=w.BOOL
native.SetNamedSecurityInfoW.argtypes=[w.LPWSTR,ctypes.c_int,w.DWORD,pointer,pointer,pointer,pointer];native.SetNamedSecurityInfoW.restype=w.DWORD
native.SetFileSecurityW.argtypes=[w.LPCWSTR,w.DWORD,pointer];native.SetFileSecurityW.restype=w.BOOL
kernel.LocalFree.argtypes=[pointer];kernel.LocalFree.restype=pointer
descriptor=pointer();sddl='O:'+sid+'D:P'+''.join('(A;'+('OICIID' if inherited and value==sid else 'OICI')+';FA;;;'+value+')' for value in (sid,'S-1-5-18','S-1-5-32-544'))
assert native.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,ctypes.byref(descriptor),None)
try:
 dacl,principal=pointer(),pointer();present,default=w.BOOL(),w.BOOL()
 assert native.GetSecurityDescriptorDacl(descriptor,ctypes.byref(present),ctypes.byref(dacl),ctypes.byref(default)) and present and dacl
 assert native.GetSecurityDescriptorOwner(descriptor,ctypes.byref(principal),ctypes.byref(default)) and principal
 if inherited:
  # Documented low-level setter avoids SetNamed automatic inheritance conversion.
  # Root was protected before this DACL-only operation; prove that again below.
  assert native.SetFileSecurityW(str(root),4,descriptor)
 else: assert native.SetNamedSecurityInfoW(str(root),1,0x80000004|(1 if owner else 0),principal if owner else None,None,dacl,None)==0
finally: assert not kernel.LocalFree(descriptor)
if inherited:
 native.GetNamedSecurityInfoW.argtypes=[w.LPWSTR,ctypes.c_int,w.DWORD]+[ctypes.POINTER(pointer)]*5;native.GetNamedSecurityInfoW.restype=w.DWORD
 native.GetAclInformation.argtypes=[pointer,pointer,w.DWORD,ctypes.c_int];native.GetAclInformation.restype=w.BOOL
 native.GetAce.argtypes=[pointer,w.DWORD,ctypes.POINTER(pointer)];native.GetAce.restype=w.BOOL
 native.GetSecurityDescriptorControl.argtypes=[pointer,ctypes.POINTER(w.WORD),ctypes.POINTER(w.DWORD)];native.GetSecurityDescriptorControl.restype=w.BOOL
 class Information(ctypes.Structure): _fields_=[('count',w.DWORD),('used',w.DWORD),('free',w.DWORD)]
 dacl,descriptor=pointer(),pointer();assert native.GetNamedSecurityInfoW(str(root),1,4,None,None,ctypes.byref(dacl),None,ctypes.byref(descriptor))==0
 try:
  control,revision=w.WORD(),w.DWORD();assert native.GetSecurityDescriptorControl(descriptor,ctypes.byref(control),ctypes.byref(revision)) and control.value&0x1000
  info=Information();assert native.GetAclInformation(dacl,ctypes.byref(info),ctypes.sizeof(info),2) and info.count==3
  flags=[]
  for index in range(info.count):
   address=pointer();assert native.GetAce(dacl,index,ctypes.byref(address));flags.append(w.BYTE.from_address(address.value+1).value)
  assert sorted(flags)==[3,3,19], 'Owned inherited fixture not established'
 finally: assert not kernel.LocalFree(descriptor)`
function diagnostic(err: unknown): unknown {
  if (!(err instanceof Error)) return "unknown"
  const output = "output" in err && typeof err.output === "object" && err.output !== null ? err.output : undefined
  return {
    name: err.name,
    message: err.message.slice(0, 8192),
    ...(err instanceof AggregateError ? { errors: err.errors.slice(0, 16).map(diagnostic) } : {}),
    ...("receipt" in err ? { receipt: err.receipt } : {}),
    ...(output && "stderr" in output && typeof output.stderr === "string"
      ? { stderr: output.stderr.slice(0, 8192) }
      : {}),
  }
}
const mutations = {
  missing:
    "$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -eq 'S-1-5-18'});if($rules.Count -ne 1){throw 'Owned SYSTEM rule differs'};$acl.RemoveAccessRuleSpecific($rules[0])",
  extra:
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))",
  deny: "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','ContainerInherit,ObjectInherit','None','Deny'))",
  rights:
    "$acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))",
  propagation:
    "$acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','InheritOnly','Allow'))",
  unprotected: "$acl.SetAccessRuleProtection($false,$true)",
  inherited:
    "$acl.SetSecurityDescriptorSddlForm('D:P(A;OICIID;FA;;;'+$sid.Value+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)',[Security.AccessControl.AccessControlSections]::Access)",
}
// Original owner-only mutation failed honestly: Administrators is deny-only in
// this token, so Windows refuses assigning it as owner (retained original42724).
// The separate read-only test below is not isolated owner-only equivalence.

native(
  "owned strict protection cases, interpreter CAS and joins (isolated foreign owner mutation unavailable)",
  async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "raya-native-protection-"))
    const file = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
    const selected = await image(file, 536870912)
    expect(selected.digest).toBe(interpreter)
    const python = { path: file, bytes: selected.raw.length, sha256: selected.digest }
    const execute = commands.command
    const state = { replace: "" }
    const observed = spyOn(commands, "command").mockImplementation(async (...args) => {
      const result = await execute(...args)
      if (state.replace && args[0] === state.replace) {
        const replacement = state.replace + ".replacement"
        await copyFile(state.replace, replacement)
        await rename(replacement, state.replace)
      }
      return result
    })
    const witness: Record<string, unknown> = { passed: false }
    try {
      for (const [name, mutation] of [["valid", ""], ...Object.entries(mutations)]) {
        const root = path.join(parent, "raya-memory-control-" + name)
        witness.step = name
        await writeFile(path.join(parent, "progress.json"), JSON.stringify(witness))
        await mkdir(root)
        await protect(root)
        const sid = await previous(root)
        const failures: unknown[] = []
        try {
          if (name === "inherited") {
            // .NET normalizes ID away; write and re-read the actual Win32 ACE flag.
            await commands.command(python.path, ["-I", "-S", "-B", "-c", reset, root, sid, "0", "inherited"], {
              windowsHide: true,
              env: environment(),
            })
          }
          if (name !== "valid" && name !== "inherited") {
            // Direct .NET persistence writes only changed DACL/owner sections;
            // Get-Acl/Set-Acl provider round-tripping can request SACL privileges.
            const script = `$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$item=Get-Item -LiteralPath '${root.replace(/'/g, "''")}';$acl=$item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access);${mutation};$item.SetAccessControl($acl);$actual=Get-Acl -LiteralPath '${root.replace(/'/g, "''")}';if('${name}' -eq 'inherited' -and !@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object IsInherited).Count){throw 'Owned inherited fixture not established'};if('${name}' -eq 'owner' -and $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value){throw 'Owned foreign owner fixture not established'}`
            await commands.command(
              powershell(),
              ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
              { windowsHide: true, env: environment() },
            )
          }
          if (name !== "valid") {
            await expect(previous(root)).rejects.toThrow()
            await expect(protection(root, python)).rejects.toThrow()
          }
          if (name === "valid") {
            expect(await protection(root, python)).toBe(await previous(root))
            const count = observed.mock.calls.length
            await expect(protection(root, { ...python, sha256: "0".repeat(64) })).rejects.toThrow("interpreter differs")
            expect(observed.mock.calls.length).toBe(count)
          }
        } catch (err) {
          failures.push(err)
        }
        // The valid case has no ACL mutation and needs no second protection write.
        if (name !== "valid") {
          await commands
            .command(python.path, ["-I", "-S", "-B", "-c", reset, root, sid, name === "owner" ? "1" : "0"], {
              windowsHide: true,
              env: environment(),
            })
            .catch((err: unknown) => {
              failures.push(err)
            })
        }
        if (failures.length) throw new AggregateError(failures, "Owned protection body and cleanup failures retained")
      }
      const target = path.join(parent, "raya-memory-control-target")
      const junction = path.join(parent, "junction")
      await mkdir(target)
      await protect(target)
      await symlink(target, junction, "junction")
      await expect(previous(junction)).rejects.toThrow()
      await expect(protection(junction, python)).rejects.toThrow()
      // Actual same-byte executable replacement after its original child joined.
      // The mirror uses only the selected runtime's stdlib, never site/model imports.
      const mirror = path.join(parent, "interpreter")
      await mkdir(mirror)
      for (const name of ["python.exe", "python312.dll", "vcruntime140.dll", "vcruntime140_1.dll"])
        await copyFile(path.join(path.dirname(file), name), path.join(mirror, name))
      await writeFile(
        path.join(mirror, "python312._pth"),
        [path.join(path.dirname(file), "Lib"), path.join(path.dirname(file), "DLLs")].join("\n"),
      )
      const retained = { ...python, path: path.join(mirror, "python.exe") }
      expect(await protection(target, retained)).toBe(await previous(target))
      state.replace = retained.path
      await expect(protection(target, retained)).rejects.toThrow("interpreter changed")
      state.replace = ""
      const results = await Promise.allSettled(observed.mock.results.map((value) => value.value))
      for (const result of results) {
        const receipt =
          result.status === "fulfilled"
            ? result.value.receipt
            : result.reason instanceof Error && "receipt" in result.reason
              ? result.reason.receipt
              : undefined
        expect(receipt).toMatchObject({
          originalJoined: true,
          readersJoined: true,
          stdoutEOF: true,
          stderrEOF: true,
          forced: false,
          observationExpired: false,
        })
      }
      witness.commands = results.length
      witness.passed = true
      await writeFile(path.join(parent, "progress.json"), JSON.stringify(witness))
    } catch (err) {
      witness.failed = true
      await writeFile(
        path.join(parent, "failure.json"),
        JSON.stringify({
          witness,
          error: diagnostic(err),
          qualification: "Fixture prerequisites/refusals must qualify; no inferred equivalence after failure",
        }),
      )
      throw new Error("Owned native protection diagnostics retained: " + parent, { cause: err })
    } finally {
      observed.mockRestore()
      expect(path.dirname(parent)).toBe(path.resolve(tmpdir()))
      expect(path.basename(parent).startsWith("raya-native-protection-")).toBe(true)
      if (witness.passed === true && witness.failed !== true) await rm(parent, { recursive: true })
    }
  },
  60000,
)

native(
  "read-only foreign-owner SystemRoot is refused by both readers (different ACL; not isolated owner equivalence)",
  async () => {
    const root = process.env.SystemRoot
    if (!root || !path.isAbsolute(root))
      throw new Error("Actual ordinary SystemRoot required; foreign-owner fixture unavailable")
    await directory(root)
    const file = "D:/Raya/Services/Packaging/Python/3.12.14/python.exe"
    const selected = await image(file, 536870912)
    expect(selected.digest).toBe(interpreter)
    const python = { path: file, bytes: selected.raw.length, sha256: selected.digest }
    const script = `$ErrorActionPreference='Stop';$item=Get-Item -LiteralPath '${root.replace(/'/g, "''")}';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $item.FullName;[ordered]@{sid=$sid.Value;owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;directory=$item.PSIsContainer;reparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)}|ConvertTo-Json -Compress`
    const observed = spyOn(commands, "command")
    try {
      const output = await commands.command(
        powershell(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { windowsHide: true, env: environment() },
      )
      const value = JSON.parse(output.stdout) as { sid: string; owner: string; directory: boolean; reparse: boolean }
      expect(value.directory).toBe(true)
      expect(value.reparse).toBe(false)
      expect(value.sid).toMatch(/^S-1-(?:\d+-)+\d+$/)
      expect(value.owner).toMatch(/^S-1-(?:\d+-)+\d+$/)
      expect(value.owner).not.toBe(value.sid)
      await expect(previous(root)).rejects.toThrow()
      await expect(protection(root, python)).rejects.toThrow()
      const results = await Promise.allSettled(observed.mock.results.map((value) => value.value))
      for (const result of results) {
        const receipt =
          result.status === "fulfilled"
            ? result.value.receipt
            : result.reason instanceof Error && "receipt" in result.reason
              ? result.reason.receipt
              : undefined
        expect(receipt).toMatchObject({
          originalJoined: true,
          readersJoined: true,
          stdoutEOF: true,
          stderrEOF: true,
          forced: false,
          observationExpired: false,
        })
      }
    } finally {
      observed.mockRestore()
    }
  },
  15000,
)
