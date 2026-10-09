import { createHash } from "node:crypto"
import path from "node:path"
import { Result, Schema } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import { RayaChief } from "../chief"
import { MediaContext, MediaRecall } from "./media-protocol"

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

/** A media read may explain its qualified result; it never settles personal-note acquisition or goal work. */
export function settled(
  messages: readonly MessageV2.WithParts[],
  session: { id: string; directory: string; parentID?: string; metadata?: Record<string, unknown> },
  user: string,
) {
  if (session.parentID || RayaChief.phase(session.metadata) !== "route") return false
  const current = messages.findLast((row) => row.info.role === "user")
  if (!current || current.info.id !== user || current.info.sessionID !== session.id) return false
  if (
    current.info.role !== "user" ||
    current.info.format?.type === "json_schema" ||
    current.parts.some((part) => part.type !== "text")
  )
    return false
  const request = RayaChief.requestText(current.parts)
  const text = request.replace(
    /[.!?]\s*(?:do not|don't)\s+change (?:anything|files|lights)(?: or (?:files|lights))?[.!]?$/i,
    "",
  )
  if (
    request !== RayaChief.request(session.metadata) ||
    request.length > 1000 ||
    !/\b(?:images?|photos?|pictures?|audio|recordings?|videos?|clips?|multimedia)\b/i.test(text)
  )
    return false
  if (
    !/^(?:what|which|where|when|how|did|do|does|is|are|have|has|describe|find|search|recall|show me|can you (?:describe|find|search))\b/i.test(
      text,
    )
  )
    return false
  if (!/^[^.!?;`]+[.?]?(?:\s+Cite (?:the |my |original )?sources[.!]?)?$/i.test(text)) return false
  if (
    /\b(?:then|also|now|install|implement|fix|deploy|delete|forget|save|capture|create|edit|update|send|upload|download|purchase|buy|order|place|pay|checkout|transfer|book|make|call|contact|execute|run|build|commit|push|merge|schedule|start|stop|change|configure|control|apply|revert|undo|redo|launch|activate)\b/i.test(
      text,
    )
  )
    return false
  return messages.some(
    (row) =>
      row.info.role === "assistant" &&
      row.info.parentID === user &&
      row.info.sessionID === session.id &&
      !row.info.error &&
      !row.info.summary &&
      row.parts.some((part) => {
        if (
          part.type !== "tool" ||
          part.tool !== "second_brain_media_recall" ||
          part.messageID !== row.info.id ||
          part.sessionID !== session.id ||
          part.state.status !== "completed"
        )
          return false
        if (Object.keys(part.state.input).some((key) => key !== "query" && key !== "top")) return false
        const input = Schema.decodeUnknownResult(MediaRecall, { onExcessProperty: "error" })({
          action: "mediaContext",
          ...part.state.input,
          top: part.state.input.top ?? 5,
        })
        if (Result.isFailure(input)) return false
        const command = input.success
        if (Buffer.byteLength(command.query, "utf8") > 2048 || Buffer.byteLength(part.state.output, "utf8") > 200000)
          return false
        const value = (() => {
          try {
            return JSON.parse(part.state.output) as unknown
          } catch {
            return undefined
          }
        })()
        const decoded = Schema.decodeUnknownResult(MediaContext, { onExcessProperty: "error" })(value)
        if (Result.isFailure(decoded)) return false
        const context = decoded.success
        if (
          context.project !== session.directory ||
          context.query_sha256 !== hash(command.query) ||
          context.candidates.length > command.top ||
          !path.isAbsolute(context.selection.root)
        )
          return false
        return context.candidates.every(
          (candidate) =>
            candidate.query_sha256 === context.query_sha256 &&
            candidate.policy_sha256 === context.selection.policy_sha256 &&
            candidate.source.id === candidate.source.sha256 &&
            path.isAbsolute(candidate.source.path) &&
            !candidate.source.relative
              .split("/")
              .some((part) => !part || [".", ".."].includes(part) || /[\\<>:"|?*\x00-\x1f]/.test(part)) &&
            path.resolve(context.selection.root, candidate.source.relative) === path.resolve(candidate.source.path) &&
            (candidate.span === null || candidate.span.end_ms > candidate.span.start_ms) &&
            (candidate.source.kind !== "image" || candidate.span === null) &&
            (candidate.verdict !== "supported" ||
              (candidate.verifier !== null &&
                candidate.evidence.length > 0 &&
                (candidate.source.kind === "image" || candidate.span !== null))) &&
            candidate.evidence.every(
              (evidence) =>
                evidence.sha256 === hash(evidence.text) &&
                (candidate.span === null
                  ? evidence.span === null
                  : evidence.span !== null &&
                    evidence.span.start_ms === candidate.span.start_ms &&
                    evidence.span.end_ms === candidate.span.end_ms),
            ),
        )
      }),
  )
}
