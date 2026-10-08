import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { NativeProcess } from "../../src/kilocode/process-host"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"

test.skipIf(process.platform !== "win32")(
  "actual native fences preserve descendant ACLs and restore exact legacy, AI, P and PAI descriptors",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-native-acl-")))
    const output = path.join(root, "raya-process-host.exe")
    const compiler = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(import.meta.dir, "fixtures/source-offline-acl.ps1"),
        "-Output",
        output,
      ],
      { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const [compiled, log, errors] = await Promise.all([
      compiler.exited,
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
    ])
    await writeFile(path.join(root, "compile.log"), log + errors)
    expect(compiled, `Private compiler log retained in ${root}`).toBe(0)
    const child = Bun.spawn([output, root], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await writeFile(path.join(root, "receipt.json"), JSON.stringify({ code, pid: child.pid, stdout, stderr }))
    expect(code, `Private native ACL receipt retained in ${root}`).toBe(0)
    expect(stderr).toBe("")
    expect(stdout.trim().split(/\r?\n/)).toEqual([
      "Offline exact ACL roundtrip legacy",
      "Offline exact ACL roundtrip AI",
      "Offline exact ACL roundtrip P",
      "Offline exact ACL roundtrip PAI",
    ])
    expect(() => process.kill(child.pid, 0)).toThrow()
    const deep = path.join(root, ...Array(9).fill("actual café 日本語 folder"))
    await mkdir(deep, { recursive: true })
    expect(deep.length).toBeGreaterThan(240)
    const alias = await NativeProcess.alias(deep, output)
    expect(await realpath(alias)).toBe(await realpath(deep))
    await assert.rejects(NativeProcess.alias(path.join(deep, "missing"), output))
  },
  60000,
)
