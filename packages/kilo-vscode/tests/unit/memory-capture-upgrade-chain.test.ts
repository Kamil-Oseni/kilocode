import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { readFileSync, writeFileSync } from "node:fs"
import { readFile, writeFile, rm, mkdir, mkdtemp } from "node:fs/promises"
import * as commands from "../../src/second-brain/control/command"
import * as processes from "../../src/util/process"
import { BrainSettings, parse } from "../../src/second-brain/settings"
import { descriptor } from "../../src/second-brain/managed/descriptor"
import { materialize } from "../../src/second-brain/managed/materialize"
import { publish } from "../../src/second-brain/managed/upgrade-publish"
import { linked } from "../../src/second-brain/managed/capture-upgrade"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { release } from "../../src/second-brain/control/catalog-capture"
import { CaptureIntake } from "../../src/second-brain/capture-intake"

test("fresh native capture review follows multiple exact applied upgrades without replaying its original effect", async () => {
  const parent = path.resolve("../../.tmp/new-pc")
  await mkdir(parent, { recursive: true })
  const diagnostics = await mkdtemp(path.join(parent, "capture-upgrade-chain-"))
  const witness: Record<string, unknown> = {
    passed: false,
    qualification: "No inferred original settlement or replay authority",
  }
  const events: Record<string, unknown>[] = []
  const epoch = performance.now()
  let dropped = 0
  const event = (value: Record<string, unknown>) => {
    if (events.length === 512) {
      events.shift()
      dropped++
    }
    events.push({ at: performance.now() - epoch, step: witness.step, ...value })
    try {
      writeFileSync(path.join(diagnostics, "lifecycle.json"), JSON.stringify({ dropped, events }))
    } catch (err) {
      witness.diagnosticError = err instanceof Error ? err.name : "unknown"
      console.error("CHAIN_LIFECYCLE_DIAGNOSTIC_WRITE_FAILED", diagnostics)
    }
  }
  const spawn = processes.spawn
  const command = commands.command
  const launches = spyOn(processes, "spawn").mockImplementation((file, args, opts) => {
    const started = performance.now() - epoch
    const child = spawn(file, args, opts)
    const pid = child.pid ?? null
    const executable = path.basename(file)
    event({ kind: "spawn", pid, executable, started, classification: "unconfirmed" })
    child.once("exit", (code, signal) =>
      event({ kind: "exit", pid, executable, started, code, signal, classification: "exit-only-not-reader-join" }),
    )
    child.once("close", (code, signal) =>
      event({
        kind: "close",
        pid,
        executable,
        started,
        code,
        signal,
        classification: "close-only-not-command-receipt",
      }),
    )
    return child
  })
  const receipts = spyOn(commands, "command").mockImplementation(async (file, args, opts, timeout, bound) => {
    const started = performance.now() - epoch
    try {
      const output = await command(file, args, opts, timeout, bound)
      event({
        kind: "command-receipt",
        pid: output.receipt.pid,
        executable: path.basename(file),
        started,
        elapsed: performance.now() - epoch - started,
        receipt: output.receipt,
        classification: "original-command-receipt-returned",
      })
      return output
    } catch (err) {
      const receipt =
        err instanceof Error && "receipt" in err ? (err as Error & { receipt: unknown }).receipt : undefined
      const pid = receipt && typeof receipt === "object" && "pid" in receipt ? receipt.pid : null
      event({
        kind: "command-failure",
        pid,
        executable: path.basename(file),
        started,
        elapsed: performance.now() - epoch - started,
        receipt,
        classification: receipt === undefined ? "unconfirmed-no-receipt" : "original-failure-receipt-retained",
      })
      throw err
    }
  })
  try {
    const record = async () => writeFile(path.join(diagnostics, "progress.json"), JSON.stringify(witness))
    const failure = async (err: unknown) => {
      witness.failed = true
      const nodes = { count: 0 }
      const describe = (value: unknown, depth = 0): unknown => {
        if (++nodes.count > 16 || depth > 4) return { omitted: true }
        if (!(value instanceof Error)) return String(value).slice(0, 4096)
        const receipt = Object.hasOwn(value, "receipt")
          ? JSON.stringify((value as Error & { receipt: unknown }).receipt)
          : undefined
        return {
          name: value.name,
          message: value.message.slice(0, 4096),
          stack: value.stack?.slice(0, 8192),
          ...(receipt === undefined
            ? {}
            : { receipt: receipt.slice(0, 65536), receiptTruncated: receipt.length > 65536 }),
          ...(value instanceof AggregateError
            ? { errors: value.errors.slice(0, 8).map((item) => describe(item, depth + 1)) }
            : {}),
          ...(value.cause === undefined ? {} : { cause: describe(value.cause, depth + 1) }),
        }
      }
      await record()
      await writeFile(path.join(diagnostics, "failure.json"), JSON.stringify({ witness, error: describe(err) }))
      return new Error("Original chain fixture failed; witnesses retained: " + diagnostics, { cause: err })
    }
    const step = async <T>(name: string, body: () => Promise<T>) => {
      witness.step = name
      witness.phase = "awaiting-original"
      await record()
      const value = await body()
      witness.completed = name
      witness.phase = "returned-original"
      await record()
      return value
    }
    const child = await step("original producer and stream joins", () =>
      commands.command(
        process.execPath,
        [path.resolve("tests/unit/fixtures/committed-capture-producer.ts"), "--runtime"],
        {
          cwd: process.cwd(),
        },
      ),
    ).catch(async (err: unknown) => {
      throw await failure(err)
    })
    witness.producer = child.receipt
    await record()
    const fixture = await (async () => {
      expect(child.receipt.code, child.stderr).toBe(0)
      const fixture = JSON.parse(child.stdout) as {
        root: string
        notes: string
        file: string
        turn: { id: string; release: string }
        producer: { code: number; stdoutEOF: boolean; stderrEOF: boolean }
      }
      witness.fixture = { root: fixture.root, file: fixture.file, producer: fixture.producer }
      await record()
      expect(fixture.producer).toMatchObject({ code: 0, stdoutEOF: true, stderrEOF: true })
      return fixture
    })().catch(async (err: unknown) => {
      throw await failure(err)
    })
    const state = "raya.secondBrain.setup"
    const storage = {
      get<T>(key: string) {
        return JSON.parse(readFileSync(fixture.file, "utf8"))[key] as T | undefined
      },
      async update(key: string, value: unknown) {
        const data = JSON.parse(await readFile(fixture.file, "utf8"))
        if (value === undefined) delete data[key]
        if (value !== undefined) data[key] = value
        await writeFile(fixture.file, JSON.stringify(data))
      },
    }
    const settings = () =>
      new BrainSettings(storage, {
        async get() {
          return "synthetic"
        },
        async store() {},
        async delete() {},
      })
    try {
      const original = await step("original recovery", () =>
        settings().recoverCapture(process.cwd(), fixture.turn, async () => true),
      )
      expect(original).toBeDefined()
      const key = `raya.secondBrain.committedCaptureRecovery.${fixture.turn.id}`
      const audit = storage.get(key)
      const ledger = storage.get("raya.secondBrain.personalCapture.turns")
      const effects = await readFile(original!.evidence.operations[0].path)
      const entry = () =>
        storage.get<{ setup: unknown; managed: unknown; credential: string; launch?: unknown }>(state)!
      const first = await step("first native materialization", () =>
        materialize(descriptor(entry().managed), parse(entry().setup), process.cwd(), "8".repeat(32)),
      )
      witness.first = first.receipt
      await step("first durable publication", () => publish(storage, first.receipt))
      const single = await step("first source review", () => settings().reviewCapture(process.cwd(), fixture.turn))
      expect(linked(single)?.version).toBe(1)
      expect(linked(single)?.previousRelease).toBe(fixture.turn.release)
      expect(fixture.turn.release).not.toBe(fingerprint(release))
      const second = await step("second native materialization", () =>
        materialize(descriptor(entry().managed), parse(entry().setup), process.cwd(), "9".repeat(32)),
      )
      witness.second = second.receipt
      await step("second durable publication", () => publish(storage, second.receipt))
      const current = structuredClone(entry())
      const reviewed = await step("multi-upgrade source review", () =>
        settings().reviewCapture(process.cwd(), fixture.turn),
      )
      const link = linked(reviewed, storage)
      expect(link?.version).toBe(2)
      if (link?.version !== 2) throw new Error("Actual multi-upgrade proof required")
      expect(link.chain.map((row) => row.artifact)).toEqual([first.receipt, second.receipt])
      expect(link.previousRelease).toBe(fixture.turn.release)
      expect(link.release).toBe(fingerprint(release))
      expect(link).toMatchObject({ requestSettlement: false, replay: false, indexConfirmed: false })
      expect(storage.get(key)).toEqual(audit)
      expect(storage.get("raya.secondBrain.personalCapture.turns")).toEqual(ledger)
      expect(await readFile(original!.evidence.operations[0].path)).toEqual(effects)
      expect(linked(JSON.parse(JSON.stringify(reviewed)))).toBeUndefined()
      witness.step = "retained audit tamper and race refusals"
      await record()
      const older = `raya.secondBrain.runtimeUpgrade.${first.id}`
      const latest = `raya.secondBrain.runtimeUpgrade.${second.id}`
      const retained = structuredClone(storage.get<Record<string, unknown>>(older)!)
      const newer = structuredClone(storage.get<Record<string, unknown>>(latest)!)
      await storage.update(older, undefined)
      await expect(settings().reviewCapture(process.cwd(), fixture.turn)).rejects.toThrow(
        "Retained capture operation upgrade required",
      )
      await storage.update(older, { ...retained, artifact: second.receipt })
      await expect(settings().reviewCapture(process.cwd(), fixture.turn)).rejects.toThrow(
        "Capture operation upgrade changed",
      )
      await storage.update(older, { ...retained, phase: "prepared" })
      expect(() => linked(reviewed, storage)).toThrow("selection changed")
      await expect(settings().reviewCapture(process.cwd(), fixture.turn)).rejects.toThrow("Applied runtime publication")
      await storage.update(older, retained)
      // A hostile retained predecessor pointing back to the latest selection must not form an accepted cycle.
      await storage.update(older, {
        ...retained,
        previous: [{ present: true, value: current }, ...(retained.previous as unknown[]).slice(1)],
      })
      await expect(settings().reviewCapture(process.cwd(), fixture.turn)).rejects.toThrow()
      await storage.update(older, retained)
      const disk = JSON.parse(readFileSync(fixture.file, "utf8"))
      let changed = false
      const racing = {
        get<T>(name: string) {
          const value = storage.get<T>(name)
          if (!changed && name === older && value && typeof value === "object" && "phase" in value) {
            changed = true
            writeFileSync(fixture.file, JSON.stringify({ ...disk, [older]: { ...retained, stage: 2 } }))
          }
          return value
        },
        update: storage.update,
      }
      await expect(
        new BrainSettings(racing, {
          async get() {
            return "synthetic"
          },
          async store() {},
          async delete() {},
        }).reviewCapture(process.cwd(), fixture.turn),
      ).rejects.toThrow()
      expect(changed).toBe(true)
      await storage.update(older, retained)
      expect(storage.get(latest)).toEqual(newer)
      expect(entry()).toEqual(current)
      const cold = await step("cold original source review", () =>
        settings().reviewCapture(process.cwd(), fixture.turn),
      )
      expect(linked(cold)).toEqual(link)
      // These are confirmation inputs only; this test does not claim authenticated model/index acceptance.
      await step("original provenance confirmation", () =>
        new CaptureIntake(storage).confirmRecovery(
          cold,
          {
            root: fixture.notes,
            release: fingerprint(release),
            owner: "synthetic-confirmation-input",
            generation: {},
            index: "synced",
            digest: cold.policySHA,
          },
          () => {},
        ),
      )
      expect(storage.get(`${key}.confirmation`)).toMatchObject({
        upgrade: link,
        requestSettlement: false,
        replay: false,
        indexConfirmed: true,
      })
      expect(await readFile(original!.evidence.operations[0].path)).toEqual(effects)
      witness.passed = true
      await record()
    } catch (err) {
      throw await failure(err)
    } finally {
      expect(path.dirname(fixture.root)).toBe(path.resolve(os.tmpdir()))
      expect(path.basename(fixture.root).startsWith("raya-namespace-test-")).toBe(true)
      if (witness.passed === true && witness.failed !== true) {
        await rm(fixture.root, { recursive: true })
      }
    }
  } finally {
    receipts.mockRestore()
    launches.mockRestore()
  }
}, 60000)
