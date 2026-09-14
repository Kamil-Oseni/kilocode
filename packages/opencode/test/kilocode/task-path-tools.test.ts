import { afterEach, describe, expect } from "bun:test"
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Cause, Effect, Exit } from "effect"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Format } from "../../src/format"
import { Git } from "../../src/git"
import { LSP } from "../../src/lsp/lsp"
import { Permission } from "../../src/permission"
import { MessageID, SessionID } from "../../src/session/schema"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import type * as Tool from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { WriteTool } from "../../src/tool/write"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      LSP.node,
      FSUtil.node,
      EventV2Bridge.node,
      Format.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
      Truncate.node,
      Agent.node,
      Git.node,
    ]),
  ),
)

const init = Effect.fn("RayaPathToolsTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const base = {
  sessionID: SessionID.make("ses_raya-path-tools"),
  messageID: MessageID.make("msg_raya-path-tools"),
  callID: "call_raya-path-tools",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const link = (target: string, alias: string) =>
  symlink(target, alias, process.platform === "win32" ? "junction" : "dir")

const blocked = (asked: string[]): Tool.Context => ({
  ...base,
  ask: (req) =>
    Effect.sync(() => {
      if (req.permission !== "read") return
      asked.push(...req.patterns)
      const rules = [
        { permission: "read", pattern: "*", action: "deny" as const },
        { permission: "read", pattern: asked[0], action: "allow" as const },
      ]
      const denied = req.patterns.find(
        (pattern) => Permission.evaluate(req.permission, pattern, rules).action !== "allow",
      )
      if (denied) throw new Error(`denied:${denied}`)
    }),
})

describe("routine path tool boundaries", () => {
  it.instance("denies a writable-looking directory link when its real target is denied", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "restricted")
      const alias = path.join(test.directory, "granted")
      const file = path.join(target, "report.txt")
      yield* Effect.promise(() => mkdir(target))
      yield* Effect.promise(() => writeFile(file, "original"))
      yield* Effect.promise(() => link(target, alias))

      const asked: string[] = []
      const ctx: Tool.Context = {
        ...base,
        ask: (req) =>
          Effect.sync(() => {
            asked.push(...req.patterns)
            const rules = [
              { permission: "edit", pattern: "*", action: "deny" as const },
              { permission: "edit", pattern: req.patterns[0], action: "allow" as const },
            ]
            const denied = req.patterns.find(
              (pattern) => Permission.evaluate(req.permission, pattern, rules).action !== "allow",
            )
            if (denied) throw new Error(`denied:${denied}`)
          }),
      }
      const tool = yield* init()
      const result = yield* Effect.exit(
        tool.execute({ filePath: path.join(alias, "report.txt"), content: "changed" }, ctx),
      )

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain(`denied:${asked[1]}`)
      expect(asked).toHaveLength(2)
      expect(asked[0]).toContain("granted/report.txt")
      expect(asked[1]).toContain("restricted/report.txt")
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("original")
    }),
  )

  it.instance("rejects a directory link whose target changes after approval", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const first = path.join(test.directory, "first")
      const second = path.join(test.directory, "second")
      const alias = path.join(test.directory, "granted")
      yield* Effect.promise(() => Promise.all([mkdir(first), mkdir(second)]))
      yield* Effect.promise(() =>
        Promise.all([
          writeFile(path.join(first, "report.txt"), "first"),
          writeFile(path.join(second, "report.txt"), "second"),
        ]),
      )
      yield* Effect.promise(() => link(first, alias))

      const ctx: Tool.Context = {
        ...base,
        ask: () =>
          Effect.promise(async () => {
            await unlink(alias)
            await link(second, alias)
          }),
      }
      const tool = yield* init()
      const result = yield* Effect.exit(
        tool.execute({ filePath: path.join(alias, "report.txt"), content: "changed" }, ctx),
      )

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("File target changed after approval")
      expect(yield* Effect.promise(() => readFile(path.join(first, "report.txt"), "utf8"))).toBe("first")
      expect(yield* Effect.promise(() => readFile(path.join(second, "report.txt"), "utf8"))).toBe("second")
    }),
  )

  it.instance("does not let a directory link bypass protected Agent Manager state", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, ".kilo")
      const alias = path.join(test.directory, "granted")
      const file = path.join(target, "agent-manager.json")
      yield* Effect.promise(() => mkdir(target))
      yield* Effect.promise(() => writeFile(file, "owner state"))
      yield* Effect.promise(() => link(target, alias))

      const asked: string[] = []
      const ctx: Tool.Context = {
        ...base,
        ask: (req) =>
          Effect.sync(() => {
            asked.push(...req.patterns)
          }),
      }
      const tool = yield* init()
      const result = yield* Effect.exit(
        tool.execute({ filePath: path.join(alias, "agent-manager.json"), content: "changed" }, ctx),
      )

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Do not edit Agent Manager state")
      expect(asked).toEqual([])
      expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("owner state")
    }),
  )

  it.instance("denies glob and grep before a directory link can disclose its real target", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "restricted")
      const alias = path.join(test.directory, "granted")
      yield* Effect.promise(() => mkdir(target))
      yield* Effect.promise(() => writeFile(path.join(target, "secret.txt"), "private needle"))
      yield* Effect.promise(() => link(target, alias))

      const globbed: string[] = []
      const globInfo = yield* GlobTool
      const glob = yield* globInfo.init()
      const globResult = yield* Effect.exit(glob.execute({ pattern: "*.txt", path: alias }, blocked(globbed)))
      expect(Exit.isFailure(globResult)).toBe(true)
      expect(globbed).toHaveLength(2)
      expect(globbed[0]).toContain("granted")
      expect(globbed[1]).toContain("restricted")
      if (Exit.isFailure(globResult)) expect(Cause.pretty(globResult.cause)).not.toContain("secret.txt")

      const grepped: string[] = []
      const grepInfo = yield* GrepTool
      const grep = yield* grepInfo.init()
      const grepResult = yield* Effect.exit(grep.execute({ pattern: "needle", path: alias }, blocked(grepped)))
      expect(Exit.isFailure(grepResult)).toBe(true)
      expect(grepped).toHaveLength(2)
      expect(grepped[0]).toContain("granted")
      expect(grepped[1]).toContain("restricted")
      if (Exit.isFailure(grepResult)) expect(Cause.pretty(grepResult.cause)).not.toContain("private needle")
    }),
  )
})
