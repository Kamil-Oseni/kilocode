import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { NativeProcess } from "../../src/kilocode/process-host"

const suite = process.platform === "win32" ? describe : describe.skip

async function fixture(body: (dir: string, file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-receipt-"))
  const file = path.join(dir, "receipt")
  try {
    await body(dir, file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

suite("native exact file receipts", () => {
  test("refuses a stale prepared resume before creating a native target", () =>
    fixture(async (dir, file) => {
      const controller = await NativeProcess.inspect(process.pid)
      if (
        !controller ||
        typeof controller !== "object" ||
        !("birth" in controller) ||
        typeof controller.birth !== "string"
      )
        throw new Error("Native test controller has no identity")
      const output = path.join(dir, "unexpected")
      await writeFile(`${file}.go.tmp`, "stale publication")
      const spec = await NativeProcess.prepare({
        command: process.execPath,
        args: ["-e", `require('fs').writeFileSync(${JSON.stringify(output)}, 'unexpected')`],
        cwd: dir,
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
        controller: process.pid,
        birth: controller.birth,
        control: file,
        token: randomUUID(),
      })
      const child = spawn(spec.command, spec.args, {
        cwd: dir,
        env: spec.env,
        windowsHide: true,
        timeout: 10_000,
        stdio: ["ignore", "ignore", "pipe"],
      })
      const errors: Buffer[] = []
      child.stderr.on("data", (data: Buffer) => {
        if (errors.length < 4) errors.push(data.subarray(0, 1024))
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      expect(code).not.toBe(0)
      expect(Buffer.concat(errors).toString("utf8")).toContain("Native launch identity already used")
      expect(await readFile(`${file}.go.tmp`, "utf8")).toBe("stale publication")
      expect(await Bun.file(`${file}.job`).exists()).toBe(false)
      expect(await Bun.file(`${file}.launch`).exists()).toBe(false)
      expect(await Bun.file(output).exists()).toBe(false)
    }))
  test("refuses publication names that cannot round-trip through Windows paths", () =>
    fixture(async (dir, file) => {
      await writeFile(file, "journal")
      const saved = (await NativeProcess.receipt(file))!
      for (const name of ["published.", "published ", "NUL.json", "COM¹.json", "invalid?.json", "control\u0001.json"])
        await expect(NativeProcess.move(file, saved, path.join(dir, name))).rejects.toThrow()
      expect(await NativeProcess.receipt(file)).toEqual(saved)
    }))
  test("publishes the exact source without replacing existing metadata", () =>
    fixture(async (dir, file) => {
      await writeFile(file, "journal")
      const saved = (await NativeProcess.receipt(file))!
      const target = path.join(dir, "published")
      await writeFile(target, "existing")
      await expect(NativeProcess.move(file, saved, target)).rejects.toThrow()
      expect(await readFile(target, "utf8")).toBe("existing")
      expect(await readFile(file, "utf8")).toBe("journal")
      await rm(target)
      await NativeProcess.move(file, saved, target)
      expect(await NativeProcess.receipt(file)).toBeUndefined()
      expect(await NativeProcess.receipt(target)).toEqual(saved)
      await expect(NativeProcess.move(file, saved, target)).rejects.toThrow()
      expect(await readFile(target, "utf8")).toBe("journal")
    }))
  for (const data of [Buffer.alloc(0), Buffer.from("private synthetic receipt\0é"), Buffer.alloc(131_072, 127)]) {
    test(`snapshots and removes ${data.length} exact bytes without disclosing them in a failure`, () =>
      fixture(async (_, file) => {
        await writeFile(file, data)
        const saved = await NativeProcess.receipt(file)
        expect(saved).toBeDefined()
        expect(Object.isFrozen(saved)).toBe(true)
        expect(saved!.digest).toBe(createHash("sha256").update(data).digest("hex"))
        expect(Buffer.from(saved!.data, "base64")).toEqual(data)
        await NativeProcess.remove(file, saved!)
        expect(await NativeProcess.receipt(file)).toBeUndefined()
        await NativeProcess.remove(file, saved!)
        expect(await NativeProcess.receipt(file)).toBeUndefined()
      }))
  }

  test("refuses a same-content replacement and leaves both files intact", () =>
    fixture(async (dir, file) => {
      await writeFile(file, "same bytes")
      const saved = (await NativeProcess.receipt(file))!
      const old = path.join(dir, "original")
      await rename(file, old)
      await writeFile(file, "same bytes")
      await expect(NativeProcess.remove(file, saved)).rejects.toThrow()
      await expect(NativeProcess.move(file, saved, path.join(dir, "published"))).rejects.toThrow()
      expect(await readFile(old, "utf8")).toBe("same bytes")
      expect(await readFile(file, "utf8")).toBe("same bytes")
    }))

  test("refuses changed contents on the same file identity", () =>
    fixture(async (_, file) => {
      await writeFile(file, "before")
      const saved = (await NativeProcess.receipt(file))!
      await writeFile(file, "after")
      const next = (await NativeProcess.receipt(file))!
      expect(next.index).toBe(saved.index)
      await expect(NativeProcess.remove(file, saved)).rejects.toThrow()
      await expect(NativeProcess.move(file, saved, `${file}.published`)).rejects.toThrow()
      expect(await readFile(file, "utf8")).toBe("after")
    }))

  test("refuses oversized files, directories and hard links", () =>
    fixture(async (dir, file) => {
      await writeFile(file, Buffer.alloc(131_073))
      await expect(NativeProcess.receipt(file)).rejects.toThrow()
      await expect(NativeProcess.receipt(dir)).rejects.toThrow()
      await writeFile(file, "linked")
      await link(file, path.join(dir, "linked"))
      await expect(NativeProcess.receipt(file)).rejects.toThrow()
      expect(await readFile(file, "utf8")).toBe("linked")
    }))

  test("refuses leaf and parent junctions without touching their targets", () =>
    fixture(async (dir, file) => {
      const target = path.join(dir, "target")
      await mkdir(target)
      await writeFile(path.join(target, "receipt"), "untouched")
      await symlink(target, file, "junction")
      const real = path.join(dir, "real")
      const alias = path.join(dir, "alias")
      await mkdir(real)
      await writeFile(path.join(real, "receipt"), "untouched")
      await symlink(real, alias, "junction")
      try {
        await expect(NativeProcess.receipt(file)).rejects.toThrow()
        await expect(NativeProcess.receipt(path.join(alias, "receipt"))).rejects.toThrow()
        expect(await readFile(path.join(target, "receipt"), "utf8")).toBe("untouched")
        expect(await readFile(path.join(real, "receipt"), "utf8")).toBe("untouched")
      } finally {
        await unlink(file)
        await unlink(alias)
      }
    }))

  test("refuses forged snapshot metadata before changing the file", () =>
    fixture(async (_, file) => {
      await writeFile(file, "untouched")
      const saved = (await NativeProcess.receipt(file))!
      for (const change of [
        { version: 2 },
        { digest: "0".repeat(64) },
        { data: saved.data + "!" },
        { index: "0" },
        { volume: "4294967296" },
      ]) {
        await expect(NativeProcess.remove(file, { ...saved, ...change } as typeof saved)).rejects.toThrow()
        expect(await readFile(file, "utf8")).toBe("untouched")
      }
    }))

  test("delete-sharing refusal preserves the receipt and can recover after the exact lock exits", () =>
    fixture(async (dir, file) => {
      await writeFile(file, "locked")
      const saved = (await NativeProcess.receipt(file))!
      const witness = path.join(dir, "ready")
      const script = path.join(dir, "lock.ps1")
      const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
      await writeFile(
        script,
        `$file=[IO.File]::Open(${literal(file)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {[IO.File]::WriteAllText(${literal(witness)},[string]$PID); while($true){Start-Sleep -Milliseconds 25}} finally {$file.Dispose()}`,
      )
      const child = spawn("powershell.exe", ["-NoProfile", "-File", script], { windowsHide: true, stdio: "ignore" })
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
      try {
        if (child.pid === undefined) throw new Error("Receipt lock fixture has no process identity")
        const until = performance.now() + 10_000
        while (!(await Bun.file(witness).exists())) {
          if (performance.now() >= until || child.exitCode !== null)
            throw new Error("Receipt lock fixture did not start")
          await Bun.sleep(10)
        }
        expect(Number(await readFile(witness, "utf8"))).toBe(child.pid)
        await expect(NativeProcess.remove(file, saved)).rejects.toThrow()
        expect(await readFile(file, "utf8")).toBe("locked")
      } finally {
        child.kill()
        await closed
      }
      await NativeProcess.remove(file, saved)
      expect(await NativeProcess.receipt(file)).toBeUndefined()
    }))
})
