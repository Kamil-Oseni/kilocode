import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CaptureIntake } from "../../src/second-brain/capture-intake"
import { metadata } from "../../src/second-brain/manifest"

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

    const writing = { ...turn, sessionID: "writing" }
    await intake.grant(writing, binding, () => {})
    await intake.begin(writing)
    expect(intake.snapshot(binding).status).toBe("saving")
    expect(states.at(-1)).toBe("saving")
    expect(new CaptureIntake(storage).snapshot(binding).status).toBe("uncertain")
    intake.end(writing)
    expect(intake.snapshot(binding).status).toBe("uncertain")
    await expect(intake.finish(writing, "published")).rejects.toThrow("receipt required")
    await intake.finish(writing, "capacity")
    expect(intake.snapshot(binding)).toEqual({ status: "capacity", reason: "source_capacity" })
    expect(states.at(-1)).toBe("capacity")
    listener.dispose()

    const last = { ...turn, sessionID: "last" }
    const third = await intake.grant(last, binding, () => {})
    await intake.save({ ...cfg, enabled: false })
    expect(intake.saved(binding)?.enabled).toBe(false)
    expect(() => intake.consume(last, { ...command, grant: third!.id }, binding, () => {})).toThrow("one-use")
    expect(await reopened.grant({ ...turn, sessionID: "disabled" }, binding, () => {})).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
