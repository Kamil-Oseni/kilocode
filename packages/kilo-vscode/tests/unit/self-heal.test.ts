// raya_change - verify discoverable global feedback intake and isolated repair wiring
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseSelfHealCommand } from "../../src/shared/self-heal"

const root = path.join(import.meta.dir, "../..")

describe("Raya self-heal", () => {
  test("parses intake, listing, and usage without guessing ordinary prompts", () => {
    expect(parseSelfHealCommand("hello")).toBeUndefined()
    expect(parseSelfHealCommand("/self-heal")?.kind).toBe("usage")
    expect(parseSelfHealCommand("/self-heal list")).toEqual({ kind: "list" })
    expect(parseSelfHealCommand("/self-heal The goal loops forever")).toEqual({
      kind: "capture",
      description: "The goal loops forever",
    })
  })

  test("wires feedback through verified source admission to a linked repair session", async () => {
    const provider = await Bun.file(path.join(root, "src/KiloProvider.ts")).text()
    const intake = await Bun.file(path.join(root, "src/self-heal/intake.ts")).text()
    const slash = await Bun.file(path.join(root, "webview-ui/src/hooks/useSlashCommand.ts")).text()

    expect(slash).toContain('name: "self-heal"')
    expect(provider).toContain("captureSelfHeal")
    expect(intake).toContain("selfHeal.create")
    expect(intake).toContain("selfHealID: item.id")
    expect(intake).toContain('agent: "chief"')
    expect(intake).toContain('status: "in_progress"')
  })
})
