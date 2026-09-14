// raya_change - verify discoverable global feedback intake and isolated repair wiring
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseSelfHealCommand } from "../../src/shared/self-heal"

const root = path.join(import.meta.dir, "../..")

describe("Raya self-heal", () => {
  test("parses intake, listing, and usage without guessing ordinary prompts", () => {
    expect(parseSelfHealCommand("hello")).toBeUndefined()
    expect(parseSelfHealCommand("/self-heal")?.kind).toBe("usage")
    expect(parseSelfHealCommand("/self-heal inspect heal_missing")).toEqual({ kind: "inspect", id: "heal_missing" })
    expect(parseSelfHealCommand("/self-heal inspect ../../other")?.kind).toBe("usage")
    expect(parseSelfHealCommand("/self-heal review heal_ready")).toEqual({ kind: "review", id: "heal_ready" })
    expect(parseSelfHealCommand("/self-heal review ../../other")?.kind).toBe("usage")
    expect(parseSelfHealCommand("/self-heal install heal_ready")).toEqual({ kind: "install", id: "heal_ready" })
    expect(parseSelfHealCommand("/self-heal install ../../other")?.kind).toBe("usage")
    expect(parseSelfHealCommand("/self-heal verify heal_ready")).toEqual({ kind: "verify", id: "heal_ready" })
    expect(parseSelfHealCommand("/self-heal verify ../../other")?.kind).toBe("usage")
    expect(parseSelfHealCommand("/self-heal accept heal_ready")).toEqual({ kind: "accept", id: "heal_ready" })
    expect(parseSelfHealCommand("/self-heal accept ../../other")?.kind).toBe("usage")
    expect(parseSelfHealCommand("/self-heal rollback heal_ready")).toEqual({ kind: "rollback", id: "heal_ready" })
    expect(parseSelfHealCommand("/self-heal rollback ../../other")?.kind).toBe("usage")
    expect(parseSelfHealCommand("/self-heal cleanup heal_ready")).toEqual({ kind: "cleanup", id: "heal_ready" })
    expect(parseSelfHealCommand("/self-heal cleanup ../../other")?.kind).toBe("usage")
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
