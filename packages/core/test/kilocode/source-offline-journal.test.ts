import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { assertImage, recoverPending, withImage } from "../../src/kilocode/source-offline"
import { NativeProcess } from "../../src/kilocode/process-host"

const executable = process.env.RAYA_OFFLINE_TEST_HELPER
const digest = process.env.RAYA_OFFLINE_TEST_DIGEST
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const observed = z.object({ denied: z.number().int(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const retired = z
  .object({
    denied: z.number().int(),
    first: z.string().regex(/^[a-f0-9]{64}$/),
    last: z.string().regex(/^[a-f0-9]{64}$/),
    current: z.string().regex(/^[a-f0-9]{64}$/),
    restored: z.boolean(),
  })
  .strict()

test.skipIf(process.platform !== "win32")(
  "actual Offline journal refuses incompatible readers and preserves compatible old generations through admissions and rollback",
  async () => {
    if (!!executable !== !!digest) throw new Error("Explicit journal helper pin requires both fields")
    const file = await realpath(executable ?? (await NativeProcess.source()))
    const helper = { executable: file, digest: digest ?? hash(await readFile(file)) }
    expect(hash(await readFile(helper.executable))).toBe(helper.digest)
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-offline-journal-")))
    const source = path.join(root, "source")
    const registry = path.join(root, "registry")
    const control = path.join(registry, "capture-reader")
    const evidence = path.join(root, "evidence")
    await Promise.all([mkdir(source), mkdir(control, { recursive: true }), mkdir(evidence)])
    const bytes = Buffer.alloc(256 * 1024, 71)
    for (let index = 0; index < 96; index++) await writeFile(path.join(source, `${index}.bin`), bytes)
    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(import.meta.dir, "fixtures/source-offline-journal-reader.ps1"),
        "-Control",
        control,
        "-Evidence",
        evidence,
        "-Source",
        source,
      ],
      { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const deadline = Date.now() + 90000
    const ready = async () => {
      while (Date.now() < deadline) {
        const value = await readFile(path.join(evidence, "ready.json"), "utf8").catch((err: unknown) => {
          if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
          throw err
        })
        if (value) return observed.parse(JSON.parse(value.replace(/^\uFEFF/, "")))
        if (child.exitCode !== null && child.exitCode !== undefined)
          throw new Error("Journal observer exited before readiness")
        await Bun.sleep(10)
      }
      throw new Error("Journal observer readiness deadline exceeded")
    }
    try {
      while (!(await Bun.file(path.join(evidence, "started")).exists())) {
        if (Date.now() >= deadline) throw new Error("Journal observer startup deadline exceeded")
        if (child.exitCode !== null && child.exitCode !== undefined)
          throw new Error("Journal observer exited before startup")
        await Bun.sleep(10)
      }
      await withImage(
        {
          roots: [{ kind: "json", path: source }],
          policy: { version: 1, directories: [source], files: [] },
          helper,
          registry,
          control,
          inventory: "directories",
        },
        async (image) => {
          expect(assertImage(image, [{ kind: "json", path: source }]).control).toBe(control)
          const first = await ready()
          expect(first.denied).toBe(32)
          const current = hash(await readFile(path.join(control, "journal.bin")))
          expect(current).not.toBe(first.digest)
          await writeFile(
            path.join(evidence, "held.json"),
            JSON.stringify({
              first: first.digest,
              current,
              admissionsObserved: true,
              files: assertImage(image, [{ kind: "json", path: source }]).files.length,
              portableCaptureAuthorized: false,
            }),
          )
          expect(hash(await readFile(path.join(source, "0.bin")))).toBe(hash(bytes))
        },
      )
    } finally {
      await writeFile(path.join(evidence, "finish"), "complete")
      const [code, out, err] = await Promise.all([child.exited, stdout, stderr])
      await writeFile(
        path.join(evidence, "observer.json"),
        JSON.stringify({ code, pid: child.pid, stdout: out, stderr: err, portableCaptureAuthorized: false }),
      )
      expect(code).toBe(0)
    }
    const receipt = retired.parse(
      JSON.parse((await readFile(path.join(evidence, "receipt.json"), "utf8")).replace(/^\uFEFF/, "")),
    )
    expect(receipt.denied).toBe(32)
    expect(receipt.last).toBe(receipt.first)
    expect(receipt.current).not.toBe(receipt.first)
    expect(receipt.restored).toBe(true)
    await writeFile(path.join(source, "after.bin"), bytes)
    await recoverPending(registry, helper)
    await recoverPending(registry, helper)
    expect(hash(await readFile(path.join(source, "0.bin")))).toBe(hash(bytes))
  },
  120000,
)
