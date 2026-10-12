import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"
import { ManageSource, Manage, ManageResult } from "./management-protocol"

function restricted(text: string) {
  return (
    MemoryRedact.has(text) ||
    MemoryRedact.text(text) !== text ||
    /\b(?:password|passphrase|api[- ]?key|access[- ]?token|secret)\s*(?:is|=|:)\s*\S/i.test(text)
  )
}

export function digest(value: Omit<ManageSource, "source_sha256">) {
  return createHash("sha256")
    .update(JSON.stringify([value.sessionID, value.messageID, value.created_utc, value.text]))
    .digest("hex")
}

/** Project only the exact current user message, without requiring a completed assistant reply. */
export function current(
  messages: readonly MessageV2.WithParts[],
  session: { id: string; parentID?: string },
  user: string,
): ManageSource | undefined {
  if (session.parentID) return undefined
  const row = messages.findLast((row) => row.info.role === "user")
  if (!row || row.info.role !== "user" || row.info.id !== user || row.info.sessionID !== session.id) return undefined
  if (messages.filter((entry) => entry.info.id === user).length !== 1) return undefined
  if (row.info.format?.type === "json_schema") return undefined
  if (row.parts.some((part) => part.type !== "text")) return undefined
  const created = row.info.time.created
  if (!Number.isSafeInteger(created) || created < 0 || created > 8640000000000000) return undefined
  const parts = row.parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
  if (!parts.length || parts.some((part) => part.sessionID !== session.id || part.messageID !== user)) return undefined
  if (new Set(parts.map((part) => part.id)).size !== parts.length) return undefined
  const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n\n")
  // Reject secrets rather than changing offsets or hashing a redacted version of the original request.
  if (restricted(text) || Buffer.byteLength(text, "utf8") > 24000) return undefined
  const source = { sessionID: session.id, messageID: user, created_utc: new Date(created).toISOString(), text }
  const value = { ...source, source_sha256: digest(source) }
  return Schema.is(ManageSource)(value) ? value : undefined
}

function boundary(text: string, index: number) {
  if (index === 0 || index === text.length) return true
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}

export function valid(command: Manage) {
  if (!Schema.is(Manage)(command)) return false
  const source = command.source
  const date = new Date(source.created_utc)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== source.created_utc) return false
  if (
    digest(source) !== source.source_sha256 ||
    Buffer.byteLength(source.text, "utf8") > 24000 ||
    restricted(source.text)
  )
    return false
  const span = command.fact
  if (command.mode === "forget") return span === undefined && Boolean(command.query)
  return (
    span !== undefined &&
    span.start < span.end &&
    span.end <= source.text.length &&
    boundary(source.text, span.start) &&
    boundary(source.text, span.end) &&
    Boolean(source.text.slice(span.start, span.end).trim()) &&
    (command.mode !== "correct" || Boolean(command.query))
  )
}

export function result(command: Manage, value: ManageResult) {
  if (!Schema.is(ManageResult)(value)) return false
  if (
    value.operation !== command.operation ||
    value.mode !== command.mode ||
    value.sessionID !== command.source.sessionID ||
    value.messageID !== command.source.messageID ||
    value.source_sha256 !== command.source.source_sha256
  )
    return false
  if (value.disposition === "published" || value.disposition === "indexed") {
    if (!value.publication_confirmed || !value.changes.length) return false
  } else if (value.publication_confirmed || value.index_confirmed || value.changes.length) return false
  if (value.index_confirmed !== (value.disposition === "indexed")) return false
  const names = new Set<string>()
  for (const change of value.changes) {
    const name = change.relative.toLowerCase()
    const parts = name.split("/")
    if (
      !/^(daily|preferences|projects|areas|commitments|decisions)\/.+\.md$/.test(name) ||
      names.has(name) ||
      parts.some(
        (part) =>
          !part ||
          [".", ".."].includes(part) ||
          /[\\<>:"|?*\x00-\x1f]/.test(part) ||
          /[. ]$/.test(part) ||
          ["system", "archive", ".git", "health", "medical", "private", "sensitive"].includes(
            part.replace(/\.md$/, ""),
          ),
      ) ||
      (command.mode !== "forget" && change.note_sha256 === null)
    )
      return false
    names.add(name)
  }
  return true
}
