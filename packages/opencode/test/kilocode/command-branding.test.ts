import { describe, expect, test } from "bun:test"
import path from "path"

const root = path.join(__dirname, "..", "..")

const files = [
  "src/kilocode/cli/cmd/tui/feature-plugins/home/tips.ts",
  "src/cli/cmd/run.ts",
  "src/config/config.ts",
  "src/server/routes/instance/httpapi/public.ts",
  "src/mcp/index.ts",
]

const command = /opencode\s+(--[a-z-]+|run|serve|auth|upgrade|agent|github|mcp)\b/g

describe("Kilo command branding", () => {
  test("user-facing command help uses the `kilo` binary name", async () => {
    const results = await Promise.all(
      files.map(async (file) => ({
        file,
        matches: [...(await Bun.file(path.join(root, file)).text()).matchAll(command)].map((match) => match[0]),
      })),
    )

    expect(results.filter((result) => result.matches.length > 0)).toEqual([])
  })

  test("provider errors use the Raya Gateway name without changing the login command", async () => {
    const src = await Bun.file(path.join(root, "src", "kilocode", "components", "kilo-error-display.tsx")).text()

    expect(src).toContain("Run /connect or `kilo auth login` to connect to Raya Gateway")
    expect(src).not.toContain("connect to Kilo Gateway")
  })
})
