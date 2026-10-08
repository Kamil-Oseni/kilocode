import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CaptureIntake } from "../../src/second-brain/capture-intake"

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
    const binding = { root: "D:/Raya/SecondBrain", release: "a".repeat(64), owner: "original-service", generation: {} }
    const cfg = {
      version: 1,
      enabled: true,
      root: binding.root,
      release: binding.release,
      zone: "America/Toronto",
      model: "qwen-local/qwen3.5-4b-pinned:2a654d98e6fb",
      authorization: { source: "Original human automatic-capture request", sha256: "b".repeat(64) },
    }
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
    await intake.save(cfg)
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

    const last = { ...turn, sessionID: "last" }
    const third = await intake.grant(last, binding, () => {})
    await intake.save({ ...cfg, enabled: false })
    expect(() => intake.consume(last, { ...command, grant: third!.id }, binding, () => {})).toThrow("one-use")
    expect(await reopened.grant({ ...turn, sessionID: "disabled" }, binding, () => {})).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
