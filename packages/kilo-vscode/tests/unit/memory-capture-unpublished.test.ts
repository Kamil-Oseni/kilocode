import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { inspect, review } from "../../src/second-brain/capture-unpublished"
import { image } from "../../src/second-brain/control/identity"
import { CaptureIntake, records } from "../../src/second-brain/capture-intake"

const fixture = process.env.RAYA_CAPTURE_UNPUBLISHED_FIXTURE
const names = ["original", "failures", "health", "qualification", "seal", "install", "cold", "manifest"] as const
const ledger = "raya.secondBrain.personalCapture.turns"
const failures = "raya.secondBrain.personalCapture.failures"
const setup = "raya.secondBrain.setup"
const catalog = "raya.secondBrain.control.catalog"
const consent = "raya.secondBrain.personalCapture"
const debt = "raya.secondBrain.control.uncertainty"
const row = z.record(z.string(), z.unknown())

test("unpublished review rejects missing and unknown evidence before any activity", async () => {
  const storage = {
    get<T>(): T | undefined {
      return undefined
    },
  }
  await expect(inspect({}, storage)).rejects.toThrow()
  await expect(
    inspect({ format: "raya.capture.authorization.disposition.review", version: 1, untrusted: true }, storage),
  ).rejects.toThrow()
})

// The original protected producer files stay external: this exercises actual
// bounded file readers and production admission, never real Memento or notes.
test.skipIf(!fixture)(
  "exact original producer evidence, cold binding and retained replay fence use real files",
  async () => {
    const paths = z.record(z.enum(names), z.string()).parse(JSON.parse(await readFile(fixture!, "utf8")))
    const dir = await mkdtemp(path.join(tmpdir(), "raya-unpublished-evidence-"))
    const file = path.join(dir, "state.json")
    const storage = {
      get<T>(key: string): T | undefined {
        return JSON.parse(readFileSync(file, "utf8"))[key]
      },
      async update(key: string, value: unknown) {
        await Bun.write(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), [key]: value }))
      },
    }
    try {
      const refs = Object.fromEntries(
        await Promise.all(
          names.map(async (name) => {
            const held = await image(paths[name], 3000000)
            return [name, { path: paths[name], bytes: held.raw.length, sha256: held.digest, tuple: held.tuple }]
          }),
        ),
      )
      const original = row.parse(JSON.parse(await readFile(paths.original, "utf8")))
      const health = row.parse(JSON.parse(await readFile(paths.health, "utf8")))
      const cold = row.parse(JSON.parse(await readFile(paths.cold, "utf8")))
      const diagnostic = row.parse(JSON.parse(await readFile(paths.failures, "utf8")))
      const selected = row.parse(health.selected)
      const cfg = row.parse(selected.setup)
      const turn = records([original.ledger])[0]
      const state = {
        [setup]: { ...selected, launch: { phase: "closed", receipt: cold.closure } },
        [catalog]: {
          root: turn.root,
          catalog: {
            format: "raya.memory.control.catalog",
            version: 2,
            python: path.join(dir, "python.exe"),
            source: path.join(dir, "source"),
            bridge: path.join(dir, "control.py"),
            python_sha256: "b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2",
            bridge_sha256: "16006c57ae824450d5ecab9bd020e975d51ad417a849d457120e63dd6be1bdf0",
            source_sha256: cfg.source_sha256,
          },
        },
        [consent]: {
          version: 1,
          enabled: true,
          root: turn.root,
          release: turn.release,
          zone: "UTC",
          model: "inert",
          authorization: { source: "Disposable reviewed fixture", sha256: "a".repeat(64) },
        },
        [ledger]: [turn],
        [failures]: diagnostic.failureAudit,
      }
      await Bun.write(file, JSON.stringify(state))
      const binding = path.join(dir, "binding.json")
      await Bun.write(binding, JSON.stringify(state))
      const held = await image(binding)
      const input = {
        format: "raya.capture.authorization.disposition.review",
        version: 1,
        ...refs,
        binding: { path: binding, bytes: held.raw.length, sha256: held.digest, tuple: held.tuple },
      }
      const bytes = await readFile(file)
      const proof = await inspect(input, storage)
      expect(proof.original).toEqual(turn)
      expect(proof.completed).toEqual({ ...turn, phase: "skipped" })
      expect(proof.completed).not.toHaveProperty("receipt")
      expect(proof).not.toHaveProperty("observation")
      expect(await readFile(file)).toEqual(bytes)
      for (const name of names) {
        await expect(
          inspect({ ...input, [name]: { ...refs[name], sha256: "b".repeat(64) } }, storage),
        ).rejects.toThrow()
        expect(await readFile(file)).toEqual(bytes)
      }
      for (const [key, value] of [
        [debt, { pending: true }],
        [failures, []],
        [ledger, [{ ...turn, phase: "published", receipt: "c".repeat(64) }]],
        [consent, { ...state[consent], release: "d".repeat(64) }],
      ]) {
        await storage.update(String(key), value)
        await expect(inspect(input, storage)).rejects.toThrow()
        await Bun.write(file, bytes)
      }
      await storage.update(setup, { ...selected, launch: cold.savedLaunch })
      await expect(review(input, storage, dir)).rejects.toThrow()
      expect(storage.get(ledger)).toEqual([turn])
      await Bun.write(file, bytes)
      const audit = `raya.secondBrain.captureUnpublished.${turn.id}`
      await storage.update(audit, {
        phase: "prepared",
        original: proof.original,
        completed: proof.completed,
        outcome: "failed_before_publication",
        requestSettlement: false,
        indexConfirmed: false,
        replay: false,
        nativeFamilyRetirement: false,
      })
      await storage.update(ledger, [proof.completed])
      expect((await inspect(input, storage)).bindingSHA).toBe(proof.bindingSHA)
      const scope = {
        root: turn.root,
        release: turn.release,
        owner: "fixture",
        generation: {},
        index: "synced" as const,
      }
      const intake = new CaptureIntake(storage)
      expect(intake.snapshot(scope).status).toBe("uncertain")
      await storage.update(audit, { ...storage.get<Record<string, unknown>>(audit), phase: "applied" })
      expect(new CaptureIntake(storage).snapshot(scope).status).toBe("ready")
      expect(new CaptureIntake(storage).lastSaved(scope)).toBeUndefined()
      expect(await new CaptureIntake(storage).grant(turn, scope, () => {})).toBeUndefined()
      expect(storage.get(failures)).toEqual(diagnostic.failureAudit)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
