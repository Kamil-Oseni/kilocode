import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { readFileSync } from "node:fs"
import { readFile, writeFile, rm } from "node:fs/promises"
import { command } from "../../src/second-brain/control/command"
import { BrainSettings, parse } from "../../src/second-brain/settings"
import { descriptor } from "../../src/second-brain/managed/descriptor"
import { materialize } from "../../src/second-brain/managed/materialize"
import { publish } from "../../src/second-brain/managed/upgrade-publish"
import { linked, historical } from "../../src/second-brain/managed/capture-upgrade"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { release } from "../../src/second-brain/control/catalog-capture"
import { CaptureIntake } from "../../src/second-brain/capture-intake"

for (const prefix of [0, 1, 2])
  test(`native ${prefix}-edge historical confirmation survives another upgrade with immutable proof and synthetic current-index input`, async () => {
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
    const ledger = "raya.secondBrain.personalCapture.turns"
    const key = `raya.secondBrain.committedCaptureRecovery.${fixture.turn.id}`
    const target = `${key}.confirmation`
    const writes: string[] = []
    let fail = false
    const storage = {
      get<T>(name: string) {
        return JSON.parse(readFileSync(fixture.file, "utf8"))[name] as T | undefined
      },
      async update(name: string, value: unknown) {
        if (fail && name === ledger) {
          fail = false
          throw new Error("Owned ledger-save failure after confirmation persisted")
        }
        const data = JSON.parse(await readFile(fixture.file, "utf8"))
        if (value === undefined) delete data[name]
        if (value !== undefined) data[name] = value
        await writeFile(fixture.file, JSON.stringify(data))
        writes.push(name)
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
    const intake = () => new CaptureIntake(storage)
    const entry = () => storage.get<{ setup: unknown; managed: unknown; credential: string; launch?: unknown }>(state)!
    const input = () => storage.get<{ id: string }[]>(ledger)!.find((row) => row.id === fixture.turn.id)!
    const upgrade = async (id: string) => {
      const artifact = await materialize(
        descriptor(entry().managed),
        parse(entry().setup),
        process.cwd(),
        id.repeat(32),
      )
      await publish(storage, artifact.receipt)
      return artifact
    }
    try {
      const original = await settings().recoverCapture(process.cwd(), fixture.turn, async () => true)
      expect(original).toBeDefined()
      const audit = structuredClone(storage.get(key))
      const effects = await Promise.all(original!.evidence.operations.map((row) => readFile(row.path)))
      expect(fixture.turn.release).not.toBe(fingerprint(release))
      for (const id of ["a", "b"].slice(0, prefix)) await upgrade(id)
      const reviewed = await settings().reviewCapture(process.cwd(), input())
      // Binding values are synthetic source inputs; no model or authenticated live index is exercised here.
      const binding = (value: typeof reviewed) => ({
        root: fixture.notes,
        release: fingerprint(parse(entry().setup).source_sha256),
        owner: "synthetic-confirmation-input",
        generation: {},
        index: "synced" as const,
        digest: value.policySHA,
      })
      fail = prefix !== 1
      if (fail)
        await expect(intake().confirmRecovery(reviewed, binding(reviewed), () => {})).rejects.toThrow(
          "ledger-save failure",
        )
      if (prefix === 1) await intake().confirmRecovery(reviewed, binding(reviewed), () => {})
      const proof = structuredClone(storage.get<Record<string, unknown>>(target)!)
      expect(proof).toMatchObject({ requestSettlement: false, replay: false, indexConfirmed: true })
      if (prefix === 0) expect(proof.upgrade).toBeUndefined()
      if (prefix === 1) expect(proof.upgrade).toMatchObject({ version: 1 })
      if (prefix === 2) expect(proof.upgrade).toMatchObject({ version: 2 })
      const later = await upgrade("c")
      const current = structuredClone(entry())
      const cold = await settings().reviewCapture(process.cwd(), input())
      expect(linked(cold)?.artifact).toEqual(later.receipt)
      expect(linked(cold)?.release).toBe(fingerprint(release))
      const exported = linked(cold)!
      Reflect.set(exported.artifact, "sha256", "f".repeat(64))
      expect(linked(cold)?.artifact).toEqual(later.receipt)
      if (prefix > 0) {
        const exported = historical(cold, proof.upgrade)!
        Reflect.set(exported.artifact, "sha256", "f".repeat(64))
        expect(historical(cold, proof.upgrade)).toEqual(proof.upgrade)
      }
      expect(() => historical(JSON.parse(JSON.stringify(cold)), proof.upgrade)).toThrow("Fresh original")
      for (const changed of [
        { ...proof, policySHA: "f".repeat(64) },
        { ...proof, reviewSHA: "f".repeat(64) },
        { ...proof, indexConfirmed: false },
        { ...proof, requestSettlement: true },
        { ...proof, unknown: true },
        { ...proof, completed: { ...(proof.completed as object), receipt: "f".repeat(64) } },
        {
          ...proof,
          upgrade: { ...(proof.upgrade as object), artifact: later.receipt, publicationSHA: "f".repeat(64) },
        },
      ]) {
        await storage.update(target, changed)
        await expect(intake().confirmRecovery(cold, binding(cold), () => {})).rejects.toThrow()
      }
      await storage.update(target, proof)
      if (prefix === 1) {
        await storage.update(target, undefined)
        await expect(settings().reviewCapture(process.cwd(), input())).rejects.toThrow("confirmation required")
        await expect(intake().confirmRecovery(cold, binding(cold), () => {})).rejects.toThrow("confirmation required")
        await storage.update(target, proof)
      }
      await storage.update(state, { ...current, credential: "changed-owned-selection" })
      expect(() => historical(cold, proof.upgrade)).toThrow("changed")
      await expect(intake().confirmRecovery(cold, binding(cold), () => {})).rejects.toThrow("selection changed")
      await storage.update(state, current)
      const before = writes.filter((row) => row === target).length
      const previous = writes.filter((row) => row === ledger).length
      await intake().confirmRecovery(cold, binding(cold), () => {})
      expect(writes.filter((row) => row === target)).toHaveLength(before)
      expect(writes.filter((row) => row === ledger)).toHaveLength(previous + (prefix === 1 ? 0 : 1))
      expect(storage.get(target)).toEqual(proof)
      expect(storage.get(key)).toEqual(audit)
      const final = await settings().reviewCapture(process.cwd(), input())
      await intake().confirmRecovery(final, binding(final), () => {})
      expect(writes.filter((row) => row === target)).toHaveLength(before)
      expect(storage.get(target)).toEqual(proof)
      expect(await Promise.all(original!.evidence.operations.map((row) => readFile(row.path)))).toEqual(effects)
      expect(entry()).toEqual(current)
    } finally {
      expect(path.dirname(fixture.root)).toBe(path.resolve(os.tmpdir()))
      expect(path.basename(fixture.root).startsWith("raya-namespace-test-")).toBe(true)
      await rm(fixture.root, { recursive: true })
    }
  }, 120000)
