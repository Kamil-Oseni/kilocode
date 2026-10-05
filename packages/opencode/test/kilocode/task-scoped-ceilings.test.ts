import { expect, test } from "bun:test"
import { Permission } from "@/permission"
import { TaskAuthority } from "@/kilocode/tool/task-authority"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Fiber } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { KiloSessionPrompt } from "@/kilocode/session/prompt"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ToolRegistry } from "@/tool/registry"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Instance } from "@/kilocode/instance"
import path from "path"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Agent.node, Session.node, Permission.node, SessionProjector.node, ToolRegistry.node]),
  ),
)

const rules = Permission.fromConfig({
  "*": "deny",
  read: { "*": "deny", "input.txt": "allow" },
  edit: { "*": "deny", "result.txt": "allow" },
})
const parent = { id: "parent", permission: rules }
const agent = Permission.fromConfig({ "*": "allow" })

test("scoped parent edit admission does not grant foreign writes or reads", () => {
  expect(TaskAuthority.select({ requested: "edit", parent: rules })).toBe("edit")
  const metadata = TaskAuthority.inherit(TaskAuthority.save({}, "edit"), parent, agent)
  expect(TaskAuthority.hard(metadata, "edit", ["result.txt"])).toEqual([])
  expect(TaskAuthority.hard(metadata, "edit", ["foreign.txt"])).toEqual([
    { permission: "edit", pattern: "foreign.txt", action: "deny" },
  ])
  expect(TaskAuthority.hard(metadata, "read", ["input.txt", "foreign.txt"])).toEqual([
    { permission: "read", pattern: "foreign.txt", action: "deny" },
  ])
  const selected = Permission.fromConfig({ edit: "deny" })
  expect(
    Permission.evaluate("edit", "result.txt", selected, TaskAuthority.hard(metadata, "edit", ["result.txt"])).action,
  ).toBe("deny")
})

test("nested and resumed broader permissions cannot reopen original ceilings", () => {
  const original = TaskAuthority.inherit({}, parent, agent)
  const child = TaskAuthority.inherit({}, { id: "child", metadata: original, permission: agent }, agent)
  const resumed = TaskAuthority.inherit(child, { id: "parent", permission: agent }, agent)
  expect(TaskAuthority.hard(resumed, "edit", ["foreign.txt"])).toHaveLength(1)
  expect(TaskAuthority.hard(resumed, "edit", ["result.txt"])).toEqual([])
  expect(TaskAuthority.ceilings(resumed)).toHaveLength(3)
})

test("malformed ceiling metadata refuses and read authority still denies mutation", () => {
  expect(() => TaskAuthority.ceilings({ "raya.task.ceilings": null })).toThrow()
  expect(() =>
    TaskAuthority.ceilings({
      "raya.task.ceilings": [
        { parentID: "parent", agent: [{ permission: "edit", pattern: "*", action: "invalid" }], session: [] },
      ],
    }),
  ).toThrow()
  const metadata = TaskAuthority.inherit(TaskAuthority.save({}, "read"), parent, agent)
  expect(Permission.evaluate("edit", "result.txt", TaskAuthority.rules(TaskAuthority.read(metadata))).action).toBe(
    "deny",
  )
})

test("wildcard filesystem denials remain ordered in ceilings instead of hiding scoped tools", () => {
  const wildcard = Permission.fromConfig({ "r*": "deny", read: { "input.txt": "allow" } })
  expect(TaskAuthority.project(wildcard).some((rule) => rule.action === "deny")).toBe(false)
  const metadata = TaskAuthority.inherit({}, { id: "parent", permission: wildcard }, [])
  expect(TaskAuthority.hard(metadata, "read", ["input.txt"])).toEqual([])
  expect(TaskAuthority.hard(metadata, "read", ["foreign.txt"])).toHaveLength(1)
})

it.instance(
  "actual custom specialist denial survives read authority and parent scoped allow",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const selected = yield* agents.get("scoped")
      expect(selected).toBeDefined()
      const metadata = TaskAuthority.inherit(TaskAuthority.save({}, "read"), parent, agent)
      const child = yield* sessions.create({
        title: "Restricted specialist",
        metadata,
        permission: TaskAuthority.rules("read"),
      })
      const error = yield* KiloSessionPrompt.askPermission({
        permission,
        agents,
        sessions,
        agent: selected,
        session: child,
        request: { sessionID: child.id, permission: "read", patterns: ["input.txt"], always: ["*"], metadata: {} },
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Permission.DeniedError)
      expect(yield* permission.list()).toEqual([])
    }),
  { config: { agent: { scoped: { mode: "subagent", permission: { read: { "*": "allow", "input.txt": "deny" } } } } } },
  30_000,
)

it.instance(
  "saved always approval cannot bypass an independent parent scope ceiling",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const selected = yield* agents.get("scoped")
      const metadata = TaskAuthority.inherit(TaskAuthority.save({}, "edit"), parent, agent)
      const child = yield* sessions.create({ title: "Scoped approval", metadata })
      const request = (pattern: string) =>
        KiloSessionPrompt.askPermission({
          permission,
          agents,
          sessions,
          agent: selected,
          session: child,
          request: { sessionID: child.id, permission: "edit", patterns: [pattern], always: ["*"], metadata: {} },
        })
      const fiber = yield* request("result.txt").pipe(Effect.forkScoped)
      const pending = yield* pollWithTimeout(
        permission.list().pipe(Effect.map((list) => list.find((entry) => entry.sessionID === child.id))),
        "scoped edit permission did not appear",
      )
      yield* permission.reply({ requestID: pending.id, reply: "always" })
      yield* Fiber.join(fiber)
      const error = yield* request("foreign.txt").pipe(Effect.flip)
      expect(error).toBeInstanceOf(Permission.DeniedError)
      expect(yield* permission.list()).toEqual([])
    }),
  { config: { agent: { scoped: { mode: "subagent", permission: { edit: "ask" } } } } },
  30_000,
)

it.instance(
  "actual configured agent and permission service preserve scoped file operations and refuse approvals outside them",
  () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const registry = yield* ToolRegistry.Service
      const selected = yield* agents.get("general")
      expect(selected).toBeDefined()
      const dir = Instance.directory
      const file = path.join(dir, "result.txt")
      const denied = path.join(dir, "foreign.txt")
      const ceiling = Permission.fromConfig({ "*": "allow", edit: { "*": "deny", [file]: "allow" } })
      const metadata = TaskAuthority.inherit(
        TaskAuthority.save({}, "edit"),
        { id: "parent", permission: ceiling },
        selected.permission,
      )
      const child = yield* sessions.create({ title: "Scoped child", metadata })
      const catalog = yield* registry.tools({
        providerID: ProviderV2.ID.make("fixture"),
        modelID: ModelV2.ID.make("fixture"),
        agent: selected,
        permission: TaskAuthority.project(ceiling),
      })
      expect(catalog.map((tool) => tool.id)).toContain("write")
      expect(catalog.map((tool) => tool.id)).toContain("read")
      const request = (pattern: string) =>
        KiloSessionPrompt.askPermission({
          permission,
          agents,
          sessions,
          agent: selected,
          session: child,
          request: { sessionID: child.id, permission: "edit", patterns: [pattern], always: ["*"], metadata: {} },
        })
      yield* request(file)
      yield* Effect.promise(() => Bun.write(file, "permitted scoped write"))
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("permitted scoped write")
      const error = yield* request(denied).pipe(Effect.flip)
      expect(error).toBeInstanceOf(Permission.DeniedError)
      expect(yield* permission.list()).toEqual([])
      expect(yield* Effect.promise(() => Bun.file(denied).exists())).toBe(false)
    }),
  30_000,
)
