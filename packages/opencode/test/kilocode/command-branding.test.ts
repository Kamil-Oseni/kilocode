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
      "src/kilocode/cli/cmd/profile.ts",
      "src/kilocode/cli/cmd/tui/app.tsx",
      "src/kilocode/cli/cmd/tui/component/dialog-provider.tsx",
      "src/kilocode/cli/cmd/tui/feature-plugins/home/tips.ts",
      "src/kilocode/cli/cmd/tui-worktree.ts",
      "src/kilocode/cli/dev-setup.ts",
      "src/kilocode/components/dialog-claw-setup.tsx",
      "src/kilocode/components/dialog-claw-upgrade.tsx",
      "src/kilocode/components/dialog-indexing.tsx",
      "src/kilocode/components/dialog-kilo-profile.tsx",
      "src/kilocode/components/tips.tsx",
      "src/kilocode/config/sources.ts",
      "src/kilocode/kilo-commands.tsx",
      "src/kilocode/mcp-oauth-callback.ts",
      "src/cli/cmd/run/footer.permission.tsx",
      "src/mcp/oauth-provider.ts",
      "src/provider/models.ts",
      "src/kilo-sessions/kilo-sessions.ts",
      "src/kilocode/cloud/auth.ts",
      "src/kilocode/cloud/catalog.ts",
      "src/kilocode/tool/dictation-billing.ts",
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
      'APP_TITLE = "Kilo CLI"',
      'APP_NAME = "Kilo"',
      'title: "KiloClaw"',
      'category: "Kilo"',
      "show Kilo account profile",
      "Not authenticated with Kilo Gateway",
      "Kilo Gateway Profile",
      "Kilo Gateway gives you",
      "prevent Kilo from reading",
      "with Kilo Gateway for curated",
      "Tell Kilo what to do differently",
      'client_name: "Kilo"',
      "other Kilo process",
      "View your Kilo Gateway profile",
      "Switch between Kilo Gateway teams",
      "Open KiloClaw chat & dashboard",
      'name: "Kilo Gateway"',
      "no Kilo credentials found",
      "invalid or expired Kilo credentials",
      "failed to verify Kilo credentials",
      "Kilo credentials are required",
      "Kilo organization ID must be a valid UUID",
      "Kilo catalog URL is invalid",
      "Kilo catalog URL must be secure",
      "the Kilo model catalog",
      "The Kilo model catalog",
      "Kilo Gateway completed the transcription",
    ]

    expect(legacy.filter((text) => src.includes(text))).toEqual([])
    expect(src).toContain("Raya Messenger gives you")
    expect(src).toContain('APP_TITLE = "Raya CLI"')
    expect(src).toContain('APP_NAME = "Raya"')
    expect(src).toContain("Raya Gateway Profile")
    expect(src).toContain("Raya Embedding Model")
    expect(src).toContain("Raya Cloud organization config")
    expect(src).toContain("Tell Raya what to do differently")
    expect(src).toContain('client_name: "Raya"')
    expect(src).toContain("other Raya process")
    expect(src).toContain('title: "Raya Messenger"')
    expect(src).toContain('category: "Raya"')
    expect(src).toContain("Sign in to Raya Gateway, then try again")
    expect(src).toContain('client_uri: "https://kilo.ai"')
    expect(src).toContain('name: "kilo.profile"')
    expect(src).toContain('slashName: "kiloclaw"')
    expect(src).toContain('name: "Raya Gateway"')
    expect(src).toContain("Raya credentials")
    expect(src).toContain("Raya organization ID")
    expect(src).toContain("Raya model catalog")
    expect(src).toContain("Raya Gateway completed the transcription")
    expect(src).toContain('id: "kilo"')
    expect(src).toContain("`kilo auth login`")
    expect(src).toContain("{highlight}kilo serve{/highlight}")
    expect(src).toContain("https://kilo.ai/kiloclaw")
  })
})
