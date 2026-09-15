// kilocode_change - new file

import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { HttpClient } from "effect/unstable/http"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ConfigProtection } from "../../src/kilocode/permission/config-paths"
import { disposeAllInstances, provideTestInstance, tmpdir } from "../fixture/fixture"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"

const original = Global.Path.config
const infra = AppNodeBuilder.build(CrossSpawnSpawner.node).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)
const account = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})
const auth = Layer.mock(Auth.Service)({ all: () => Effect.succeed({}) })
const npm = Layer.mock(Npm.Service)({
  install: () => Effect.void,
  add: () => Effect.die("not implemented"),
  which: () => Effect.succeed(undefined),
})
const http = HttpClient.make((request) => Effect.die(`unexpected HTTP request: ${request.method} ${request.url}`))
const layer = AppNodeBuilder.build(Config.node, [
  [Auth.node, auth],
  [Account.node, account],
  [Npm.node, npm],
  [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, http)],
]).pipe(Layer.provideMerge(infra))

afterEach(async () => {
  ;(Global.Path as { config: string }).config = original
  await disposeAllInstances()
})

async function load(project: string, global: string) {
  ;(Global.Path as { config: string }).config = global
  return provideTestInstance({
    directory: project,
    fn: () => Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer))),
  })
}

async function write(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(value, null, 2))
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const visit = async (root: string) => {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name)
      if (entry.isDirectory()) {
        await visit(file)
        continue
      }
      result[path.relative(dir, file)] = await Bun.file(file).text()
    }
  }
  await visit(dir)
  return result
}

describe("Raya config read aliases", () => {
  test("preserves legacy-only project discovery", async () => {
    await using project = await tmpdir()
    await using global = await tmpdir()
    await write(path.join(project.path, "kilo.json"), { model: "legacy/model" })

    expect((await load(project.path, global.path)).model).toBe("legacy/model")
  })

  test("reads Raya root files and config directories as untrusted project sources", async () => {
    await using project = await tmpdir()
    await using global = await tmpdir()
    const root = path.join(project.path, "raya.json")
    const nested = path.join(project.path, ".raya", "raya.jsonc")
    const instruction = path.join(project.path, "PROJECT.md")
    await write(root, { model: "raya/root" })
    await write(nested, { small_model: "raya/small", instructions: [instruction] })

    const config = await load(project.path, global.path)
    expect(config.model).toBe("raya/root")
    expect(config.small_model).toBe("raya/small")
    expect(config.instruction_origins?.[instruction]).toEqual({
      trusted: false,
      source: nested,
      root: project.path,
    })
  })

  test("merges Raya aliases after existing names without discarding distinct values", async () => {
    await using project = await tmpdir()
    await using global = await tmpdir()
    await write(path.join(project.path, "kilo.json"), { model: "legacy/model", username: "legacy-user" })
    await write(path.join(project.path, "opencode.jsonc"), { small_model: "legacy/small" })
    await write(path.join(project.path, "raya.json"), { model: "raya/model" })
    await write(path.join(project.path, ".kilo", "kilo.json"), { snapshot: false, share: "manual" })
    await write(path.join(project.path, ".raya", "raya.jsonc"), { snapshot: true })

    const config = await load(project.path, global.path)
    expect(config).toMatchObject({
      model: "raya/model",
      small_model: "legacy/small",
      username: "legacy-user",
      snapshot: true,
      share: "manual",
    })
  })

  test("does not create, migrate, copy, or edit files while reading Raya aliases", async () => {
    await using project = await tmpdir()
    await using global = await tmpdir()
    await write(path.join(global.path, "raya.json"), { username: "global-raya" })
    await write(path.join(project.path, ".raya", "raya.jsonc"), { model: "raya/model" })
    const before = { project: await snapshot(project.path), global: await snapshot(global.path) }

    const config = await load(project.path, global.path)

    expect(config).toMatchObject({ username: "global-raya", model: "raya/model" })
    expect({ project: await snapshot(project.path), global: await snapshot(global.path) }).toEqual(before)
    expect(await Bun.file(path.join(global.path, "kilo.jsonc")).exists()).toBe(false)
    expect(await Bun.file(path.join(project.path, ".kilo", "kilo.jsonc")).exists()).toBe(false)
  })

  test("protects Raya root files and directories as configuration", () => {
    for (const file of ["raya.json", "raya.jsonc", ".raya/raya.json", "nested/.raya/raya.jsonc"]) {
      expect(ConfigProtection.isRequest({ permission: "edit", patterns: [file] })).toBe(true)
    }
  })
})
