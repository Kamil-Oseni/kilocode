import { expect, test } from "bun:test"
import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"

type Part = InputReceipt.Part & { text?: string; url?: string; mime?: string; filename?: string }
const key = "raya.input.complete"

function input() {
  const info = { id: "msg_original", sessionID: "ses_original", role: "user" }
  const parts: Part[] = [
    {
      id: "prt_file",
      sessionID: info.sessionID,
      messageID: info.id,
      type: "file",
      mime: "text/plain",
      url: "data:text/plain;base64,b3JpZ2luYWw=",
      filename: "original.txt",
    },
    {
      id: "prt_text",
      sessionID: info.sessionID,
      messageID: info.id,
      type: "text",
      text: "Original request\n",
      metadata: { review: { body: "Original request\n" } },
    },
  ]
  return { info, parts }
}

function sealed(row: ReturnType<typeof input>) {
  const part = InputReceipt.seal(row.info, row.parts)
  if (!part) throw new Error("Original component fixture could not be sealed")
  return { info: row.info, parts: row.parts.map((item) => (item.id === part.id ? part : item)) }
}

test("resolved complete input validates its unchanged original parts and metadata", () => {
  const row = input()
  const before = structuredClone(row)
  const receipt = sealed(row)
  expect(InputReceipt.complete(receipt, row.info.sessionID, row.info.id)).toBe(true)
  expect(row).toEqual(before)
  expect(InputReceipt.clean(receipt.parts[1])).toEqual(row.parts[1])
})

test("header, unsealed originals, and missing original payload never acknowledge input", () => {
  const row = input()
  expect(InputReceipt.complete({ info: row.info, parts: [] }, row.info.sessionID, row.info.id)).toBe(false)
  expect(InputReceipt.complete(row, row.info.sessionID, row.info.id)).toBe(false)
  const receipt = sealed(row)
  receipt.parts.shift()
  expect(InputReceipt.complete(receipt, row.info.sessionID, row.info.id)).toBe(false)
})

test("modified text, attachment, and presentation metadata invalidate a published receipt", () => {
  for (const field of ["text", "url", "metadata"]) {
    const row = input()
    const receipt = sealed(row)
    if (field === "text") receipt.parts[1].text = "Changed request\n"
    if (field === "url") receipt.parts[0].url = "data:text/plain;base64,Y2hhbmdlZA=="
    if (field === "metadata")
      receipt.parts[1].metadata = { ...receipt.parts[1].metadata, review: { body: "Changed request\n" } }
    expect(InputReceipt.complete(receipt, row.info.sessionID, row.info.id)).toBe(false)
  }
})

test("duplicate original IDs and extra unmatched payload cannot satisfy the manifest", () => {
  const row = input()
  const receipt = sealed(row)
  receipt.parts.push(structuredClone(receipt.parts[0]))
  expect(InputReceipt.complete(receipt, row.info.sessionID, row.info.id)).toBe(false)
  expect(InputReceipt.seal(row.info, receipt.parts)).toBeUndefined()
  receipt.parts[2].id = "prt_extra"
  expect(InputReceipt.complete(receipt, row.info.sessionID, row.info.id)).toBe(false)
})

test("copied receipt cannot acknowledge a fork or replacement input", () => {
  const row = input()
  const receipt = sealed(row)
  receipt.info = { id: "msg_copy", sessionID: "ses_copy", role: "user" }
  receipt.parts = receipt.parts.map((part) => ({
    ...part,
    id: `${part.id}_copy`,
    sessionID: receipt.info.sessionID,
    messageID: receipt.info.id,
  }))
  expect(InputReceipt.complete(receipt, receipt.info.sessionID, receipt.info.id)).toBe(false)
  expect(InputReceipt.complete(sealed(row), "ses_foreign", row.info.id)).toBe(false)
  expect(InputReceipt.complete(sealed(row), row.info.sessionID, "msg_foreign")).toBe(false)
})

test("reserved submitted metadata is stripped before publication without losing unrelated metadata", () => {
  const row = input()
  const receipt = sealed(row)
  const parts = receipt.parts.map(InputReceipt.clean)
  expect(parts).toEqual(row.parts)
  expect(InputReceipt.complete({ info: row.info, parts }, row.info.sessionID, row.info.id)).toBe(false)
  expect(InputReceipt.complete(sealed({ info: row.info, parts }), row.info.sessionID, row.info.id)).toBe(true)
})

test("empty text metadata remains a valid complete original payload", () => {
  const row = input()
  row.parts[1].metadata = {}
  expect(InputReceipt.complete(sealed(row), row.info.sessionID, row.info.id)).toBe(true)
})

test("malformed or multiple reserved receipts refuse acknowledgment", () => {
  for (const proof of [
    null,
    [],
    {},
    { version: 2 },
    { version: 1, sessionID: "ses_original", messageID: "msg_original", parts: [] },
  ]) {
    const row = input()
    row.parts[1].metadata = { [key]: proof }
    expect(InputReceipt.complete(row, row.info.sessionID, row.info.id)).toBe(false)
  }
  const row = input()
  const receipt = sealed(row)
  receipt.parts.push({
    id: "prt_second",
    sessionID: row.info.sessionID,
    messageID: row.info.id,
    type: "text",
    text: "",
    metadata: { [key]: receipt.parts[1].metadata?.[key] },
  })
  expect(InputReceipt.complete(receipt, row.info.sessionID, row.info.id)).toBe(false)
})

test("foreign roles and part identities cannot be sealed or accepted", () => {
  const row = input()
  expect(InputReceipt.seal({ ...row.info, role: "assistant" }, row.parts)).toBeUndefined()
  const receipt = sealed(row)
  receipt.parts[0].messageID = "msg_other"
  expect(InputReceipt.complete(receipt, row.info.sessionID, row.info.id)).toBe(false)
  expect(InputReceipt.seal(row.info, receipt.parts)).toBeUndefined()
})
