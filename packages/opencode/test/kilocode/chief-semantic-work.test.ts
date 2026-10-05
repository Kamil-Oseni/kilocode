import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { RayaChief } from "@/kilocode/chief"
import { Permission } from "@/permission"
import {
  provideInstance,
  provideTestInstance,
  testInstanceStoreLayer,
  tmpdir,
  disposeAllInstances,
} from "../fixture/fixture"

for (const [label, permission] of [
  ["global", { "*": "allow" }],
  ["file", { "*": "deny", read: "allow", edit: { "*": "deny", "result.txt": "allow" } }],
] as const) {
  test(`built-in research work stays read-only under ${label} editing permission`, async () => {
    await using tmp = await tmpdir({
      config: {
        permission,
        agent: {
          writer: { description: "Custom editing specialist", mode: "subagent", permission: { edit: "allow" } },
        },
      },
    })
    await provideTestInstance({
      directory: tmp.path,
      fn: () =>
        Effect.runPromise(
          provideInstance(tmp.path)(
            Agent.Service.use((svc) =>
              Effect.gen(function* () {
                const agents = yield* svc.list()
                const research = yield* svc.get("researcher")
                const explore = yield* svc.get("explore")
                const writer = yield* svc.get("writer")
                expect(research?.native).toBe(true)
                expect(explore?.native).toBe(true)
                expect(writer?.native).toBe(false)
                expect(Permission.evaluate("edit", "result.txt", research.permission).action).toBe("allow")
                expect(RayaChief.capable(research, "edit")).toBe(false)
                expect(RayaChief.capable(explore, "edit")).toBe(false)
                expect(RayaChief.capable(research, "computer")).toBe(false)
                expect(RayaChief.capable(explore, "computer")).toBe(false)
                expect(RayaChief.capable(research, "read")).toBe(true)
                expect(RayaChief.capable(writer, "edit")).toBe(true)
                const route = RayaChief.route({
                  request:
                    "Read input.txt, write its exact bytes into result.txt, then read result.txt to verify the evidence.",
                  agents,
                  access: "edit",
                })
                expect(["researcher", "explore"]).not.toContain(route.agent)
                expect(RayaChief.capable(agents.find((item) => item.name === route.agent)!, "edit")).toBe(true)
                expect(
                  RayaChief.route({ request: "Research primary evidence sources", agents, access: "read" }).agent,
                ).toBe("researcher")
                expect(Permission.evaluate("edit", "other.txt", research.permission).action).toBe(
                  label === "file" ? "deny" : "allow",
                )
              }),
            ),
          ).pipe(Effect.provide(AppNodeBuilder.build(Agent.node)), Effect.provide(testInstanceStoreLayer)),
        ),
    })
    await disposeAllInstances()
  })
}

test("custom specialist semantics and permission denial remain unchanged", () => {
  const custom = { name: "researcher", native: false, permission: Permission.fromConfig({ "*": "allow" }) }
  expect(RayaChief.capable(custom, "edit")).toBe(true)
  expect(RayaChief.capable(custom, "computer")).toBe(true)
  expect(RayaChief.capable({ ...custom, permission: Permission.fromConfig({ "*": "deny" }) }, "edit")).toBe(false)
})
