import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { readFile, writeFile, rm, rename } from "node:fs/promises"
import { command } from "../../src/second-brain/control/command"
import { image } from "../../src/second-brain/control/identity"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { review, attach, transfer, currentPolicy, freshHistory } from "../../src/second-brain/capture-revisions"

const python = "D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe"
const ref = async (file: string) => {
  const held = await image(file)
  return { path: file, bytes: held.raw.length, sha256: held.digest }
}

for (const count of [0, 3, 7, 16])
  test(`actual isolated historical helper retains original effect through ${count} later publications`, async () => {
    const producer = await command(
      python,
      ["-B", path.resolve("script/memory/capture_revision_test.py"), "--prepare", "--count", String(count)],
      { cwd: process.cwd() },
    )
    const data = JSON.parse(producer.stdout) as {
      root: string
      notes: string
      anchor: { capture: string; inputSHA: string; policySHA: string }
      cfg: {
        turn: { id: string }
        history: {
          rows: { id: string; release: string }[]
          operations: {
            capture: string
            bodySHA: string
            root: string
            epoch: string
            request: string
            pendingSHA: string
            terminalSHA: string
          }[]
        }
      }
    }
    expect(path.dirname(data.root)).toBe(path.resolve(tmpdir()))
    expect(path.basename(data.root).startsWith("raya-namespace-test-")).toBe(true)
    try {
      const plan = path.join(data.root, "component-plan.json")
      await writeFile(
        plan,
        JSON.stringify({ qualification: "Actual joined helper component; no managed family admission claim" }),
      )
      const cfg = { root: data.root, python: await ref(python), plan: await ref(plan) }
      const ledger = structuredClone(data.cfg.history.rows)
      const held = fingerprint({ ledger })
      const scope = {
        audit: { phase: "applied", turn: data.cfg.turn, review: data.anchor, reviewSHA: fingerprint(data.anchor) },
        ledger,
        guard() {
          if (fingerprint({ ledger }) !== held) throw new Error("Authoritative ledger changed")
        },
        operations: await Promise.all(
          data.cfg.history.operations.map(async (row) => ({
            capture: row.capture,
            inputSHA: "0".repeat(64),
            bodySHA: row.bodySHA,
            resultSHA: "0".repeat(64),
            pendingRef: await ref(path.join(row.root, row.epoch, row.request + "-pending.json")),
            terminalRef: await ref(path.join(row.root, row.epoch, row.request + "-terminal.json")),
            epoch: row.epoch,
            release: data.cfg.history.rows.find((item) => item.id === row.capture)!.release,
            source_sha256: {},
          })),
        ),
      }
      if (count === 16) {
        const policy = await readFile(path.join(data.notes, "System", "general-admission.json"))
        await expect(review(process.cwd(), cfg, JSON.stringify(data.cfg), scope)).rejects.toThrow("8192-byte capacity")
        expect(await readFile(path.join(data.notes, "System", "general-admission.json"))).toEqual(policy)
        return
      }
      const observed = await review(process.cwd(), cfg, JSON.stringify(data.cfg), scope)
      expect(observed!.effect).toEqual(data.anchor)
      expect(observed!.bytes).toBeLessThanOrEqual(8192)
      expect(observed!.producer).toMatchObject({ code: 0, signal: null, stdoutEOF: true, stderrEOF: true })
      const value = { ...data.anchor }
      attach(value, observed!.proof)
      expect(Object.isFrozen(observed!.proof)).toBe(true)
      expect(Reflect.set(observed!.proof, "policy", "0".repeat(64))).toBe(false)
      const policy = currentPolicy(value)
      const effect = { ...observed!.effect, inputSHA: "0".repeat(64) }
      Object.assign(observed!.effect, effect)
      expect(() => attach(effect, observed!.proof)).toThrow("original effect")
      expect(currentPolicy(value)).toBe(policy)
      scope.guard = () => undefined
      scope.audit.reviewSHA = "0".repeat(64)
      expect(() => attach({ ...value, inputSHA: "0".repeat(64) }, observed!.proof)).toThrow("original effect")
      expect(currentPolicy(value) === value.policySHA).toBe(count === 0)
      await freshHistory(value)
      expect(() => currentPolicy(JSON.parse(JSON.stringify(value)))).toThrow("qualification was not retained")
      expect(() => attach({}, { ...observed!.proof })).toThrow("Original native")
      const copy = { ...value }
      transfer(value, copy)
      expect(currentPolicy(copy)).toBe(currentPolicy(value))
      expect(() => transfer(value, { ...copy, inputSHA: "0".repeat(64) })).toThrow("transfer differs")
      const file = path.join(data.notes, "Preferences", "Raya.md")
      const raw = await readFile(file)
      await writeFile(file, Buffer.concat([raw, Buffer.from("changed")]))
      await expect(freshHistory(value)).rejects.toThrow()
      await writeFile(file, raw)
      // A restored byte image is still a different tuple, so the original private grant stays invalid.
      await expect(freshHistory(value)).rejects.toThrow("evidence changed")
      if (count === 0) {
        const policy = path.join(data.notes, "System", "general-admission.json")
        const bytes = await readFile(policy)
        const state = { replaced: false }
        await expect(
          review(process.cwd(), cfg, JSON.stringify(data.cfg), {
            ...scope,
            audit: { phase: "applied", turn: data.cfg.turn, review: data.anchor, reviewSHA: fingerprint(data.anchor) },
            async refresh() {
              if (state.replaced) return
              const replacement = policy + ".replacement"
              await writeFile(replacement, bytes)
              await rename(replacement, policy)
              state.replaced = true
            },
          }),
        ).rejects.toThrow("Current policy identity changed")
        expect(state.replaced).toBe(true)
        expect(await readFile(policy)).toEqual(bytes)
        const note = await readFile(file)
        const calls = { count: 0 }
        await expect(
          review(process.cwd(), cfg, JSON.stringify(data.cfg), {
            ...scope,
            audit: { phase: "applied", turn: data.cfg.turn, review: data.anchor, reviewSHA: fingerprint(data.anchor) },
            async refresh() {
              calls.count += 1
              if (calls.count !== 2) return
              const replacement = file + ".replacement"
              await writeFile(replacement, note)
              await rename(replacement, file)
            },
          }),
        ).rejects.toThrow("Historical capture witness changed")
        expect(calls.count).toBe(2)
        expect(await readFile(file)).toEqual(note)
      }
      ledger.reverse()
      if (count > 1) expect(() => currentPolicy(value)).toThrow("Authoritative ledger changed")
    } finally {
      await rm(data.root, { recursive: true })
    }
  }, 60000)
