import { describe, expect, test } from "bun:test"
import path from "path"

const root = path.join(__dirname, "..", "..", "..", "src", "cli", "cmd", "run")

describe("Raya direct-mode branding", () => {
  test("uses Raya product strings", async () => {
    const footer = await Bun.file(path.join(root, "footer.prompt.tsx")).text()
    const splash = await Bun.file(path.join(root, "splash.ts")).text()

    expect(footer).toContain('description: "close direct mode"')
    expect(footer).not.toContain('description: "close OpenCode"')
    expect(splash).toContain('body_left, top, "Raya"')
    expect(splash).not.toContain('body_left, top, "Kilo"')
    expect(splash).not.toContain('body_left, top, "OpenCode"')
  })
})
