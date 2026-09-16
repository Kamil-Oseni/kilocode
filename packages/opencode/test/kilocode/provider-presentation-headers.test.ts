import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DEFAULT_HEADERS } from "../../src/kilocode/const"

describe("Raya provider presentation headers", () => {
  test("presents Raya without changing compatibility routing metadata", () => {
    expect(DEFAULT_HEADERS["X-Title"]).toBe("Raya")
    expect(DEFAULT_HEADERS["HTTP-Referer"]).toBe("https://kilocode.ai")
    expect(DEFAULT_HEADERS["User-Agent"]).toMatch(/^Kilo-Code\//)
  })

  test("uses Raya for provider titles and retains partner routing values", async () => {
    const source = await Bun.file(path.join(import.meta.dir, "../../src/provider/provider.ts")).text()
    const legacy = ["Ki", "lo"].join("")

    expect(source.match(/"X-Title": "Raya"/g)).toHaveLength(5)
    expect(source.match(/"x-title": "Raya"/g)).toHaveLength(1)
    expect(source).not.toContain(`"X-Title": "${legacy} Code"`)
    expect(source).toContain(`"X-Cerebras-3rd-Party-Integration": "${legacy} Code"`)
    expect(source).toContain(`"X-BILLING-INVOKE-ORIGIN": "${legacy}Code"`)
    expect(source).toContain('"X-Source": "kilo"')
  })
})
