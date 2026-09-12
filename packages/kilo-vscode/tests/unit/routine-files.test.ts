import { describe, expect, test } from "bun:test"
import { bundle, encode, MAX_ROUTINE_FILE_BYTES } from "../../src/kilo-provider/routine-files"

describe("routine attachment encoding", () => {
  test("encodes bounded bytes with an inferred MIME type", () => {
    const file = encode("ledger.PDF", new Uint8Array([1, 2, 3]))
    expect(file).toMatchObject({ name: "ledger.PDF", mime: "application/pdf", size: 3, data: "AQID" })
    expect(file.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("rejects empty, oversized, or excessive selections before staging", () => {
    expect(() => encode("empty.txt", new Uint8Array())).toThrow("empty")
    expect(() => encode("large.bin", new Uint8Array(MAX_ROUTINE_FILE_BYTES + 1))).toThrow("5 MB")
    const file = encode("note.txt", new Uint8Array([1]))
    expect(() => bundle([file], 8)).toThrow("up to 8")
  })
})
