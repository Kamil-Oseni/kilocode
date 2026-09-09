import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Skill } from "@/skill"
import { ToolRegistry } from "@/tool/registry"
import { BrowserTools } from "@/kilocode/tool/browser-host"
import { MessageID, SessionID } from "@/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Skill.node, ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node])),
)

it.live(
  "browser skill references load through the real tool and cover exactly the registered browser tools",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skills = yield* Skill.Service
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.all()
          const tool = tools.find((item) => item.id === "skill")
          if (!tool) throw new Error("Missing skill tool")
          const names = ["browser", "browser-runtime", "browser-workflows", "browser-recovery"]
          const permissions: string[] = []
          const ctx = {
            sessionID: SessionID.make("ses_browser_skills"),
            messageID: MessageID.ascending(),
            agent: "code",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: (request: { permission: string; patterns: readonly string[] }) =>
              Effect.sync(() => {
                permissions.push(`${request.permission}:${request.patterns.join(",")}`)
              }),
          }
          const discovered = yield* skills.all()
          for (const name of names) {
            const item = discovered.find((item) => item.name === name)
            expect(item?.location).toBe(Skill.BUILTIN_LOCATION)
            expect(item?.trusted).toBe(true)
            const result = yield* tool.execute({ name }, ctx)
            expect(result.metadata.dir).toBe("builtin")
            expect(result.output).toContain(item!.content.trim())
            expect(result.output).not.toContain("Base directory for this skill:")
          }
          expect(permissions).toEqual(names.map((name) => `skill:${name}`))
          const entry = yield* skills.require("browser")
          for (const name of names.slice(1)) expect(entry.content).toContain(`\`${name}\``)
          const runtime = yield* skills.require("browser-runtime")
          const documented = [...runtime.content.matchAll(/^\| `(browser_\w+)` \|/gm)].map((match) => match[1])
          expect(documented.sort()).toEqual(BrowserTools.map((tool) => tool.id).sort())
          for (const id of documented) expect(tools.some((tool) => tool.id === id)).toBe(Flag.KILO_CLIENT === "vscode")
        }),
      {
        git: true,
        config: {
          enabled_providers: [],
          default_agent: "code",
          formatter: false,
          lsp: false,
          indexing: { enabled: false },
        },
      },
    ),
  60_000,
)
