import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { current, valid as source } from "@/kilocode/second-brain/management-source"
import { Manage, type ManageResult } from "@/kilocode/second-brain/management-protocol"
import { RequestID } from "@/kilocode/second-brain/protocol"
import { valid } from "@/kilocode/second-brain/reply"

const sid = SessionID.make("ses_manage")
const uid = MessageID.make("msg_manage")
const text = "Remember that I prefer tea ☕ and calm evenings."

function fixture(): MessageV2.WithParts {
  return {
    info: {
      id: uid,
      sessionID: sid,
      role: "user",
      time: { created: Date.parse("2026-10-12T01:30:00Z") },
      agent: "auto",
      model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") },
    },
    parts: [{ id: PartID.make("prt_manage"), sessionID: sid, messageID: uid, type: "text", text }],
  }
}

function command(): Manage {
  const original = current([fixture()], { id: sid }, uid)
  if (!original) throw new Error("Actual current-user source required")
  return {
    action: "manage",
    stage: "inspect",
    mode: "remember",
    operation: "b43ff5f0-6049-4009-905a-7649022ee5b7",
    source: original,
    fact: { start: text.indexOf("I prefer"), end: text.length },
  }
}

test("current-user projection accepts structural SDK rows and refuses missing text", () => {
  const row = {
    info: { id: "msg_sdk", sessionID: "ses_sdk", role: "user", time: { created: 1791768600000 } },
    parts: [{ id: "prt_sdk", sessionID: "ses_sdk", messageID: "msg_sdk", type: "text", text }],
  }
  expect(current([row], { id: "ses_sdk" }, "msg_sdk")).toMatchObject({
    sessionID: "ses_sdk",
    messageID: "msg_sdk",
    text,
  })
  expect(
    current([{ ...row, parts: [{ ...row.parts[0], text: undefined }] }], { id: "ses_sdk" }, "msg_sdk"),
  ).toBeUndefined()
})

test("current-user projection needs no assistant completion and preserves exact original bytes and ownership", () => {
  const row = fixture()
  const original = current([row], { id: sid }, uid)
  expect(original).toMatchObject({ sessionID: sid, messageID: uid, text, created_utc: "2026-10-12T01:30:00.000Z" })
  expect(source(command())).toBe(true)
  expect(current([row], { id: "other" }, uid)).toBeUndefined()
  expect(current([row], { id: sid, parentID: "parent" }, uid)).toBeUndefined()
  expect(
    current([row, { ...row, info: { ...row.info, id: MessageID.make("msg_next") } }], { id: sid }, uid),
  ).toBeUndefined()
  expect(current([row, row], { id: sid }, uid)).toBeUndefined()
  const whitespace = fixture()
  if (whitespace.parts[0].type !== "text") throw new Error("Text fixture required")
  whitespace.parts[0].text = "  Remember that I prefer tea.\n"
  expect(current([whitespace], { id: sid }, uid)?.text).toBe(whitespace.parts[0].text)
})

test("synthetic, ignored, foreign, attached and secret sources do not authorize a personal change", () => {
  for (const change of ["synthetic", "ignored", "foreign", "attached", "secret", "oversized", "structured"] as const) {
    const row = fixture()
    const part = row.parts[0]
    if (part.type !== "text" || row.info.role !== "user") throw new Error("User text fixture required")
    if (change === "synthetic") part.synthetic = true
    if (change === "ignored") part.ignored = true
    if (change === "foreign") part.messageID = MessageID.make("msg_foreign")
    if (change === "attached")
      row.parts.push({
        id: PartID.make("prt_file"),
        sessionID: sid,
        messageID: uid,
        type: "file",
        mime: "text/plain",
        url: "file:///untrusted.txt",
      })
    if (change === "secret") part.text = "Remember my password is example-secret-123."
    if (change === "oversized") part.text = "📝".repeat(7000)
    if (change === "structured") row.info.format = { type: "json_schema", schema: {}, retryCount: 1 }
    expect(current([row], { id: sid }, uid)).toBeUndefined()
  }
})

test("personal fact spans and modes bind actual Unicode-safe original evidence", () => {
  const value = command()
  expect(Schema.is(Manage)(value)).toBe(true)
  expect(source({ ...value, source: { ...value.source, text: "Remember something else." } })).toBe(false)
  expect(source({ ...value, fact: { start: 8, end: 8 } })).toBe(false)
  const emoji = fixture()
  if (emoji.parts[0].type !== "text") throw new Error("Text fixture required")
  emoji.parts[0].text = "Remember I prefer 📝."
  const original = current([emoji], { id: sid }, uid)
  if (!original) throw new Error("Unicode source required")
  const start = original.text.indexOf("📝")
  expect(source({ ...value, source: original, fact: { start, end: start + 1 } })).toBe(false)
  expect(source({ ...value, source: original, fact: { start, end: start + 2 } })).toBe(true)
  expect(source({ ...value, mode: "correct" })).toBe(false)
  expect(source({ ...value, mode: "correct", query: "drink preference" })).toBe(true)
  expect(source({ ...value, mode: "forget", query: "drink preference" })).toBe(false)
  expect(source({ ...value, mode: "forget", fact: undefined, query: "drink preference" })).toBe(true)
})

test("personal fact admission bounds UTF-8 bytes without splitting UTF-16 evidence", () => {
  const row = fixture()
  if (row.parts[0].type !== "text") throw new Error("Original text required")
  for (const count of [1024, 1025]) {
    row.parts[0].text = "Remember " + "📝".repeat(count)
    const original = current([row], { id: sid }, uid)
    if (!original) throw new Error("Original bounded user source required")
    expect(source({ ...command(), source: original, fact: { start: 9, end: original.text.length } })).toBe(
      count === 1024,
    )
  }
})

test("personal receipts bind the original request and do not equate publication with indexing", () => {
  const selected = command()
  const request = { id: RequestID.make("manage_request"), project: "/project", sessionID: sid, command: selected }
  const receipt: ManageResult = {
    action: "manage",
    project: request.project,
    mode: selected.mode,
    operation: selected.operation,
    sessionID: sid,
    messageID: uid,
    source_sha256: selected.source.source_sha256,
    disposition: "published",
    publication_confirmed: true,
    index_confirmed: false,
    changes: [{ relative: "Preferences/Raya.md", note_sha256: "b".repeat(64) }],
  }
  expect(valid(request, receipt)).toBe(true)
  expect(valid(request, { ...receipt, index_confirmed: true })).toBe(false)
  expect(valid(request, { ...receipt, disposition: "indexed", index_confirmed: true })).toBe(true)
  expect(valid(request, { ...receipt, source_sha256: "c".repeat(64) })).toBe(false)
  expect(valid({ ...request, sessionID: SessionID.make("ses_other") }, receipt)).toBe(false)
  expect(
    valid(request, { ...receipt, changes: [{ relative: "Preferences/Private/Note.md", note_sha256: "b".repeat(64) }] }),
  ).toBe(false)
  expect(
    valid(request, { ...receipt, changes: [{ relative: "Preferences/../Note.md", note_sha256: "b".repeat(64) }] }),
  ).toBe(false)
  expect(valid(request, { ...receipt, disposition: "pending", publication_confirmed: false, changes: [] })).toBe(true)
})
