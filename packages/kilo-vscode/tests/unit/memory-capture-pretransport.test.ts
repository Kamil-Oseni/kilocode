import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { CaptureIntake, records } from "../../src/second-brain/capture-intake"

const ledger = "raya.secondBrain.personalCapture.turns"
async function fixture(fault?: "prepared" | "ledger" | "applied") {
  const dir = await mkdtemp(path.join(tmpdir(), "raya-pretransport-test-"))
  const file = path.join(dir, "state.json")
  await writeFile(file, "{}")
  const storage = {
    get<T>(key: string) {
      return JSON.parse(readFileSync(file, "utf8"))[key] as T | undefined
    },
    async update(key: string, value: unknown) {
      if (
        (fault === "ledger" && key === ledger && records(value).some((row) => row.phase === "skipped")) ||
        (key.startsWith("raya.secondBrain.captureExtractionFailure.") &&
          value &&
          typeof value === "object" &&
          "phase" in value &&
          value.phase === fault)
      )
        throw new Error(`controlled ${fault} storage failure`)
      const state = JSON.parse(await readFile(file, "utf8"))
      state[key] = value
      await writeFile(file, JSON.stringify(state))
    },
  }
  const binding = {
    root: "D:/IsolatedUnitNotes",
    release: "a".repeat(64),
    owner: "unit-owner",
    generation: {},
    index: "synced" as const,
  }
  const intake = new CaptureIntake(storage)
  await intake.save({
    version: 1,
    enabled: true,
    root: binding.root,
    release: binding.release,
    model: "unit/model",
    zone: "America/Toronto",
    authorization: { source: "isolated unit authorization", sha256: "b".repeat(64) },
  })
  const turn = {
    project: "C:/IsolatedUnitProject",
    sessionID: "unit_session",
    messageID: "unit_reply",
    source_sha256: "c".repeat(64),
  }
  const grant = await intake.grant(turn, binding, () => {})
  if (!grant) throw new Error("Actual intake grant required")
  const original = records(storage.get(ledger))[0]
  const command = {
    action: "captureFailed",
    id: original.id,
    grant: grant.id,
    messageID: turn.messageID,
    source_sha256: turn.source_sha256,
    reason: "duplicate_key",
  }
  const cleanup = async () => {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(tmpdir()))
    expect(path.basename(dir).startsWith("raya-pretransport-test-")).toBe(true)
    await rm(dir, { recursive: true })
  }
  return { storage, intake, binding, turn, command, original, cleanup }
}

test("exact original unused grant closes failed extraction without receipt, replay or transport", async () => {
  const f = await fixture()
  try {
    const audit = await f.intake.fail(f.turn, f.command, (binding) => expect(binding).toBe(f.binding))
    expect(audit.phase).toBe("applied")
    expect(audit.original).toEqual(f.original)
    expect(audit.completed).toEqual({ ...f.original, phase: "skipped" })
    expect(audit.reason).toBe("duplicate_key")
    expect(audit.requestSettlement).toBe(false)
    expect(audit.indexConfirmed).toBe(false)
    expect(audit.replay).toBe(false)
    expect(audit).not.toHaveProperty("grant")
    expect(audit.completed).not.toHaveProperty("receipt")
    expect(records(f.storage.get(ledger))).toEqual([audit.completed])
    expect(f.intake.snapshot(f.binding).status).toBe("ready")
    expect(await f.intake.grant(f.turn, f.binding, () => {})).toBeUndefined()
    await expect(f.intake.fail(f.turn, f.command, () => {})).rejects.toThrow("unconsumed")
    await expect(new CaptureIntake(f.storage).fail(f.turn, f.command, () => {})).rejects.toThrow("unconsumed")
  } finally {
    await f.cleanup()
  }
})

test("unknown, mismatched, consumed, unsafe or caller-extended dispositions are refused", async () => {
  const f = await fixture()
  try {
    for (const patch of [
      { grant: randomUUID() },
      { id: randomUUID() },
      { source_sha256: "d".repeat(64) },
      { messageID: "other" },
    ])
      await expect(f.intake.fail(f.turn, { ...f.command, ...patch }, () => {})).rejects.toThrow("original")
    expect(() => f.intake.fail(f.turn, { ...f.command, reason: "plaintext arbitrary error" }, () => {})).toThrow()
    expect(() => f.intake.fail(f.turn, { ...f.command, saved: true }, () => {})).toThrow()
    await expect(f.intake.fail({ ...f.turn, project: "C:/Other" }, f.command, () => {})).rejects.toThrow()
    await expect(
      f.intake.fail(f.turn, f.command, () => {
        throw new Error("current owner changed")
      }),
    ).rejects.toThrow("owner changed")
    await f.storage.update("raya.secondBrain.control.uncertainty", { original: "unknown" })
    await expect(f.intake.fail(f.turn, f.command, () => {})).rejects.toThrow("debt changed")
    expect(records(f.storage.get(ledger))).toEqual([f.original])
    expect(f.storage.get(`raya.secondBrain.captureExtractionFailure.${f.command.id}`)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

test("every disposition write fault preserves uncertainty across reopen and fences its grant", async () => {
  for (const fault of ["prepared", "ledger", "applied"] as const) {
    const f = await fixture(fault)
    try {
      await expect(f.intake.fail(f.turn, f.command, () => {})).rejects.toThrow(`controlled ${fault}`)
      expect(f.intake.snapshot(f.binding).status).toBe("uncertain")
      const reopened = new CaptureIntake(f.storage)
      expect(reopened.snapshot(f.binding).status).toBe("uncertain")
      expect(await reopened.grant({ ...f.turn, messageID: "future_reply" }, f.binding, () => {})).toBeUndefined()
      await expect(reopened.fail(f.turn, f.command, () => {})).rejects.toThrow("unconsumed")
      expect(() =>
        f.intake.consume(
          f.turn,
          {
            action: "capture",
            id: f.command.id,
            grant: f.command.grant,
            messageID: f.turn.messageID,
            source_sha256: f.turn.source_sha256,
            observed_utc: "2026-01-01T00:00:00.000Z",
            source: {
              user: { id: "unit_user", text: "Unit source." },
              assistant: { id: f.turn.messageID, text: "Unit reply." },
              tools: [],
            },
            entries: [],
          },
          f.binding,
          () => {},
        ),
      ).toThrow("fenced")
      expect(records(f.storage.get(ledger))[0].phase).toBe(fault === "applied" ? "skipped" : "reserved")
      const audit = f.storage.get<{ phase: string }>(`raya.secondBrain.captureExtractionFailure.${f.command.id}`)
      expect(audit?.phase).toBe(fault === "prepared" ? undefined : "prepared")
    } finally {
      await f.cleanup()
    }
  }
})
