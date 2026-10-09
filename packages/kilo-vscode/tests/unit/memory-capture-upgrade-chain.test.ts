import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { readFileSync, writeFileSync } from "node:fs"
import { readFile, writeFile, rm } from "node:fs/promises"
import { command } from "../../src/second-brain/control/command"
import { BrainSettings, parse } from "../../src/second-brain/settings"
import { descriptor } from "../../src/second-brain/managed/descriptor"
import { materialize } from "../../src/second-brain/managed/materialize"
import { publish } from "../../src/second-brain/managed/upgrade-publish"
import { linked } from "../../src/second-brain/managed/capture-upgrade"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { release } from "../../src/second-brain/control/catalog-capture"
import { CaptureIntake } from "../../src/second-brain/capture-intake"

test("fresh native capture review follows multiple exact applied upgrades without replaying its original effect", async () => {
  const child = await command(
    process.execPath,
    [path.resolve("tests/unit/fixtures/committed-capture-producer.ts"), "--runtime"],
    { cwd: process.cwd() },
  )
  expect(child.receipt.code, child.stderr).toBe(0)
  const fixture = JSON.parse(child.stdout) as {
    root: string
    notes: string
    file: string
    turn: { id: string; release: string }
    producer: { code: number; stdoutEOF: boolean; stderrEOF: boolean }
  }
  expect(fixture.producer).toMatchObject({ code: 0, stdoutEOF: true, stderrEOF: true })
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
    const original = await settings().recoverCapture(process.cwd(), fixture.turn, async () => true)
    expect(original).toBeDefined()
    const key = `raya.secondBrain.committedCaptureRecovery.${fixture.turn.id}`
    const audit = storage.get(key)
    const ledger = storage.get("raya.secondBrain.personalCapture.turns")
    const effects = await readFile(original!.evidence.operations[0].path)
    const entry = () => storage.get<{ setup: unknown; managed: unknown; credential: string; launch?: unknown }>(state)!
    const first = await materialize(descriptor(entry().managed), parse(entry().setup), process.cwd(), "8".repeat(32))
    await publish(storage, first.receipt)
    const single = await settings().reviewCapture(process.cwd(), fixture.turn)
    expect(linked(single)?.version).toBe(1)
    expect(linked(single)?.previousRelease).toBe(fixture.turn.release)
    expect(fixture.turn.release).not.toBe(fingerprint(release))
    const second = await materialize(descriptor(entry().managed), parse(entry().setup), process.cwd(), "9".repeat(32))
    await publish(storage, second.receipt)
    const current = structuredClone(entry())
    const reviewed = await settings().reviewCapture(process.cwd(), fixture.turn)
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
    const older = `raya.secondBrain.runtimeUpgrade.${first.id}`
    const latest = `raya.secondBrain.runtimeUpgrade.${second.id}`
    const retained = structuredClone(storage.get<Record<string, unknown>>(older)!)
    const newer = structuredClone(storage.get<Record<string, unknown>>(latest)!)
    await storage.update(older, undefined)
    await expect(settings().reviewCapture(process.cwd(), fixture.turn)).rejects.toThrow("runtime upgrade required")
    await storage.update(older, { ...retained, artifact: second.receipt })
    await expect(settings().reviewCapture(process.cwd(), fixture.turn)).rejects.toThrow("artifact identity differs")
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
    const cold = await settings().reviewCapture(process.cwd(), fixture.turn)
    expect(linked(cold)).toEqual(link)
    // These are confirmation inputs only; this test does not claim authenticated model/index acceptance.
    await new CaptureIntake(storage).confirmRecovery(
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
    )
    expect(storage.get(`${key}.confirmation`)).toMatchObject({
      upgrade: link,
      requestSettlement: false,
      replay: false,
      indexConfirmed: true,
    })
    expect(await readFile(original!.evidence.operations[0].path)).toEqual(effects)
  } finally {
    expect(path.dirname(fixture.root)).toBe(path.resolve(os.tmpdir()))
    expect(path.basename(fixture.root).startsWith("raya-namespace-test-")).toBe(true)
    await rm(fixture.root, { recursive: true })
  }
}, 60000)
