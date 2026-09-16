import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import * as Log from "@opencode-ai/core/util/log"
import { EnvAlias } from "@opencode-ai/core/kilocode/env-alias"
import { Server } from "../../../src/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

type Source = {
  order: number
  kind: string
  scope: string
  label: string
  source: string
  path?: string
  exists: boolean
  editable: boolean
  reason?: string
}

type Body = {
  sources: Source[]
}

const env = {
  KILO_CONFIG: process.env.KILO_CONFIG,
  KILO_CONFIG_CONTENT: process.env.KILO_CONFIG_CONTENT,
  KILO_CONFIG_DIR: process.env.KILO_CONFIG_DIR,
  RAYA_DISABLE_PROJECT_CONFIG: process.env.RAYA_DISABLE_PROJECT_CONFIG,
  KILO_DISABLE_PROJECT_CONFIG: process.env.KILO_DISABLE_PROJECT_CONFIG,
  RAYA_DISABLE_AUTOCOMPACT: process.env.RAYA_DISABLE_AUTOCOMPACT,
  KILO_DISABLE_AUTOCOMPACT: process.env.KILO_DISABLE_AUTOCOMPACT,
  RAYA_DISABLE_PRUNE: process.env.RAYA_DISABLE_PRUNE,
  KILO_DISABLE_PRUNE: process.env.KILO_DISABLE_PRUNE,
  RAYA_PERMISSION: process.env.RAYA_PERMISSION,
  KILO_PERMISSION: process.env.KILO_PERMISSION,
  KILO_TEST_MANAGED_CONFIG_DIR: process.env.KILO_TEST_MANAGED_CONFIG_DIR,
}

afterEach(async () => {
  EnvAlias.conflicts()
  restore()
  await disposeAllInstances()
  await resetDatabase()
})

function restore() {
  set("KILO_CONFIG", env.KILO_CONFIG)
  set("KILO_CONFIG_CONTENT", env.KILO_CONFIG_CONTENT)
  set("KILO_CONFIG_DIR", env.KILO_CONFIG_DIR)
  set("RAYA_DISABLE_PROJECT_CONFIG", env.RAYA_DISABLE_PROJECT_CONFIG)
  set("KILO_DISABLE_PROJECT_CONFIG", env.KILO_DISABLE_PROJECT_CONFIG)
  set("RAYA_DISABLE_AUTOCOMPACT", env.RAYA_DISABLE_AUTOCOMPACT)
  set("KILO_DISABLE_AUTOCOMPACT", env.KILO_DISABLE_AUTOCOMPACT)
  set("RAYA_DISABLE_PRUNE", env.RAYA_DISABLE_PRUNE)
  set("KILO_DISABLE_PRUNE", env.KILO_DISABLE_PRUNE)
  set("RAYA_PERMISSION", env.RAYA_PERMISSION)
  set("KILO_PERMISSION", env.KILO_PERMISSION)
  set("KILO_TEST_MANAGED_CONFIG_DIR", env.KILO_TEST_MANAGED_CONFIG_DIR)
}

function set(key: keyof typeof process.env, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

async function sources(dir: string) {
  const response = await request(dir)
  expect(response.status).toBe(200)
  return (await response.json()) as Body
}

function request(dir: string) {
  return Server.Default().app.request("/config/sources", {
    headers: { "x-kilo-directory": dir },
  })
}

function order(body: Body, file: string) {
  const hit = body.sources.find((source) => source.path === file)
  expect(hit).toBeDefined()
  return hit!.order
}

describe("config source routes", () => {
  test("lists source metadata in load order without config contents", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "env.json"), "{}")
        await Bun.write(path.join(dir, "kilo.json"), "{}")

        for (const root of [".opencode", ".kilocode", ".kilo", ".raya"]) {
          const local = path.join(dir, root)
          await fs.mkdir(local, { recursive: true })
          await Bun.write(path.join(local, "kilo.jsonc"), "{}")
        }

        const extra = path.join(dir, "extra")
        await fs.mkdir(extra, { recursive: true })
        await Bun.write(path.join(extra, "opencode.json"), "{}")

        const managed = path.join(dir, "managed")
        await fs.mkdir(managed, { recursive: true })
        await Bun.write(path.join(managed, "kilo.json"), "{}")
      },
    })

    const envFile = path.join(tmp.path, "env.json")
    const projectFile = path.join(tmp.path, "kilo.json")
    const opencodeFile = path.join(tmp.path, ".opencode", "kilo.jsonc")
    const kilocodeFile = path.join(tmp.path, ".kilocode", "kilo.jsonc")
    const configFile = path.join(tmp.path, ".kilo", "kilo.jsonc")
    const rayaFile = path.join(tmp.path, ".raya", "kilo.jsonc")
    const extraFile = path.join(tmp.path, "extra", "opencode.json")
    const managedFile = path.join(tmp.path, "managed", "kilo.json")

    process.env.KILO_CONFIG = envFile
    process.env.KILO_CONFIG_CONTENT = '{"username":"secret-inline-value"}'
    process.env.KILO_CONFIG_DIR = path.join(tmp.path, "extra")
    process.env.KILO_TEST_MANAGED_CONFIG_DIR = path.join(tmp.path, "managed")

    const body = await sources(tmp.path)
    const inline = body.sources.find((source) => source.source === "KILO_CONFIG_CONTENT")

    expect(order(body, envFile)).toBeLessThan(order(body, projectFile))
    expect(order(body, projectFile)).toBeLessThan(order(body, kilocodeFile))
    expect(order(body, kilocodeFile)).toBeLessThan(order(body, configFile))
    expect(order(body, configFile)).toBeLessThan(order(body, rayaFile))
    expect(body.sources.some((source) => source.path === opencodeFile)).toBe(false)
    expect(order(body, rayaFile)).toBeLessThan(order(body, extraFile))
    expect(inline?.order).toBeGreaterThan(order(body, extraFile))
    expect(inline?.order).toBeLessThan(order(body, managedFile))

    expect(body.sources.find((source) => source.path === configFile)).toMatchObject({
      kind: "config-dir-file",
      scope: "project",
      exists: true,
      editable: true,
    })
    expect(body.sources.find((source) => source.path === managedFile)).toMatchObject({
      kind: "managed-file",
      scope: "managed",
      exists: true,
      editable: false,
    })
    expect(JSON.stringify(body)).not.toContain("secret-inline-value")
  })

  test.each([
    ["1", undefined, "RAYA_DISABLE_PROJECT_CONFIG"],
    [undefined, "1", "KILO_DISABLE_PROJECT_CONFIG"],
    ["1", "false", "RAYA_DISABLE_PROJECT_CONFIG"],
  ] as const)("reports the effective project-config opt-out variable", async (raya, kilo, source) => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "kilo.json"), "{}")
        await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
        await Bun.write(path.join(dir, ".kilo", "kilo.json"), "{}")
      },
    })

    set("RAYA_DISABLE_PROJECT_CONFIG", raya)
    set("KILO_DISABLE_PROJECT_CONFIG", kilo)

    const body = await sources(tmp.path)

    expect(body.sources.some((source) => source.path === path.join(tmp.path, "kilo.json"))).toBe(false)
    expect(body.sources.some((source) => source.path === path.join(tmp.path, ".kilo", "kilo.json"))).toBe(false)
    expect(body.sources.find((item) => item.source === source)).toMatchObject({
      kind: "runtime-env",
      scope: "env",
      label: source,
      exists: true,
      editable: false,
    })
  })

  test.each([
    ["1", undefined, "RAYA"] as const,
    [undefined, "1", "KILO"] as const,
    ["1", "0", "RAYA"] as const,
    ["0", "1", "KILO"] as const,
    ["", "1", "KILO"] as const,
    ["secret-inline-value", "1", "KILO"] as const,
    ["invalid", "1", "KILO"] as const,
  ])("reports the effective compaction safety aliases without values", async (raya, kilo, prefix) => {
    await using tmp = await tmpdir()
    set("RAYA_DISABLE_AUTOCOMPACT", raya)
    set("KILO_DISABLE_AUTOCOMPACT", kilo)
    set("RAYA_DISABLE_PRUNE", raya)
    set("KILO_DISABLE_PRUNE", kilo)

    const body = await sources(tmp.path)
    const compact = body.sources.find((item) => item.source === `${prefix}_DISABLE_AUTOCOMPACT`)
    const prune = body.sources.find((item) => item.source === `${prefix}_DISABLE_PRUNE`)

    for (const item of [compact, prune]) {
      expect(item).toMatchObject({
        kind: "runtime-env",
        scope: "env",
        label: item?.source,
        exists: true,
        editable: false,
      })
      expect(item).not.toHaveProperty("value")
    }
    expect(JSON.stringify(body)).not.toContain("secret-inline-value")
  })

  test.each([["false", undefined] as const, ["false", "0"] as const, [undefined, undefined] as const])(
    "omits disabled compaction safety aliases",
    async (raya, kilo) => {
      await using tmp = await tmpdir()
      set("RAYA_DISABLE_AUTOCOMPACT", raya)
      set("KILO_DISABLE_AUTOCOMPACT", kilo)
      set("RAYA_DISABLE_PRUNE", raya)
      set("KILO_DISABLE_PRUNE", kilo)

      const body = await sources(tmp.path)
      expect(
        body.sources.some((item) =>
          ["RAYA_DISABLE_AUTOCOMPACT", "KILO_DISABLE_AUTOCOMPACT", "RAYA_DISABLE_PRUNE", "KILO_DISABLE_PRUNE"].includes(
            item.source,
          ),
        ),
      ).toBe(false)
    },
  )

  test.each([
    ['{"raya-source-secret":"deny"}', undefined, ["RAYA_PERMISSION"]],
    [undefined, '{"legacy-source-secret":"deny"}', ["KILO_PERMISSION"]],
    [
      '{"matched-source-secret":{"*":"deny"}}',
      '{ "matched-source-secret": { "*": "deny" } }',
      ["RAYA_PERMISSION", "KILO_PERMISSION"],
    ],
  ] as const)("reports defined permission aliases without their values", async (raya, kilo, labels) => {
    await using tmp = await tmpdir()
    set("RAYA_PERMISSION", raya)
    set("KILO_PERMISSION", kilo)

    const body = await sources(tmp.path)
    const found = body.sources.filter((item) => labels.some((label) => label === item.source))
    expect(found.map((item) => item.source)).toEqual([...labels])
    expect(found.every((item) => item.kind === "runtime-env" && item.scope === "env" && !item.editable)).toBe(true)
    expect(JSON.stringify(body)).not.toContain("source-secret")
  })

  test("fails closed and redacts conflicting permission sources", async () => {
    await using tmp = await tmpdir()
    set("RAYA_PERMISSION", '{"raya-source-secret":"allow"}')
    set("KILO_PERMISSION", '{"legacy-source-secret":"deny"}')

    const response = await request(tmp.path)
    expect(response.status).toBeGreaterThanOrEqual(400)
    const text = await response.text()
    expect(text).not.toContain("raya-source-secret")
    expect(text).not.toContain("legacy-source-secret")
  })
})
