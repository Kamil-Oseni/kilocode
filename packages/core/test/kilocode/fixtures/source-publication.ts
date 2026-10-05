import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { launch } from "../../../src/kilocode/source-launch"

const root = process.env.RAYA_SOURCE_PUBLICATION_TEST_ROOT!
const profile = path.join(root, "profile")
await mkdir(profile)
const source = path.join(root, "source.ts")
await Bun.write(
  source,
  `const root=process.env.RAYA_SOURCE_PUBLICATION_TEST_ROOT!; await Bun.write(root+"/source-ready","ready");while(!(await Bun.file(root+"/source-release").exists()))await Bun.sleep(10);`,
)
const executable = await realpath(process.execPath)
const digest = createHash("sha256")
  .update(new Uint8Array(await Bun.file(executable).arrayBuffer()))
  .digest("hex")
const session = await launch({
  executable,
  digest,
  cwd: root,
  args: [source],
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  roots: [{ kind: "json", path: profile }],
})
const output = [session.child.stdout, session.child.stderr].map(async (stream) => {
  if (!stream) throw new Error("Piped output required")
  const chunks: Buffer[] = []
  for await (const value of stream) {
    if (!Buffer.isBuffer(value)) throw new Error("Bad output")
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString()
})
const wait = async (file: string) => {
  const deadline = Date.now() + 15000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > deadline) throw new Error(`Missing ${file}`)
    await Bun.sleep(10)
  }
}
const packet = (...values: (string | number)[]) =>
  Buffer.concat(
    values.map((value) => {
      const size = Buffer.alloc(4)
      if (typeof value === "number") {
        size.writeUInt32LE(value)
        return size
      }
      size.writeUInt32LE(value.length)
      return Buffer.concat([size, Buffer.from(value, "utf16le")])
    }),
  )
const file = path.join(root, "capture.tmp")
await Bun.write(file, packet(1, session.ticket.token, 2, session.ticket.header.pid, session.ticket.header.birth))
const script = path.join(root, "publication.ps1")
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
await Bun.write(
  script,
  `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class Publication {
[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern IntPtr CreateFile(string n,uint a,uint s,IntPtr d,uint c,uint f,IntPtr t);
[DllImport("kernel32.dll",SetLastError=true)]public static extern bool SetFileInformationByHandle(IntPtr h,int c,IntPtr b,uint n);
[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);
}
'@
$handle=[Publication]::CreateFile(${quote(file)},2147549184,1,[IntPtr]::Zero,3,0x200000,[IntPtr]::Zero)
if($handle -eq [IntPtr]::new(-1)){throw ('Publication open failed '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
$target=[Text.Encoding]::Unicode.GetBytes(${quote(`${session.ticket.control}.source-capture`)})
$buffer=[Runtime.InteropServices.Marshal]::AllocHGlobal(20+$target.Length)
try {
 [Runtime.InteropServices.Marshal]::WriteInt32($buffer,0,0)
 [Runtime.InteropServices.Marshal]::WriteIntPtr($buffer,8,[IntPtr]::Zero)
 [Runtime.InteropServices.Marshal]::WriteInt32($buffer,16,$target.Length)
 [Runtime.InteropServices.Marshal]::Copy($target,0,[IntPtr]::Add($buffer,20),$target.Length)
 if(-not [Publication]::SetFileInformationByHandle($handle,3,$buffer,20+$target.Length)){throw ('Publication rename failed '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
 [IO.File]::WriteAllText(${quote(path.join(root, "publication-held"))},'held')
 $deadline=[DateTime]::UtcNow.AddSeconds(15)
 while(-not [IO.File]::Exists(${quote(path.join(root, "publication-release"))})){if([DateTime]::UtcNow -gt $deadline){throw 'Publication release deadline'};Start-Sleep -Milliseconds 10}
}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($buffer);if(-not [Publication]::CloseHandle($handle)){throw 'Publication close failed'}}
`,
)
await session.start()
await wait(path.join(root, "source-ready"))
const child = Bun.spawn(
  [
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
  ],
  { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: process.env },
)
const logs = [new Response(child.stdout).text(), new Response(child.stderr).text()]
const errors: unknown[] = []
try {
  await wait(path.join(root, "publication-held"))
  await Bun.sleep(150)
  assert.equal(await Bun.file(`${session.ticket.control}.source-capture-ready`).exists(), false)
  assert.equal(await Bun.file(`${session.ticket.control}.source-capture.refused`).exists(), false)
  await Bun.write(path.join(root, "publication-release"), "release")
  assert.equal(await child.exited, 0)
  await wait(`${session.ticket.control}.source-capture-ready`)
  const ready = await Bun.file(`${session.ticket.control}.source-capture-ready`).json()
  assert.equal(ready.token, session.ticket.token)
  await Bun.write(path.join(root, "source-release"), "release")
  assert.equal((await session.retired()).familyZeroObserved, true)
} catch (err) {
  errors.push(err)
} finally {
  await Bun.write(path.join(root, "publication-release"), "release")
  await Bun.write(path.join(root, "source-release"), "release")
  const [stdout, stderr] = await Promise.all(logs)
  await Bun.write(path.join(root, "publisher.stdout.log"), stdout)
  await Bun.write(path.join(root, "publisher.stderr.log"), stderr)
  await child.exited
  const [sourceout, sourceerr] = await Promise.all(output)
  await Bun.write(path.join(root, "source.stdout.log"), sourceout)
  await Bun.write(path.join(root, "source.stderr.log"), sourceerr)
  await session.exit
  await Bun.write(
    path.join(root, "receipt.json"),
    JSON.stringify({
      passed: !errors.length,
      errors: errors.map(String),
      heldPublicationJoined: !errors.length,
      forced: false,
      ticket: session.ticket,
      portableCaptureAuthorized: false,
    }),
  )
}
if (errors.length) throw new AggregateError(errors, "Retained native publication failure")
