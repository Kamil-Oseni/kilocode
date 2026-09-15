import { describe, expect, test } from "bun:test"
import { EnvAlias } from "../../src/kilocode/env-alias"

describe("Raya environment aliases", () => {
  for (const item of [
    { name: "neither name", env: {}, expected: undefined },
    { name: "legacy fallback", env: { KILO_CONFIG: "legacy" }, expected: "legacy" },
    { name: "Raya name", env: { RAYA_CONFIG: "raya" }, expected: "raya" },
    {
      name: "matching names",
      env: { RAYA_CONFIG: "same", KILO_CONFIG: "same" },
      expected: "same",
    },
    {
      name: "Raya precedence",
      env: { RAYA_CONFIG: "raya", KILO_CONFIG: "legacy" },
      expected: "raya",
    },
    {
      name: "explicit empty Raya value",
      env: { RAYA_CONFIG: "", KILO_CONFIG: "legacy" },
      expected: "",
    },
  ]) {
    test(`resolves ${item.name}`, () => {
      EnvAlias.conflicts()
      expect(EnvAlias.read("RAYA_CONFIG", "KILO_CONFIG", item.env)).toBe(item.expected)
    })
  }

  test("reports each conflicting pair once without values", () => {
    EnvAlias.conflicts()
    const env = { RAYA_AUTH_CONTENT: "raya-secret", KILO_AUTH_CONTENT: "legacy-secret" }
    EnvAlias.read("RAYA_AUTH_CONTENT", "KILO_AUTH_CONTENT", env)
    EnvAlias.read("RAYA_AUTH_CONTENT", "KILO_AUTH_CONTENT", env)

    const conflicts = EnvAlias.conflicts()
    expect(conflicts).toEqual(["RAYA_AUTH_CONTENT/KILO_AUTH_CONTENT"])
    expect(JSON.stringify(conflicts)).not.toContain("secret")
    expect(EnvAlias.conflicts()).toEqual([])
  })

  test("writes one effective value through both names", () => {
    const env: NodeJS.ProcessEnv = {
      RAYA_CONFIG: "raya.json",
      KILO_CONFIG: "legacy.json",
    }

    EnvAlias.write("RAYA_CONFIG", "KILO_CONFIG", "override.json", env)
    expect(env).toEqual({
      RAYA_CONFIG: "override.json",
      KILO_CONFIG: "override.json",
    })
    expect(EnvAlias.read("RAYA_CONFIG", "KILO_CONFIG", env)).toBe("override.json")

    EnvAlias.write("RAYA_CONFIG", "KILO_CONFIG", undefined, env)
    expect(env).toEqual({})
    expect(EnvAlias.read("RAYA_CONFIG", "KILO_CONFIG", env)).toBeUndefined()
  })

  test("keeps mutable legacy Flag properties writable", () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; Flag.KILO_CONFIG = "override.json"; Flag.KILO_DB = "override.db"; console.log(JSON.stringify([Flag.KILO_CONFIG, process.env.RAYA_CONFIG, process.env.KILO_CONFIG, Flag.KILO_DB, process.env.RAYA_DB, process.env.KILO_DB]))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        RAYA_CONFIG: "raya.json",
        KILO_CONFIG: "legacy.json",
        RAYA_DB: "raya.db",
        KILO_DB: "legacy.db",
      },
    })

    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual([
      "override.json",
      "override.json",
      "override.json",
      "override.db",
      "override.db",
      "override.db",
    ])
  })

  test("aliases operator path overrides without removing mutable Kilo access", () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; const initial = [Flag.KILO_GIT_BASH_PATH, Flag.KILO_MODELS_PATH]; Flag.KILO_GIT_BASH_PATH = "written-bash"; Flag.KILO_MODELS_PATH = "written-models"; console.log(JSON.stringify([...initial, process.env.RAYA_GIT_BASH_PATH, process.env.KILO_GIT_BASH_PATH, process.env.RAYA_MODELS_PATH, process.env.KILO_MODELS_PATH]))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        RAYA_GIT_BASH_PATH: "raya-bash",
        KILO_GIT_BASH_PATH: "legacy-bash",
        RAYA_MODELS_PATH: "raya-models",
        KILO_MODELS_PATH: "legacy-models",
      },
    })

    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual([
      "raya-bash",
      "raya-models",
      "written-bash",
      "written-bash",
      "written-models",
      "written-models",
    ])
  })

  for (const item of [
    {
      name: "legacy inputs",
      env: {
        KILO_CONFIG: "legacy-file",
        KILO_CONFIG_CONTENT: "legacy-content",
        KILO_CONFIG_DIR: "legacy-dir",
        KILO_DB: "legacy.db",
      },
      expected: ["legacy-file", "legacy-content", "legacy-dir", "legacy.db"],
    },
    {
      name: "Raya inputs over conflicting legacy inputs",
      env: {
        RAYA_CONFIG: "raya-file",
        KILO_CONFIG: "legacy-file",
        RAYA_CONFIG_CONTENT: "raya-content",
        KILO_CONFIG_CONTENT: "legacy-content",
        RAYA_CONFIG_DIR: "raya-dir",
        KILO_CONFIG_DIR: "legacy-dir",
        RAYA_DB: "raya.db",
        KILO_DB: "legacy.db",
      },
      expected: ["raya-file", "raya-content", "raya-dir", "raya.db"],
    },
  ]) {
    test(`wires ${item.name} through legacy Flag properties`, () => {
      const names = [
        "RAYA_CONFIG",
        "KILO_CONFIG",
        "RAYA_CONFIG_CONTENT",
        "KILO_CONFIG_CONTENT",
        "RAYA_CONFIG_DIR",
        "KILO_CONFIG_DIR",
        "RAYA_DB",
        "KILO_DB",
      ]
      const env = { ...process.env }
      for (const name of names) delete env[name]
      Object.assign(env, item.env)
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify([Flag.KILO_CONFIG, Flag.KILO_CONFIG_CONTENT, Flag.KILO_CONFIG_DIR, Flag.KILO_DB]))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toEqual(item.expected)
    })
  }
})
