import { createHash } from "node:crypto"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RayaGoal } from "@/kilocode/goal"
import type { RayaTask } from "."
import { whole } from "@/kilocode/goal/read-artifact"
import { final } from "./final-report"

type Contract = { kind: "file"; path: string; bytes: number; sha256: string }
type Source = {
  messageID: SessionV1.ToolPart["messageID"]
  partID: SessionV1.ToolPart["id"]
  callID: string
  path: string
  canonical: string
  bytes: number
  sha256: string
}
const normalized = (file: string) =>
  process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)

/** Verify the original delivered bytes; work-audit prose never supplies this authority. */
export const verify = (
  contract: Contract,
  run: RayaTask.Run,
  goal: RayaGoal.State,
  rows: readonly SessionV1.WithParts[],
  candidate: NonNullable<ReturnType<typeof final>>,
) =>
  Effect.gen(function* () {
    const bytes = Buffer.from(candidate.summary, "utf8")
    const result = (status: "passed" | "mismatch" | "unavailable", reason: string, source?: Source) => ({
      version: 1 as const,
      status,
      reason,
      at: Date.now(),
      contract,
      ...(source ? { source } : {}),
      final: {
        messageID: candidate.report.messageID,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
    })
    if (
      contract.kind !== "file" ||
      !path.isAbsolute(contract.path) ||
      contract.path.length > 4096 ||
      !Number.isSafeInteger(contract.bytes) ||
      contract.bytes < 0 ||
      contract.bytes > 8192 ||
      !/^[a-f0-9]{64}$/.test(contract.sha256)
    )
      return result("unavailable", "contract-invalid")
    const answer = final(run, goal, rows, true, true)
    if (!answer || !isDeepStrictEqual(answer, candidate)) return result("unavailable", "final-unbound")
    if (!candidate.report.partIDs.length) return result("unavailable", "final-missing")
    if (bytes.toString("utf8") !== candidate.summary) return result("unavailable", "final-encoding")
    if (!run.trace || run.trace.goalCreatedAt !== goal.createdAt) return result("unavailable", "read-unavailable")
    for (const turn of run.trace.turns) {
      const user = rows.find((row) => row.info.id === turn.turnID)
      if (user?.info.role !== "user" || user.info.sessionID !== run.sessionID || !goal.inputs?.includes(user.info.id))
        continue
      for (const traced of turn.messages) {
        const row = rows.find((row) => row.info.id === traced.messageID)
        if (
          row?.info.role !== "assistant" ||
          row.info.sessionID !== run.sessionID ||
          row.info.parentID !== user.info.id ||
          row.info.error ||
          row.info.time.created < goal.createdAt ||
          row.info.time.created < user.info.time.created ||
          row.info.time.completed === undefined ||
          row.info.time.completed > candidate.report.at
        )
          continue
        for (const part of row.parts) {
          if (
            part.type !== "tool" ||
            part.tool !== "read" ||
            part.sessionID !== run.sessionID ||
            part.messageID !== row.info.id ||
            part.state.status !== "completed" ||
            !traced.actions.some((action) => action.actionID === part.id && action.status === "completed") ||
            !Number.isFinite(part.state.time.start) ||
            !Number.isFinite(part.state.time.end) ||
            part.state.time.start < row.info.time.created ||
            part.state.time.end < part.state.time.start ||
            part.state.time.end > row.info.time.completed ||
            part.state.time.start < goal.createdAt ||
            part.state.time.end > candidate.report.at ||
            typeof part.state.input.filePath !== "string"
          )
            continue
          const content = yield* whole(part.state.metadata)
          if (
            !content ||
            normalized(content.canonical) !== normalized(contract.path) ||
            !path.isAbsolute(content.path) ||
            normalized(path.resolve(row.info.path.cwd, part.state.input.filePath)) !== normalized(content.path) ||
            content.bytes !== contract.bytes ||
            content.sha256 !== contract.sha256
          )
            continue
          const source = {
            messageID: row.info.id,
            partID: part.id,
            callID: part.callID,
            path: content.path,
            canonical: content.canonical,
            bytes: content.bytes,
            sha256: content.sha256,
          }
          return bytes.length === contract.bytes && createHash("sha256").update(bytes).digest("hex") === contract.sha256
            ? result("passed", "verified", source)
            : result("mismatch", "final-mismatch", source)
        }
      }
    }
    return result("unavailable", "read-unavailable")
  })
