import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CaptureIntake, migrate } from "../../src/second-brain/capture-intake"
import { release, selected } from "../../src/second-brain/control/catalog-capture"
import { fingerprint } from "../../src/second-brain/failed-repair"
import { parse } from "../../src/second-brain/settings"
import { metadata } from "../../src/second-brain/manifest"

test("last saved receipt follows confirmed publication order and excludes other scopes or uncertain attempts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-capture-receipt-"))
  const file = path.join(dir, "state.json")
  const storage = {
    get<T>(key: string): T | undefined {
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))[key] : undefined
    },
    async update(key: string, value: unknown) {
      const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
      await Bun.write(file, JSON.stringify({ ...prior, [key]: value }))
    },
  }
  try {
    const intake = new CaptureIntake(storage)
    const binding = {
      root: path.join(dir, "notes"),
      release: "a".repeat(64),
      owner: "owner",
      generation: {},
      index: "synced" as const,
    }
    await intake.save(
      {
        version: 1,
        enabled: true,
        root: binding.root,
        release: binding.release,
        model: "local-selected",
        zone: "America/Toronto",
        authorization: { source: "Reviewed choice", sha256: "b".repeat(64) },
      },
      binding,
    )
    const first = { project: dir, sessionID: "conversation", messageID: "first", source_sha256: "c".repeat(64) }
    const second = { ...first, messageID: "second" }
    expect(await intake.grant(first, binding, () => {})).toBeDefined()
    expect(await intake.grant(second, binding, () => {})).toBeDefined()
    expect(intake.lastSaved(binding)).toBeUndefined()
    await intake.finish(second, "published", "d".repeat(64))
    expect(intake.lastSaved(binding)?.messageID).toBe("second")
    await intake.finish(first, "published", "e".repeat(64))
    const receipt = intake.lastSaved(binding)!
    expect(receipt).toEqual({
      id: receipt.id,
      project: dir,
      sessionID: "conversation",
      messageID: "first",
      receipt: "e".repeat(64),
    })
    expect(receipt.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new CaptureIntake(storage).lastSaved(binding)).toEqual(receipt)
    expect(intake.lastSaved()).toBeUndefined()
    expect(intake.lastSaved({ ...binding, root: path.join(dir, "other") })).toBeUndefined()
    expect(intake.lastSaved({ ...binding, release: "f".repeat(64) })).toBeUndefined()
    const skipped = { ...first, messageID: "skipped" }
    await intake.grant(skipped, binding, () => {})
    await intake.finish(skipped, "skipped")
    expect(intake.lastSaved(binding)).toEqual(receipt)
    const uncertain = { ...first, messageID: "uncertain" }
    await intake.grant(uncertain, binding, () => {})
    await intake.finish(uncertain, "uncertain")
    expect(intake.lastSaved(binding)).toEqual(receipt)
    expect(intake.snapshot(binding).status).toBe("uncertain")
    await storage.update("raya.secondBrain.personalCapture.confirmed", { id: receipt.id, receipt: "f".repeat(64) })
    expect(intake.lastSaved(binding)?.messageID).toBe("second")
  } finally {
    expect(path.dirname(dir)).toBe(tmpdir())
    await rm(dir, { recursive: true, force: true })
  }
})

test("pausing future capture preserves original consent fields and an in-flight save ledger", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-capture-pause-"))
  const file = path.join(dir, "state.json")
  const storage = {
    get<T>(key: string): T | undefined {
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))[key] : undefined
    },
    async update(key: string, value: unknown) {
      const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
      await Bun.write(file, JSON.stringify({ ...prior, [key]: value }))
    },
  }
  try {
    const intake = new CaptureIntake(storage)
    const binding = {
      root: path.join(dir, "notes"),
      release: "a".repeat(64),
      owner: "owner",
      generation: {},
      index: "synced" as const,
    }
    const cfg = {
      version: 1,
      enabled: true,
      root: binding.root,
      release: binding.release,
      zone: "America/Toronto",
      model: "local-selected",
      authorization: { source: "Original human preference", sha256: "b".repeat(64) },
    }
    await intake.save(cfg, binding)
    const controller = new AbortController()
    controller.abort()
    await expect(intake.pause(() => controller.signal.throwIfAborted())).rejects.toThrow()
    expect(intake.saved(binding)).toEqual(cfg)
    const turn = { project: dir, sessionID: "original", messageID: "message", source_sha256: "c".repeat(64) }
    expect(await intake.grant(turn, binding, () => {})).toBeDefined()
    await intake.begin(turn)
    const ledger = storage.get("raya.secondBrain.personalCapture.turns")
    expect(await intake.pause(() => {})).toBe(true)
    expect(intake.enabled()).toBe(false)
    expect(intake.saved(binding)).toEqual({ ...cfg, enabled: false })
    expect(intake.snapshot(binding).status).toBe("saving")
    expect(storage.get("raya.secondBrain.personalCapture.turns")).toEqual(ledger)
    expect(await intake.grant({ ...turn, messageID: "next" }, binding, () => {})).toBeUndefined()
    expect(await intake.pause(() => {})).toBe(false)
    intake.end(turn)
    expect(intake.snapshot(binding).status).toBe("uncertain")
    expect(storage.get("raya.secondBrain.personalCapture.turns")).toEqual(ledger)
  } finally {
    expect(path.dirname(dir)).toBe(tmpdir())
    await rm(dir, { recursive: true, force: true })
  }
})

test("runtime consent migration preserves human authorization and refuses unrelated roots/releases", () => {
  const previous = parse({
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v2",
    origin: "http://127.0.0.1:58741",
    root: "D:/Raya/SecondBrain",
    source_sha256: selected({
      ...release,
      "index.py": "dbbe3a56da1222956dc1d1d8a082e78a5920fc4ccef9275416f68e45c8795f8e",
    }),
  })
  const next = parse({ ...previous, source_sha256: release })
  const consent = {
    version: 1,
    enabled: true,
    root: previous.root,
    release: fingerprint(previous.source_sha256),
    zone: "America/Toronto",
    model: "pinned-local-model",
    authorization: {
      source: "Original human request",
      sha256: "a".repeat(64),
      original: { source: "Original setup", sha256: "b".repeat(64) },
    },
  }
  expect(migrate(consent, previous, next)).toEqual({ ...consent, release: fingerprint(release) })
  expect(consent.release).toBe(fingerprint(previous.source_sha256))
  expect(migrate(undefined, previous, next)).toBeUndefined()
  expect(() => migrate({ ...consent, root: "D:/Other" }, previous, next)).toThrow()
  expect(() => migrate({ ...consent, release: "c".repeat(64) }, previous, next)).toThrow()
  expect(() => migrate(consent, previous, parse({ ...next, root: "D:/Other" }))).toThrow()
})

test("an unresolved original save fences future grants across a source release upgrade", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-capture-upgrade-fence-"))
  const file = path.join(dir, "state.json")
  const storage = {
    get<T>(key: string): T | undefined {
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))[key] : undefined
    },
    async update(key: string, value: unknown) {
      const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
      await Bun.write(file, JSON.stringify({ ...prior, [key]: value }))
    },
  }
  try {
    const intake = new CaptureIntake(storage)
    const old = {
      root: path.join(dir, "notes"),
      release: "a".repeat(64),
      owner: "old-owner",
      generation: {},
      index: "synced" as const,
    }
    const current = { ...old, release: "b".repeat(64), owner: "current-owner", generation: {} }
    const consent = {
      version: 1,
      enabled: true,
      root: old.root,
      release: old.release,
      zone: "America/Toronto",
      model: "pinned-local-model",
      authorization: { source: "Original human authorization", sha256: "c".repeat(64) },
    }
    await intake.save(consent, old)
    const turn = { project: dir, sessionID: "original", messageID: "message", source_sha256: "d".repeat(64) }
    expect(await intake.grant(turn, old, () => {})).toBeDefined()
    await intake.begin(turn)
    intake.end(turn)
    const ledger = storage.get("raya.secondBrain.personalCapture.turns")
    await intake.save({ ...consent, release: current.release }, current)
    const cold = new CaptureIntake(storage)
    expect(cold.snapshot(current).status).toBe("uncertain")
    expect(await cold.grant({ ...turn, sessionID: "new" }, current, () => {})).toBeUndefined()
    expect(storage.get("raya.secondBrain.personalCapture.turns")).toEqual(ledger)
    await intake.finish(turn, "published", "e".repeat(64))
    expect(cold.snapshot(current).status).toBe("ready")
    expect(await cold.grant({ ...turn, sessionID: "new" }, current, () => {})).toBeDefined()
    expect(storage.get<Array<{ release: string }>>("raya.secondBrain.personalCapture.turns")![0].release).toBe(
      old.release,
    )
  } finally {
    expect(path.dirname(dir)).toBe(tmpdir())
    expect(path.basename(dir).startsWith("raya-capture-upgrade-fence-")).toBe(true)
    await rm(dir, { recursive: true })
  }
})

test("durable original capture grants bind consent, generation, source and local day without replay", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-capture-intake-"))
  const file = path.join(dir, "state.json")
  const storage = {
    get<T>(key: string): T | undefined {
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))[key] : undefined
    },
    async update(key: string, value: unknown) {
      const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
      await Bun.write(file, JSON.stringify({ ...prior, [key]: value }))
    },
  }
  try {
    const intake = new CaptureIntake(storage)
    const binding = {
      root: "D:/Raya/SecondBrain",
      release: "a".repeat(64),
      owner: "original-service",
      generation: {},
      index: "synced" as const,
    }
    const cfg = {
      version: 1,
      enabled: true,
      root: binding.root,
      release: binding.release,
      zone: "America/Toronto",
      model: "qwen-local/qwen3.5-4b-pinned:2a654d98e6fb",
      authorization: { source: "Original human automatic-capture request", sha256: "b".repeat(64) },
    }
    const packet = path.join(dir, "choices.json")
    const bytes = JSON.stringify(cfg, null, 2)
    await Bun.write(packet, bytes)
    const reviewed = await metadata(packet, (value, digest) => intake.reviewed(value, digest))
    expect(reviewed.authorization.source).toBe("kilo-code.new.memory.activateReviewedCapture")
    expect(reviewed.authorization.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(reviewed.authorization.original).toEqual(cfg.authorization)
    expect(() => intake.reviewed(reviewed, "d".repeat(64))).toThrow("original reviewed")
    const states: string[] = []
    const listener = intake.observe(() => states.push(intake.snapshot(binding).status))
    const source = {
      user: { id: "user", text: "I prefer warm lights." },
      assistant: { id: "reply", text: "I will remember that." },
      tools: [],
    }
    const observed = "2026-01-02T01:00:00.000Z"
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([observed, source.user.id, source.user.text, source.assistant.id, source.assistant.text, []]),
      )
      .digest("hex")
    const turn = { project: "C:/Work", sessionID: "session", messageID: "reply", source_sha256: fingerprint }
    expect(await intake.grant(turn, binding, () => {})).toBeUndefined()
    expect(intake.snapshot(binding).status).toBe("unavailable")
    await intake.save(cfg)
    expect(intake.snapshot(binding).status).toBe("ready")
    expect(intake.snapshot({ ...binding, index: "unchecked" }).status).toBe("unavailable")
    expect(await intake.grant(turn, { ...binding, index: "unchecked" }, () => {})).toBeUndefined()
    await expect(intake.save({ ...cfg, root: "D:/Other" }, binding)).rejects.toThrow("different reviewed")
    const grants = await Promise.all([intake.grant(turn, binding, () => {}), intake.grant(turn, binding, () => {})])
    expect(grants.filter(Boolean)).toHaveLength(1)
    const grant = grants.find(Boolean)!
    const saved = storage.get<Array<{ id: string }>>("raya.secondBrain.personalCapture.turns")!
    const command = {
      action: "capture" as const,
      id: saved[0].id,
      grant: grant.id,
      messageID: turn.messageID,
      observed_utc: observed,
      source_sha256: fingerprint,
      source,
      entries: [],
    }
    expect(() => intake.parse({ ...command, invented: true })).toThrow()
    expect(() =>
      intake.parse({
        ...command,
        source: { ...source, tools: [{ id: "tool", name: "read", status: "pretended", text: "success" }] },
      }),
    ).toThrow()
    await expect(intake.reviewReservation(command.id, "unused-while-granted")).rejects.toThrow("grant or activity")
    expect(storage.get("raya.secondBrain.captureReservation." + command.id)).toBeUndefined()
    const body = intake.consume(turn, command, binding, () => {})
    expect(body.day).toBe("2026-01-01")
    expect(body.entries).toEqual([])
    expect(() => intake.consume(turn, command, binding, () => {})).toThrow("one-use")
    await intake.finish(turn, "skipped")
    const reopened = new CaptureIntake(storage)
    expect(reopened.snapshot(binding).status).toBe("ready")
    expect(await reopened.grant(turn, binding, () => {})).toBeUndefined()
    expect(() => reopened.consume(turn, command, binding, () => {})).toThrow("one-use")
    await expect(reopened.finish(turn, "published", "c".repeat(64))).rejects.toThrow("cannot be replaced")

    const next = { ...turn, sessionID: "other" }
    const second = await intake.grant(next, binding, () => {})
    const ids = storage.get<Array<{ id: string }>>("raya.secondBrain.personalCapture.turns")!
    expect(() =>
      intake.consume(next, { ...command, id: ids[1].id, grant: second!.id }, { ...binding, generation: {} }, () => {}),
    ).toThrow("one-use")
    expect(await reopened.grant(next, binding, () => {})).toBeUndefined()
    expect(reopened.snapshot(binding).status).toBe("uncertain")
    expect(await intake.grant({ ...turn, sessionID: "blocked" }, binding, () => {})).toBeUndefined()
    // This controlled generation refusal has never dispatched transport; retain its terminal ID before more unit work.
    await intake.finish(next, "skipped")

    const writing = { ...turn, sessionID: "writing" }
    await intake.grant(writing, binding, () => {})
    const last = { ...turn, sessionID: "last" }
    const third = await intake.grant(last, binding, () => {})
    await intake.begin(writing)
    expect(intake.snapshot(binding).status).toBe("saving")
    expect(states.at(-1)).toBe("saving")
    expect(new CaptureIntake(storage).snapshot(binding).status).toBe("uncertain")
    intake.end(writing)
    expect(intake.snapshot(binding).status).toBe("uncertain")
    await expect(intake.finish(writing, "published")).rejects.toThrow("receipt required")
    await intake.finish(writing, "capacity", undefined, { stage: "authorization", errors: ["capture_source_capacity"] })
    const retained = storage.get<Array<{ stage: string; errors: string[] }>>(
      "raya.secondBrain.personalCapture.failures",
    )!
    expect(retained.at(-1)?.stage).toBe("authorization")
    expect(retained.at(-1)?.errors).toEqual(["capture_source_capacity"])
    const original = storage.get<Array<{ failure?: unknown }>>("raya.secondBrain.personalCapture.turns")!
    expect(original.at(-1)).not.toHaveProperty("failure")
    expect(intake.snapshot(binding)).toEqual({ status: "capacity", reason: "source_capacity" })
    expect(states.at(-1)).toBe("capacity")
    listener.dispose()

    await intake.save({ ...cfg, enabled: false })
    expect(intake.saved(binding)?.enabled).toBe(false)
    expect(() => intake.consume(last, { ...command, grant: third!.id }, binding, () => {})).toThrow("one-use")
    expect(await reopened.grant({ ...turn, sessionID: "disabled" }, binding, () => {})).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
