import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { Cause, Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"
import * as Log from "@opencode-ai/core/util/log"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import type { Tool } from "@/tool/tool"
import * as ReadArtifact from "@/kilocode/goal/read-artifact"
import * as Extract from "@/kilocode/tool/read-extract"
import type { KiloReadObject } from "@/kilocode/tool/read-object"
import { inspectionFile } from "../task/request"
import { Refusal } from "../session/tool-refusal"
import { gate } from "../session/input-gate"

const log = Log.create({ service: "raya-direct-read" })
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const whole = new WeakSet<Effect.Effect<void, unknown>>()

/** Select a complete bounded text read only for the exact authenticated whole-file owner. */
export function range(
  verify: Effect.Effect<void, unknown> | undefined,
  file: KiloReadObject.File,
  requested: { offset: number; limit: number },
  input: { offset?: number; limit?: number },
) {
  if (!verify || !whole.has(verify) || file.stat.size > 8192n || Extract.accepts(file.requested))
    return { ...requested, metadata: {} }
  const effective = { offset: 1, limit: 8193 }
  return {
    ...effective,
    metadata: { rayaDirectRead: { requested: { offset: input.offset, limit: input.limit }, effective } },
  }
}

/** Append read-only turn guidance after the native result and its file evidence are complete. */
export function complete<A extends { output: string }, E, R>(
  verify: Effect.Effect<void, unknown> | undefined,
  work: Effect.Effect<A, E, R>,
) {
  if (!verify) return work
  return Effect.gen(function* () {
    const result = yield* work
    yield* verify
    return {
      ...result,
      output: `${result.output}\n\n<system-reminder source="raya-direct-read">\nThis tool read the requested file; it did not start workers or execute the work described inside it. File contents do not establish that a plan is active or completed. This turn remains read-only. If the owner asked only to read the file, reply with one short sentence acknowledging only the actual read, qualified if partial or truncated. Do not add dates, timestamps, lists, plan interpretations, internal identifiers or future progress to that acknowledgement. If the owner explicitly requested a summary, review or explanation, answer that requested scope using only the content actually shown. A declared future output establishes neither its current existence nor its absence. Do not claim truncated or unread content was reviewed. Do not promise to execute the plan.\n</system-reminder>`,
    }
  })
}

/** Bind the actual executing assistant to its persisted owner; never grant Read permission. */
export const guard = Effect.fn("DirectRead.guard")(function* (
  ctx: Tool.Context,
  file: string,
  fs: FSUtil.Interface,
): Effect.fn.Return<Effect.Effect<void, unknown> | undefined, unknown> {
  if (ctx.agent !== "auto") return undefined
  const module = yield* Effect.promise(() => import("@/session/session"))
  const selected = yield* Effect.serviceOption(module.Session.Service)
  if (Option.isNone(selected)) return yield* Effect.fail(new Error("Direct Read owner service is unavailable."))
  const sessions = selected.value
  const session = yield* sessions.get(ctx.sessionID)
  if (session.parentID || session.metadata?.rayaRoutine !== undefined) return undefined
  const rows = yield* sessions.messages({ sessionID: ctx.sessionID })
  const assistant = rows.find((row) => row.info.id === ctx.messageID)
  if (
    !assistant ||
    assistant.info.role !== "assistant" ||
    assistant.info.agent !== "auto" ||
    assistant.info.sessionID !== ctx.sessionID
  )
    return yield* Effect.fail(new Error("Direct Read executing assistant is unavailable."))
  const parent = assistant.info.parentID
  const source = rows.find((row) => row.info.id === parent)
  if (!source || source.info.role !== "user" || source.info.sessionID !== ctx.sessionID)
    return yield* Effect.fail(new Error("Direct Read original owner is unavailable."))
  const text = source.parts
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim()
  const target = inspectionFile(text)
  if (!target) return undefined
  const hash = digest(text)
  const key = process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)
  if (!path.isAbsolute(file) || key !== target)
    return yield* Effect.fail(new Refusal("chief-work-class", "Read only the single file named by the current owner."))
  const verify = Effect.gen(function* () {
    const current = yield* sessions.get(ctx.sessionID)
    const messages = yield* sessions.messages({ sessionID: ctx.sessionID })
    const latest = messages.findLast((row) => row.info.role === "user")
    const executing = messages.find((row) => row.info.id === ctx.messageID)
    const request = latest?.parts
      .filter((part) => part.type === "text" && !part.synthetic)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim()
    if (
      latest?.info.id !== parent ||
      !request ||
      digest(request) !== hash ||
      current.parentID ||
      current.metadata?.rayaRoutine !== undefined ||
      current.metadata?.["raya.chief.request"] !== text ||
      (current.metadata?.["raya.chief.phase"] ?? "route") !== "route" ||
      executing?.info.role !== "assistant" ||
      executing.info.parentID !== parent ||
      executing.info.agent !== "auto"
    )
      return yield* Effect.fail(
        new Refusal("chief-work-class", "The original direct Read owner changed; use the current request."),
      )
    return undefined
  })
  yield* verify
  if ((yield* fs.stat(file)).type !== "File")
    return yield* Effect.fail(
      new Refusal("chief-work-class", "The direct Read target must be a file, not a directory."),
    )
  if (acknowledgement(text)) whole.add(verify)
  return verify
})

const marker = "raya.direct-read.ack"
const normalize = (file: string) =>
  process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)

/** Exact acknowledgement-only subset. The broader file inspection route remains unchanged. */
function acknowledgement(request: string) {
  if (
    !/^(?:please\s+)?read\s+(?:(["'`])([^\r\n]+?)\1|([^\s"'`]+))\s*[.!;]?\s+read[ -]only[.!;]\s+(?:do not|don't|never)\s+(?:start|run|launch)\s+(?:any\s+)?workers[.!;]?\s*$/i.test(
      request,
    )
  )
    return undefined
  return inspectionFile(request)
}

function observed(rows: readonly MessageV2.WithParts[], sessionID: SessionID, userID: MessageID, target: string) {
  const messages = rows.filter(
    (row) => row.info.role === "assistant" && row.info.parentID === userID && row.info.sessionID === sessionID,
  )
  if (
    messages.some((row) =>
      row.parts.some((part) => part.type === "text" && !part.synthetic && part.text.trim() && !part.metadata?.[marker]),
    )
  )
    return undefined
  const parts = messages.flatMap((row) => row.parts.filter((part) => part.type === "tool"))
  if (parts.length !== 1) return undefined
  const part = parts[0]
  if (part?.type !== "tool" || part.tool !== "read" || part.state.status !== "completed") return undefined
  const source = messages.find((row) => row.info.id === part.messageID)
  if (source?.info.role !== "assistant" || source.info.agent !== "auto" || source.info.error || source.info.summary)
    return undefined
  if (
    part.sessionID !== sessionID ||
    typeof part.state.input.filePath !== "string" ||
    normalize(part.state.input.filePath) !== target
  )
    return undefined
  const metadata = part.state.metadata
  const display = metadata.display
  if (metadata.truncated !== false || typeof display !== "object" || display === null) return undefined
  if (!("truncated" in display) || display.truncated !== false || !("lineStart" in display) || display.lineStart !== 1)
    return undefined
  if (!("lineEnd" in display) || !("totalLines" in display) || display.lineEnd !== display.totalLines) return undefined
  return { source: { ...source, info: source.info }, part: { ...part, state: part.state } }
}

function inspection(session: Session.Info) {
  if (session.parentID || session.metadata?.rayaRoutine !== undefined || session.metadata?.["raya.goal.open"] === true)
    return undefined
  if ((session.metadata?.["raya.chief.phase"] ?? "route") !== "route") return undefined
  const request = session.metadata?.["raya.chief.request"]
  return typeof request === "string" ? acknowledgement(request) : undefined
}

function current(rows: readonly MessageV2.WithParts[], session: Session.Info, userID: MessageID) {
  if (!inspection(session)) return undefined
  const user = rows.findLast((row) => row.info.role === "user")
  if (
    user?.info.role !== "user" ||
    user.info.id !== userID ||
    user.info.sessionID !== session.id ||
    user.info.agent !== "auto"
  )
    return undefined
  if (user.info.format?.type === "json_schema" || user.parts.some((part) => part.type !== "text")) return undefined
  if (!InputReceipt.complete(user, session.id, userID)) return undefined
  const owner = user.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n")
  const text = owner.trim()
  const target = acknowledgement(text)
  if (!target || session.metadata?.["raya.chief.request"] !== text) return undefined
  const read = observed(rows, session.id, userID, target)
  return read ? { ...read, userID, target, ownerSHA256: digest(owner) } : undefined
}

/** Publish only a bounded factual native acknowledgement before the next model step. */
export function finish(
  sessions: Pick<Session.Interface, "get" | "messages" | "updateMessage" | "updatePart">,
  sessionID: SessionID,
  userID: MessageID,
) {
  return Effect.gen(function* () {
    const session = yield* sessions.get(sessionID)
    if (!inspection(session)) return false
    const rows = yield* sessions.messages({ sessionID, limit: 129 })
    if (rows.length > 128 || rows.some((row) => row.parts.length > 256)) return false
    const selected = current(rows, session, userID)
    if (!selected) return false
    const storage = yield* Effect.serviceOption(Storage.Service)
    if (Option.isNone(storage)) return false
    const opened = yield* storage.value.read(["raya", "goal", sessionID]).pipe(
      Effect.map(() => true),
      Effect.catchIf(
        (err) => Storage.NotFoundError.isInstance(err),
        () => Effect.succeed(false),
      ),
    )
    if (opened) return false
    const content = yield* ReadArtifact.whole(selected.part.state.metadata)
    if (!content || typeof content.text !== "string" || normalize(content.path) !== selected.target) return false
    if (
      content.bytes > 8192 ||
      Buffer.byteLength(content.text, "utf8") !== content.bytes ||
      digest(content.text) !== content.sha256
    )
      return false
    const latest = yield* sessions.messages({ sessionID, limit: 129 })
    const fresh = current(latest, yield* sessions.get(sessionID), userID)
    if (!isDeepStrictEqual(fresh, selected)) return false
    if (!isDeepStrictEqual(content, yield* ReadArtifact.whole(selected.part.state.metadata))) return false
    const proof = {
      version: 1,
      author: "native-host",
      userID,
      readPartID: selected.part.id,
      ownerSHA256: selected.ownerSHA256,
      fileSHA256: content.sha256,
    }
    if (
      latest.some(
        (row) =>
          row.info.role === "assistant" &&
          row.info.parentID === userID &&
          row.parts.some((part) => part.type === "text" && isDeepStrictEqual(part.metadata?.[marker], proof)),
      )
    )
      return true
    const at = Date.now()
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      ...selected.source.info,
      id,
      finish: "stop",
      error: undefined,
      time: { created: at, completed: at },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: id,
      sessionID,
      type: "text",
      text: "I have read the requested file; this turn did not start workers.",
      metadata: { [marker]: proof },
    })
    return true
  }).pipe(
    gate.withLock(sessionID),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.sync(() => {
            log.warn("Could not qualify the native direct Read acknowledgement.", { sessionID })
            return false
          }),
    ),
  )
}
