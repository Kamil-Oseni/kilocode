import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import * as commands from "../../src/second-brain/control/command"
import * as projector from "../../src/second-brain/managed/upgrade"
import { BrainSettings, parse } from "../../src/second-brain/settings"
import { descriptor } from "../../src/second-brain/managed/descriptor"
import { materialize } from "../../src/second-brain/managed/materialize"
import { publish } from "../../src/second-brain/managed/upgrade-publish"
import { fresh, linked } from "../../src/second-brain/managed/capture-upgrade"
import { disposeHistory } from "../../src/second-brain/capture-revisions"

test.skipIf(process.platform !== "win32")(
  "actual two-upgrade capture freshness shares pure projection bytes while native validation remains fresh",
  async () => {
    const parent = path.resolve("../../.tmp/new-pc")
    await mkdir(parent, { recursive: true })
    const diagnostics = await mkdtemp(path.join(parent, "capture-projection-"))
    const witness: Record<string, unknown> = { passed: false, forced: false }
    const record = () => writeFile(path.join(diagnostics, "progress.json"), JSON.stringify(witness))
    const step = async <T>(name: string, body: () => Promise<T>) => {
      witness.step = name
      witness.phase = "awaiting-original"
      await record()
      const value = await body()
      witness.phase = "returned-original"
      await record()
      return value
    }
    const produced = await step("original producer joins", () =>
      commands.command(
        process.execPath,
        [path.resolve("tests/unit/fixtures/committed-capture-producer.ts"), "--runtime"],
        { cwd: process.cwd() },
      ),
    )
    witness.producer = produced.receipt
    const fixture = JSON.parse(produced.stdout) as { root: string; file: string; turn: unknown }
    witness.fixture = { root: fixture.root, file: fixture.file }
    const storage = {
      get<T>(key: string) {
        return JSON.parse(readFileSync(fixture.file, "utf8"))[key] as T | undefined
      },
      async update(key: string, value: unknown) {
        const data = JSON.parse(await readFile(fixture.file, "utf8")) as Record<string, unknown>
        if (value === undefined) delete data[key]
        if (value !== undefined) data[key] = value
        await writeFile(fixture.file, JSON.stringify(data))
      },
    }
    const settings = new BrainSettings(storage, {
      async get() {
        return "synthetic"
      },
      async store() {},
      async delete() {},
    })
    const entry = () => storage.get<{ managed: unknown; setup: unknown }>("raya.secondBrain.setup")!
    const tracked: object[] = []
    try {
      expect(produced.receipt).toMatchObject({
        code: 0,
        originalJoined: true,
        readersJoined: true,
        stdoutEOF: true,
        stderrEOF: true,
        forced: false,
      })
      const original = await step("original recovery", () =>
        settings.recoverCapture(process.cwd(), fixture.turn, async () => true),
      )
      expect(original).toBeDefined()
      if (!original) throw new Error("Original capture recovery required")
      tracked.push(original)
      for (const id of ["b".repeat(32), "c".repeat(32)]) {
        const before = entry()
        const next = await step("native materialization " + id, () =>
          materialize(descriptor(before.managed), parse(before.setup), process.cwd(), id),
        )
        await step("durable publication " + id, () => publish(storage, next.receipt))
      }
      const projections = spyOn(projector, "project")
      const native = spyOn(commands, "command")
      try {
        const reviewed = await step("original full current review", () =>
          settings.reviewCapture(process.cwd(), fixture.turn),
        )
        tracked.push(reviewed)
        expect(linked(reviewed)?.version).toBe(2)
        const count = projections.mock.calls.length
        expect(count).toBe(4)
        for (const name of ["first fresh", "second fresh"]) {
          const calls = native.mock.calls.length
          await step(name, () => fresh(reviewed, storage))
          expect(projections.mock.calls.length).toBe(count)
          expect(native.mock.calls.length).toBeGreaterThan(calls)
        }
        disposeHistory(reviewed)
        const calls = native.mock.calls.length
        await step("disposed pure scope recomputes", () => fresh(reviewed, storage))
        expect(projections.mock.calls.length).toBeGreaterThan(count)
        expect(native.mock.calls.length).toBeGreaterThan(calls)
        const next = await step("new independently reviewed pure scope", () =>
          settings.reviewCapture(process.cwd(), fixture.turn),
        )
        tracked.push(next)
        const cfg = descriptor(entry().managed)
        const leaf = path.join(path.dirname(cfg.supervisor.path), "index.py")
        expect(path.resolve(leaf).startsWith(path.resolve(cfg.root) + path.sep)).toBe(true)
        const bytes = await readFile(leaf)
        const baseline = projections.mock.calls.length
        try {
          await writeFile(leaf, Buffer.concat([bytes, Buffer.from("\n")]))
          await step("changed pinned source refused despite cached projection", () =>
            expect(fresh(next, storage)).rejects.toThrow(),
          )
          expect(projections.mock.calls.length).toBe(baseline)
        } finally {
          await writeFile(leaf, bytes)
        }
        witness.projections = projections.mock.calls.length
        witness.nativeValidations = native.mock.calls.length
      } finally {
        projections.mockRestore()
        native.mockRestore()
      }
      witness.passed = true
      await record()
    } catch (err) {
      witness.failed = true
      await record()
      await writeFile(
        path.join(diagnostics, "failure.json"),
        JSON.stringify({
          witness,
          error:
            err instanceof Error
              ? { name: err.name, message: err.message.slice(0, 8192), stack: err.stack?.slice(0, 16384) }
              : "unknown",
          qualification: "No inferred final original helper settlement or retry authority",
        }),
      )
      throw new Error("Original projection fixture failed; retained " + diagnostics, { cause: err })
    } finally {
      for (const value of tracked) disposeHistory(value)
      expect(path.dirname(fixture.root)).toBe(path.resolve(tmpdir()))
      expect(path.basename(fixture.root).startsWith("raya-namespace-test-")).toBe(true)
      if (witness.passed === true && witness.failed !== true) {
        await rm(fixture.root, { recursive: true })
        await rm(diagnostics, { recursive: true })
      }
    }
  },
  120000,
)
