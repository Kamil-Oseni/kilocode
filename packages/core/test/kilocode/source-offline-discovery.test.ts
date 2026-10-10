import assert from "node:assert/strict"
import * as processes from "node:child_process"
import { createHash } from "node:crypto"
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, spyOn, test } from "bun:test"
import { assertImage, discover, recoverPending } from "../../src/kilocode/source-offline"

test.skipIf(process.platform !== "win32")(
  "actual native registry discovery is bounded read-only metadata, never recovery authority",
  async () => {
    assert(process.env.RAYA_OFFLINE_TEST_HELPER, "Require the explicitly compiled discovery-capable private helper")
    const executable = await realpath(process.env.RAYA_OFFLINE_TEST_HELPER)
    const pin = {
      executable,
      digest: createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
    }
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-offline-discovery-")))
    const events: {
      pid?: number
      exit?: number | null
      signal?: NodeJS.Signals | null
      closed: boolean
      stdout: { bytes: number; eof: boolean; sha256?: string }
      stderr: { bytes: number; eof: boolean; sha256?: string }
    }[] = []
    const original = processes.spawn
    const state = { passed: false, step: "missing" }
    const delegate = new Proxy(original, {
      apply(target, context, args) {
        const child: processes.ChildProcess = Reflect.apply(target, context, args)
        const values: unknown = args[1]
        if (!Array.isArray(values) || values[0] !== "profile-offline") return child
        const row: (typeof events)[number] = {
          pid: child.pid,
          closed: false,
          stdout: { bytes: 0, eof: false },
          stderr: { bytes: 0, eof: false },
        }
        events.push(row)
        for (const name of ["stdout", "stderr"] as const) {
          const stream = child[name]
          assert(stream, "Discovery owns both original output streams")
          const digest = createHash("sha256")
          stream.on("data", (bytes: Buffer) => {
            digest.update(bytes)
            row[name].bytes += bytes.length
          })
          stream.once("end", () => {
            row[name].eof = true
            row[name].sha256 = digest.digest("hex")
          })
        }
        child.once("exit", (code, signal) => {
          row.exit = code
          row.signal = signal
        })
        child.once("close", () => {
          row.closed = true
        })
        return child
      },
    })
    const observer = spyOn(processes, "spawn").mockImplementation(delegate)
    try {
      const missing = path.join(root, "absent", "nested", "registry")
      const empty = path.join(root, "empty")
      await mkdir(empty)
      const before = await lstat(empty, { bigint: true })
      const rows = await discover([missing, empty], pin)
      expect(rows.map(({ ancestor: _, ...row }) => row)).toEqual([
        { input: missing, path: missing, exists: false },
        { input: empty, path: empty, exists: true, entries: 0 },
      ])
      expect(Object.isFrozen(rows)).toBe(true)
      expect(rows.every(Object.isFrozen)).toBe(true)
      expect(rows[0].ancestor.path).toBe(root)
      expect(rows[1].ancestor.path).toBe(empty)
      for (const row of rows) {
        expect(row.ancestor.volume).toBeGreaterThanOrEqual(0)
        expect(row.ancestor.volume).toBeLessThanOrEqual(4294967295)
        expect(row.ancestor.index).toMatch(/^\d{1,20}$/)
        expect(BigInt(row.ancestor.index)).toBeLessThanOrEqual(18446744073709551615n)
      }
      await writeFile(path.join(root, "unrelated-sibling"), "owned sibling")
      const repeated = await discover([missing, empty], pin)
      expect(repeated.map((row) => row.ancestor)).toEqual(rows.map((row) => row.ancestor))
      expect(
        await access(path.dirname(missing)).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      const after = await lstat(empty, { bigint: true })
      expect([after.dev, after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
        before.dev,
        before.ino,
        before.mtimeNs,
        before.ctimeNs,
      ])
      expect(() => assertImage(rows, [{ kind: "json", path: empty }])).toThrow("expired or bound")

      state.step = "entry bounds"
      const populated = path.join(root, "populated")
      await mkdir(populated)
      for (let index = 0; index < 1024; index++) await writeFile(path.join(populated, String(index)), "owned marker")
      expect((await discover([populated], pin)).map(({ ancestor: _, ...row }) => row)).toEqual([
        { input: populated, path: populated, exists: true, entries: 1024 },
      ])
      await writeFile(path.join(populated, "overflow"), "owned marker")
      await assert.rejects(discover([populated], pin), /native refusal/)

      state.step = "unknown entry cannot authorize recovery"
      const unknown = path.join(root, "unknown")
      await mkdir(path.join(unknown, "unrecognized"), { recursive: true })
      expect((await discover([unknown], pin))[0].entries).toBe(1)
      await assert.rejects(recoverPending(unknown, pin), /unknown entry/)

      state.step = "occupied and junction"
      const occupied = path.join(root, "occupied")
      await writeFile(occupied, "unchanged private marker")
      await assert.rejects(discover([occupied], pin), /native refusal/)
      expect(await readFile(occupied, "utf8")).toBe("unchanged private marker")
      const junction = path.join(root, "junction")
      await symlink(empty, junction, "junction")
      expect((await lstat(junction)).isSymbolicLink()).toBe(true)
      expect(await realpath(junction)).toBe(empty)
      await assert.rejects(discover([junction], pin), /native refusal/)
      await assert.rejects(discover([path.join(junction, "absent")], pin), /native refusal/)

      state.step = "invalid input and selected pin"
      const count = events.length
      for (const inputs of [[], [empty, empty], [empty, missing, occupied], ["relative"], [`${empty}\n`]])
        await assert.rejects(discover(inputs, pin))
      expect(events.length).toBe(count)
      await assert.rejects(discover([empty], { executable, digest: "0".repeat(64) }), /pin changed/)
      expect(events.length).toBe(count)

      state.step = "original lifecycle"
      expect(events.length).toBeGreaterThanOrEqual(8)
      for (const row of events) {
        expect(row.pid).toBeGreaterThan(0)
        expect(row.closed).toBe(true)
        expect(row.signal).toBeNull()
        expect(row.exit === 0 || row.exit === 1).toBe(true)
        expect(row.stdout.eof).toBe(true)
        expect(row.stderr.eof).toBe(true)
        expect(row.stdout.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(row.stderr.sha256).toMatch(/^[a-f0-9]{64}$/)
      }
      state.passed = true
    } finally {
      observer.mockRestore()
      if (!state.passed)
        await writeFile(path.join(root, "failure.json"), JSON.stringify({ step: state.step, events }, null, 2))
      if (state.passed) await rm(root, { recursive: true })
    }
  },
  60_000,
)
