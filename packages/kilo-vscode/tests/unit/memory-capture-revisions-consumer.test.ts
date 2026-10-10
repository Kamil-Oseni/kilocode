import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "node:os"
import { readFileSync } from "node:fs"
import { readFile, writeFile, rm, lstat } from "node:fs/promises"
import { command } from "../../src/second-brain/control/command"
import { BrainSettings, parse } from "../../src/second-brain/settings"
import { descriptor, selection } from "../../src/second-brain/managed/descriptor"
import { records, CaptureIntake } from "../../src/second-brain/capture-intake"
import { currentPolicy } from "../../src/second-brain/capture-revisions"
import { fresh } from "../../src/second-brain/managed/capture-upgrade"
import { powershell, environment } from "../../src/second-brain/control/identity"
import { protection } from "../../src/second-brain/managed/protection"
import { launch } from "../../src/second-brain/managed/restart"
import { generation } from "../../src/second-brain/managed/generation"
import { publish } from "../../src/second-brain/managed/owner"
import type { successors } from "../../src/second-brain/managed/capture-lineage"

const native = process.platform === "win32" ? test : test.skip

native(
  "real later disjoint captures retain original native recovery and synthetic current index binding",
  async () => {
    const produced = await command(
      process.execPath,
      [path.resolve("tests/unit/fixtures/committed-capture-producer.ts"), "--runtime"],
      { cwd: process.cwd() },
    )
    const fixture = JSON.parse(produced.stdout) as { root: string; notes: string; file: string; turn: unknown }
    expect(produced.receipt).toMatchObject({ code: 0, originalJoined: true, readersJoined: true, forced: false })
    try {
      const fault = { enabled: false }
      const storage = {
        get<T>(key: string) {
          return (JSON.parse(readFileSync(fixture.file, "utf8")) as Record<string, unknown>)[key] as T | undefined
        },
        async update(key: string, value: unknown) {
          const rows = JSON.parse(await readFile(fixture.file, "utf8")) as Record<string, unknown>
          if (value === undefined) delete rows[key]
          if (value !== undefined) rows[key] = value
          await writeFile(fixture.file, JSON.stringify(rows))
          if (fault.enabled && key === "raya.secondBrain.personalCapture.turns") {
            fault.enabled = false
            throw new Error("Original ledger physical acknowledgement loss")
          }
        },
      }
      const settings = new BrainSettings(storage, {
        async get() {
          return "synthetic"
        },
        async store() {},
        async delete() {},
      })
      const initial = descriptor(storage.get<{ managed: unknown }>("raya.secondBrain.setup")?.managed)
      expect(path.resolve(initial.namespaces.memory.root).startsWith(path.resolve(fixture.root) + path.sep)).toBe(true)
      const acl = `$ErrorActionPreference='Stop';$acl=Get-Acl -LiteralPath '${initial.root.replace(/'/g, "''")}';Set-Acl -LiteralPath '${initial.namespaces.memory.root.replace(/'/g, "''")}' -AclObject $acl`
      await command(
        powershell(),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(acl, "utf16le").toString("base64")],
        { windowsHide: true, env: environment() },
      )
      expect(await protection(initial.namespaces.memory.root)).toBe(initial.namespaces.memory.sid)
      const original = await settings.recoverCapture(process.cwd(), fixture.turn, async () => true)
      if (!original) throw new Error("Actual original native recovery required")
      const key = `raya.secondBrain.committedCaptureRecovery.${original.capture}`
      const audit = storage.get(key)
      const entry = storage.get<Parameters<typeof successors>[0]>("raya.secondBrain.setup")!
      const base = descriptor(entry.managed)
      const setup = parse(entry.setup)
      const context = await launch(base, setup, original.closure.closed)
      const pinned = await selection(base, setup)
      const cfg = await generation(base, context, pinned.files)
      const approved = await selection(cfg, setup)
      const root = await lstat(cfg.root, { bigint: true })
      const selected = await publish(path.join(context.root, "managed-reservation.json"), {
        format: "raya.memory.managed.pair.selected",
        version: 2,
        descriptor: cfg,
        rootIdentity: [root.dev, root.ino, root.birthtimeNs].map(String),
        images: approved.files.map((item, index) => ({
          ref: [cfg.python, cfg.supervisor, cfg.plan, cfg.retrieval][index],
          sha256: item.digest,
          tuple: item.tuple,
        })),
        containment: "Fresh native namespace selection only; no per-operation native owner or model qualification",
        predecessor: original.closure.closed,
      })
      const prior = entry.launch as { history?: unknown[] }
      await storage.update("raya.secondBrain.setup", {
        ...entry,
        managed: cfg,
        launch: { phase: "selected", receipt: selected, history: [...(prior.history ?? []), original.closure.closed] },
      })
      const metadata = path.join(fixture.root, "append-owned-captures.json")
      await writeFile(
        metadata,
        JSON.stringify({
          root: fixture.root,
          notes: fixture.notes,
          source: approved.plan.source,
          namespace: cfg.namespaces.memory.root,
          sid: cfg.namespaces.memory.sid,
          capture: original.capture,
          count: 2,
        }),
      )
      const appended = await command(
        "D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe",
        ["-B", path.resolve("script/memory/capture_revision_test.py"), "--append", await readFile(metadata, "utf8")],
        { cwd: process.cwd() },
      ).catch(async (err: unknown) => {
        if (err instanceof Error && "output" in err)
          await writeFile(
            path.resolve(`../../.tmp/new-pc/capture-revisions-consumer-append-failure-${Date.now()}.json`),
            JSON.stringify({ message: err.message, output: err.output }, null, 2),
          )
        throw err
      })
      expect(appended.receipt).toMatchObject({ code: 0, originalJoined: true, readersJoined: true, forced: false })
      const later = JSON.parse(appended.stdout) as { rows: unknown }
      const rows = records(later.rows)
      expect(rows).toHaveLength(2)
      await storage.update("raya.secondBrain.personalCapture.turns", [fixture.turn, ...rows])
      const reviewed = await settings.reviewCapture(process.cwd(), fixture.turn)
      expect(reviewed.inputSHA).toBe(original.inputSHA)
      expect(reviewed.policySHA).toBe(original.policySHA)
      expect(currentPolicy(reviewed)).not.toBe(original.policySHA)
      expect(storage.get(key)).toEqual(audit)
      const binding = {
        root: reviewed.root,
        release: rows[0].release,
        generation: {},
        owner: "synthetic-current-index-input-no-model-index-qualification",
        index: "synced" as const,
        digest: currentPolicy(reviewed),
      }
      const intake = new CaptureIntake(storage)
      await expect(
        intake.confirmRecovery(reviewed, { ...binding, digest: original.policySHA }, () => {}),
      ).rejects.toThrow("must agree")
      fault.enabled = true
      await expect(intake.confirmRecovery(reviewed, binding, () => {})).rejects.toThrow("physical acknowledgement loss")
      const confirmed = storage.get(`${key}.confirmation`)
      const completed = records(storage.get("raya.secondBrain.personalCapture.turns"))[0]
      expect(completed).toMatchObject({ phase: "published", receipt: original.inputSHA })
      const cold = await settings.reviewCapture(process.cwd(), completed)
      await new CaptureIntake(storage).confirmRecovery(cold, binding, () => {})
      expect(storage.get(`${key}.confirmation`)).toEqual(confirmed)
      expect(storage.get(key)).toEqual(audit)
      expect(records(storage.get("raya.secondBrain.personalCapture.turns")).slice(1)).toEqual(rows)
      const before = await readFile(fixture.file)
      const manifest = path.join(fixture.notes, "System", "Changes", rows[0].id, "manifest.json")
      const raw = await readFile(manifest)
      await writeFile(manifest, Buffer.concat([raw, Buffer.from(" ")]))
      await expect(fresh(cold, storage)).rejects.toThrow()
      expect(await readFile(fixture.file)).toEqual(before)
    } finally {
      if (
        path.dirname(fixture.root) !== path.resolve(tmpdir()) ||
        !path.basename(fixture.root).startsWith("raya-namespace-test-")
      )
        throw new Error("Owned capture fixture cleanup required")
      await rm(fixture.root, { recursive: true })
    }
  },
  180000,
)
