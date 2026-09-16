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

  test("runtime presentation uses Raya while compatibility commands and links remain stable", async () => {
    const files = [
      "src/kilocode/background-process/index.ts",
      "src/kilocode/cli/cmd/tui-worktree.ts",
      "src/kilocode/cli/dev-setup.ts",
      "src/kilocode/components/dialog-claw-setup.tsx",
      "src/kilocode/components/dialog-claw-upgrade.tsx",
      "src/kilocode/components/dialog-indexing.tsx",
      "src/kilocode/components/tips.tsx",
      "src/kilocode/config/sources.ts",
    ]
    const src = (await Promise.all(files.map((file) => Bun.file(path.join(root, file)).text()))).join("\n")
    const legacy = [
      "KiloClaw gives you",
      "Try KiloClaw",
      "KiloClaw Chat requires",
      "button on the KiloClaw",
      'kilo: "Kilo"',
      'title="Kilo Embedding Model"',
      '"Kilo catalog"',
      '"provided by Kilo"',
      '"Kilo can',
      '"Ask Kilo',
      '"Kilo auto-',
      'access to Kilo"',
      '"Kilo Cloud organization config"',
      "managed by Kilo Cloud",
      "Kilo CLI dev launcher setup",
      "# Kilo Code agent worktrees",
      "another Kilo process",
    ]

    expect(legacy.filter((text) => src.includes(text))).toEqual([])
    expect(src).toContain("Raya Messenger gives you")
    expect(src).toContain("Raya Embedding Model")
    expect(src).toContain("Raya Cloud organization config")
    expect(src).toContain("{highlight}kilo serve{/highlight}")
    expect(src).toContain("https://kilo.ai/kiloclaw")
  })
})
