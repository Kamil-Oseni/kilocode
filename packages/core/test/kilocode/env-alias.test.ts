import { describe, expect, test } from "bun:test"
import { EnvAlias } from "../../src/kilocode/env-alias"

function claude(input: NodeJS.ProcessEnv) {
  const names = [
    "RAYA_DISABLE_CLAUDE_CODE",
    "KILO_DISABLE_CLAUDE_CODE",
    "RAYA_DISABLE_CLAUDE_CODE_PROMPT",
    "KILO_DISABLE_CLAUDE_CODE_PROMPT",
    "RAYA_DISABLE_CLAUDE_CODE_SKILLS",
    "KILO_DISABLE_CLAUDE_CODE_SKILLS",
  ]
  const env = { ...process.env }
  for (const name of names) delete env[name]
  Object.assign(env, input)
  const child = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      'import { Flag } from "./src/flag/flag.ts"; import { EnvAlias } from "./src/kilocode/env-alias.ts"; console.log(JSON.stringify({ flags: [Flag.KILO_DISABLE_CLAUDE_CODE, Flag.KILO_DISABLE_CLAUDE_CODE_PROMPT, Flag.KILO_DISABLE_CLAUDE_CODE_SKILLS], conflicts: EnvAlias.conflicts() }))',
    ],
    cwd: `${import.meta.dir}/../..`,
    env,
  })

  expect(child.exitCode).toBe(0)
  return child.stdout.toString()
}

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

  for (const item of [
    { name: "neither name", env: {}, expected: false },
    { name: "Raya true", env: { RAYA_PURE: "true" }, expected: true },
    { name: "Kilo true", env: { KILO_PURE: "1" }, expected: true },
    { name: "both true", env: { RAYA_PURE: "true", KILO_PURE: "true" }, expected: true },
    { name: "Raya false and Kilo true", env: { RAYA_PURE: "false", KILO_PURE: "true" }, expected: true },
    { name: "Raya true and Kilo false", env: { RAYA_PURE: "1", KILO_PURE: "0" }, expected: true },
    { name: "empty Raya and Kilo true", env: { RAYA_PURE: "", KILO_PURE: "true" }, expected: true },
  ]) {
    test(`resolves safety-sensitive boolean aliases from ${item.name}`, () => {
      EnvAlias.conflicts()
      expect(EnvAlias.enabled("RAYA_PURE", "KILO_PURE", item.env)).toBe(item.expected)
    })
  }

  test("reports safety-sensitive boolean conflicts without their values", () => {
    EnvAlias.conflicts()
    EnvAlias.enabled("RAYA_PURE", "KILO_PURE", { RAYA_PURE: "raya-secret", KILO_PURE: "legacy-secret" })

    const conflicts = EnvAlias.conflicts()
    expect(conflicts).toEqual(["RAYA_PURE/KILO_PURE"])
    expect(JSON.stringify(conflicts)).not.toContain("secret")
  })

  test("resolves injected safety-sensitive values with the same conflict policy", () => {
    EnvAlias.conflicts()
    expect(EnvAlias.enabledValues("RAYA_PURE", "KILO_PURE", "false", "1")).toBe(true)
    expect(EnvAlias.conflicts()).toEqual(["RAYA_PURE/KILO_PURE"])
    expect(EnvAlias.enabledValues("RAYA_PURE", "KILO_PURE", undefined, undefined)).toBe(false)
  })

  test("wires safety-sensitive boolean aliases through the legacy Flag property", () => {
    const names = ["RAYA_PURE", "KILO_PURE"]
    const env = { ...process.env }
    for (const name of names) delete env[name]
    Object.assign(env, { RAYA_PURE: "false", KILO_PURE: "true" })
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify(Flag.KILO_PURE))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toBe(true)
  })

  for (const item of [
    { name: "neither name", raya: undefined, kilo: undefined, expected: false },
    { name: "Raya true", raya: "TRUE", kilo: undefined, expected: true },
    { name: "Kilo true", raya: undefined, kilo: "1", expected: true },
    { name: "both true", raya: "true", kilo: "true", expected: true },
    { name: "Raya false and Kilo true", raya: "false", kilo: "true", expected: false },
    { name: "Raya true and Kilo false", raya: "1", kilo: "0", expected: true },
    { name: "empty Raya and Kilo true", raya: "", kilo: "true", expected: false },
    { name: "invalid Raya and Kilo true", raya: "invalid", kilo: "1", expected: false },
  ]) {
    test(`wires automatic heap snapshots from ${item.name}`, () => {
      const env = { ...process.env }
      delete env.RAYA_AUTO_HEAP_SNAPSHOT
      delete env.KILO_AUTO_HEAP_SNAPSHOT
      if (item.raya !== undefined) env.RAYA_AUTO_HEAP_SNAPSHOT = item.raya
      if (item.kilo !== undefined) env.KILO_AUTO_HEAP_SNAPSHOT = item.kilo
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify(Flag.KILO_AUTO_HEAP_SNAPSHOT))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toBe(item.expected)
    })
  }

  test("reports the automatic heap snapshot alias conflict without its values", () => {
    const env = { ...process.env }
    env.RAYA_AUTO_HEAP_SNAPSHOT = "raya-secret"
    env.KILO_AUTO_HEAP_SNAPSHOT = "kilo-secret"
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; import { EnvAlias } from "./src/kilocode/env-alias.ts"; console.log(JSON.stringify({ flag: Flag.KILO_AUTO_HEAP_SNAPSHOT, conflicts: EnvAlias.conflicts() }))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    const output = child.stdout.toString()
    expect(JSON.parse(output)).toEqual({
      flag: false,
      conflicts: ["RAYA_AUTO_HEAP_SNAPSHOT/KILO_AUTO_HEAP_SNAPSHOT"],
    })
    expect(output).not.toContain("secret")
  })

  for (const item of [
    { name: "neither name", raya: undefined, kilo: undefined, expected: false },
    { name: "Raya true", raya: "TRUE", kilo: undefined, expected: true },
    { name: "Kilo true", raya: undefined, kilo: "1", expected: true },
    { name: "both true", raya: "true", kilo: "true", expected: true },
    { name: "Raya false and Kilo true", raya: "false", kilo: "true", expected: false },
    { name: "Raya true and Kilo false", raya: "1", kilo: "0", expected: true },
    { name: "empty Raya and Kilo true", raya: "", kilo: "true", expected: false },
    { name: "invalid Raya and Kilo true", raya: "invalid", kilo: "1", expected: false },
  ]) {
    test(`wires clarification questions from ${item.name}`, () => {
      const env = { ...process.env }
      delete env.RAYA_ENABLE_QUESTION_TOOL
      delete env.KILO_ENABLE_QUESTION_TOOL
      if (item.raya !== undefined) env.RAYA_ENABLE_QUESTION_TOOL = item.raya
      if (item.kilo !== undefined) env.KILO_ENABLE_QUESTION_TOOL = item.kilo
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify(Flag.KILO_ENABLE_QUESTION_TOOL))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toBe(item.expected)
    })
  }

  test("reports the clarification question alias conflict without its values", () => {
    const env = { ...process.env }
    env.RAYA_ENABLE_QUESTION_TOOL = "raya-secret"
    env.KILO_ENABLE_QUESTION_TOOL = "kilo-secret"
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; import { EnvAlias } from "./src/kilocode/env-alias.ts"; console.log(JSON.stringify({ flag: Flag.KILO_ENABLE_QUESTION_TOOL, conflicts: EnvAlias.conflicts() }))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    const output = child.stdout.toString()
    expect(JSON.parse(output)).toEqual({
      flag: false,
      conflicts: ["RAYA_ENABLE_QUESTION_TOOL/KILO_ENABLE_QUESTION_TOOL"],
    })
    expect(output).not.toContain("secret")
  })

  for (const item of [
    { name: "neither name", raya: undefined, kilo: undefined, expected: false },
    { name: "Raya true", raya: "true", kilo: undefined, expected: true },
    { name: "Kilo true", raya: undefined, kilo: "1", expected: true },
    { name: "both true", raya: "true", kilo: "true", expected: true },
    { name: "Raya false and Kilo true", raya: "false", kilo: "true", expected: true },
    { name: "Raya true and Kilo false", raya: "1", kilo: "0", expected: true },
    { name: "empty Raya and Kilo true", raya: "", kilo: "true", expected: true },
    { name: "invalid Raya and Kilo true", raya: "invalid", kilo: "1", expected: true },
  ]) {
    test(`wires compaction safety flags from ${item.name}`, () => {
      const names = ["RAYA_DISABLE_AUTOCOMPACT", "KILO_DISABLE_AUTOCOMPACT", "RAYA_DISABLE_PRUNE", "KILO_DISABLE_PRUNE"]
      const env = { ...process.env }
      for (const name of names) delete env[name]
      if (item.raya !== undefined) {
        env.RAYA_DISABLE_AUTOCOMPACT = item.raya
        env.RAYA_DISABLE_PRUNE = item.raya
      }
      if (item.kilo !== undefined) {
        env.KILO_DISABLE_AUTOCOMPACT = item.kilo
        env.KILO_DISABLE_PRUNE = item.kilo
      }
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify([Flag.KILO_DISABLE_AUTOCOMPACT, Flag.KILO_DISABLE_PRUNE]))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toEqual([item.expected, item.expected])
    })
  }

  test("reports compaction safety flag conflicts without their values", () => {
    const names = ["RAYA_DISABLE_AUTOCOMPACT", "KILO_DISABLE_AUTOCOMPACT", "RAYA_DISABLE_PRUNE", "KILO_DISABLE_PRUNE"]
    const env = { ...process.env }
    for (const name of names) delete env[name]
    Object.assign(env, {
      RAYA_DISABLE_AUTOCOMPACT: "raya-auto-secret",
      KILO_DISABLE_AUTOCOMPACT: "kilo-auto-secret",
      RAYA_DISABLE_PRUNE: "raya-prune-secret",
      KILO_DISABLE_PRUNE: "kilo-prune-secret",
    })
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; import { EnvAlias } from "./src/kilocode/env-alias.ts"; console.log(JSON.stringify({ flags: [Flag.KILO_DISABLE_AUTOCOMPACT, Flag.KILO_DISABLE_PRUNE], conflicts: EnvAlias.conflicts() }))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    const output = child.stdout.toString()
    expect(JSON.parse(output)).toEqual({
      flags: [false, false],
      conflicts: ["RAYA_DISABLE_AUTOCOMPACT/KILO_DISABLE_AUTOCOMPACT", "RAYA_DISABLE_PRUNE/KILO_DISABLE_PRUNE"],
    })
    expect(output).not.toContain("secret")
  })

  for (const item of [
    { name: "neither name", raya: undefined, kilo: undefined, expected: false },
    { name: "Raya true", raya: "true", kilo: undefined, expected: true },
    { name: "Kilo true", raya: undefined, kilo: "1", expected: true },
    { name: "both true", raya: "true", kilo: "true", expected: true },
    { name: "Raya false and Kilo true", raya: "false", kilo: "true", expected: true },
    { name: "Raya true and Kilo false", raya: "1", kilo: "0", expected: true },
    { name: "empty Raya and Kilo true", raya: "", kilo: "true", expected: true },
    { name: "invalid Raya and Kilo true", raya: "invalid", kilo: "1", expected: true },
  ]) {
    test(`wires plugin safety flags from ${item.name}`, () => {
      const names = [
        "RAYA_DISABLE_DEFAULT_PLUGINS",
        "KILO_DISABLE_DEFAULT_PLUGINS",
        "RAYA_DISABLE_LSP_DOWNLOAD",
        "KILO_DISABLE_LSP_DOWNLOAD",
      ]
      const env = { ...process.env }
      for (const name of names) delete env[name]
      if (item.raya !== undefined) {
        env.RAYA_DISABLE_DEFAULT_PLUGINS = item.raya
        env.RAYA_DISABLE_LSP_DOWNLOAD = item.raya
      }
      if (item.kilo !== undefined) {
        env.KILO_DISABLE_DEFAULT_PLUGINS = item.kilo
        env.KILO_DISABLE_LSP_DOWNLOAD = item.kilo
      }
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify([Flag.KILO_DISABLE_DEFAULT_PLUGINS, Flag.KILO_DISABLE_LSP_DOWNLOAD]))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toEqual([item.expected, item.expected])
    })
  }

  test("reports plugin safety flag conflicts without their values", () => {
    const names = [
      "RAYA_DISABLE_DEFAULT_PLUGINS",
      "KILO_DISABLE_DEFAULT_PLUGINS",
      "RAYA_DISABLE_LSP_DOWNLOAD",
      "KILO_DISABLE_LSP_DOWNLOAD",
    ]
    const env = { ...process.env }
    for (const name of names) delete env[name]
    Object.assign(env, {
      RAYA_DISABLE_DEFAULT_PLUGINS: "raya-plugin-secret",
      KILO_DISABLE_DEFAULT_PLUGINS: "kilo-plugin-secret",
      RAYA_DISABLE_LSP_DOWNLOAD: "raya-lsp-secret",
      KILO_DISABLE_LSP_DOWNLOAD: "kilo-lsp-secret",
    })
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; import { EnvAlias } from "./src/kilocode/env-alias.ts"; console.log(JSON.stringify({ flags: [Flag.KILO_DISABLE_DEFAULT_PLUGINS, Flag.KILO_DISABLE_LSP_DOWNLOAD], conflicts: EnvAlias.conflicts() }))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    const output = child.stdout.toString()
    expect(JSON.parse(output)).toEqual({
      flags: [false, false],
      conflicts: [
        "RAYA_DISABLE_DEFAULT_PLUGINS/KILO_DISABLE_DEFAULT_PLUGINS",
        "RAYA_DISABLE_LSP_DOWNLOAD/KILO_DISABLE_LSP_DOWNLOAD",
      ],
    })
    expect(output).not.toContain("secret")
  })

  for (const item of [
    { name: "neither name", raya: undefined, kilo: undefined, expected: false },
    { name: "Raya true", raya: "true", kilo: undefined, expected: true },
    { name: "Kilo true", raya: undefined, kilo: "1", expected: true },
    { name: "both true", raya: "true", kilo: "true", expected: true },
    { name: "Raya false and Kilo true", raya: "false", kilo: "true", expected: true },
    { name: "Raya true and Kilo false", raya: "1", kilo: "0", expected: true },
    { name: "empty Raya and Kilo true", raya: "", kilo: "true", expected: true },
    { name: "invalid Raya and Kilo true", raya: "invalid", kilo: "1", expected: true },
  ]) {
    test(`wires runtime safety flags from ${item.name}`, () => {
      const names = [
        "RAYA_DISABLE_AUTOUPDATE",
        "KILO_DISABLE_AUTOUPDATE",
        "RAYA_ALWAYS_NOTIFY_UPDATE",
        "KILO_ALWAYS_NOTIFY_UPDATE",
        "RAYA_DISABLE_MODELS_FETCH",
        "KILO_DISABLE_MODELS_FETCH",
        "RAYA_DISABLE_TERMINAL_TITLE",
        "KILO_DISABLE_TERMINAL_TITLE",
        "RAYA_DISABLE_CHANNEL_DB",
        "KILO_DISABLE_CHANNEL_DB",
        "RAYA_DISABLE_EMBEDDED_WEB_UI",
        "KILO_DISABLE_EMBEDDED_WEB_UI",
        "RAYA_DISABLE_EXTERNAL_SKILLS",
        "KILO_DISABLE_EXTERNAL_SKILLS",
        "RAYA_SKIP_MIGRATIONS",
        "KILO_SKIP_MIGRATIONS",
      ]
      const env = { ...process.env }
      for (const name of names) delete env[name]
      if (item.raya !== undefined) {
        env.RAYA_DISABLE_AUTOUPDATE = item.raya
        env.RAYA_ALWAYS_NOTIFY_UPDATE = item.raya
        env.RAYA_DISABLE_MODELS_FETCH = item.raya
        env.RAYA_DISABLE_TERMINAL_TITLE = item.raya
        env.RAYA_DISABLE_CHANNEL_DB = item.raya
        env.RAYA_DISABLE_EMBEDDED_WEB_UI = item.raya
        env.RAYA_DISABLE_EXTERNAL_SKILLS = item.raya
        env.RAYA_SKIP_MIGRATIONS = item.raya
      }
      if (item.kilo !== undefined) {
        env.KILO_DISABLE_AUTOUPDATE = item.kilo
        env.KILO_ALWAYS_NOTIFY_UPDATE = item.kilo
        env.KILO_DISABLE_MODELS_FETCH = item.kilo
        env.KILO_DISABLE_TERMINAL_TITLE = item.kilo
        env.KILO_DISABLE_CHANNEL_DB = item.kilo
        env.KILO_DISABLE_EMBEDDED_WEB_UI = item.kilo
        env.KILO_DISABLE_EXTERNAL_SKILLS = item.kilo
        env.KILO_SKIP_MIGRATIONS = item.kilo
      }
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify([Flag.KILO_DISABLE_AUTOUPDATE, Flag.KILO_ALWAYS_NOTIFY_UPDATE, Flag.KILO_DISABLE_MODELS_FETCH, Flag.KILO_DISABLE_TERMINAL_TITLE, Flag.KILO_DISABLE_CHANNEL_DB, Flag.KILO_DISABLE_EMBEDDED_WEB_UI, Flag.KILO_DISABLE_EXTERNAL_SKILLS, Flag.KILO_SKIP_MIGRATIONS]))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toEqual([
        item.expected,
        item.expected,
        item.expected,
        item.expected,
        item.expected,
        item.expected,
        item.expected,
        item.expected,
      ])
    })
  }

  test("reports runtime safety flag conflicts without their values", () => {
    const names = [
      "RAYA_DISABLE_AUTOUPDATE",
      "KILO_DISABLE_AUTOUPDATE",
      "RAYA_ALWAYS_NOTIFY_UPDATE",
      "KILO_ALWAYS_NOTIFY_UPDATE",
      "RAYA_DISABLE_MODELS_FETCH",
      "KILO_DISABLE_MODELS_FETCH",
      "RAYA_DISABLE_TERMINAL_TITLE",
      "KILO_DISABLE_TERMINAL_TITLE",
      "RAYA_DISABLE_CHANNEL_DB",
      "KILO_DISABLE_CHANNEL_DB",
      "RAYA_DISABLE_EMBEDDED_WEB_UI",
      "KILO_DISABLE_EMBEDDED_WEB_UI",
      "RAYA_DISABLE_EXTERNAL_SKILLS",
      "KILO_DISABLE_EXTERNAL_SKILLS",
      "RAYA_SKIP_MIGRATIONS",
      "KILO_SKIP_MIGRATIONS",
    ]
    const env = { ...process.env }
    for (const name of names) delete env[name]
    Object.assign(env, {
      RAYA_DISABLE_AUTOUPDATE: "raya-update-secret",
      KILO_DISABLE_AUTOUPDATE: "kilo-update-secret",
      RAYA_ALWAYS_NOTIFY_UPDATE: "raya-notify-secret",
      KILO_ALWAYS_NOTIFY_UPDATE: "kilo-notify-secret",
      RAYA_DISABLE_MODELS_FETCH: "raya-model-secret",
      KILO_DISABLE_MODELS_FETCH: "kilo-model-secret",
      RAYA_DISABLE_TERMINAL_TITLE: "raya-terminal-secret",
      KILO_DISABLE_TERMINAL_TITLE: "kilo-terminal-secret",
      RAYA_DISABLE_CHANNEL_DB: "raya-database-secret",
      KILO_DISABLE_CHANNEL_DB: "kilo-database-secret",
      RAYA_DISABLE_EMBEDDED_WEB_UI: "raya-web-secret",
      KILO_DISABLE_EMBEDDED_WEB_UI: "kilo-web-secret",
      RAYA_DISABLE_EXTERNAL_SKILLS: "raya-skills-secret",
      KILO_DISABLE_EXTERNAL_SKILLS: "kilo-skills-secret",
      RAYA_SKIP_MIGRATIONS: "raya-migration-secret",
      KILO_SKIP_MIGRATIONS: "kilo-migration-secret",
    })
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; import { EnvAlias } from "./src/kilocode/env-alias.ts"; console.log(JSON.stringify({ flags: [Flag.KILO_DISABLE_AUTOUPDATE, Flag.KILO_ALWAYS_NOTIFY_UPDATE, Flag.KILO_DISABLE_MODELS_FETCH, Flag.KILO_DISABLE_TERMINAL_TITLE, Flag.KILO_DISABLE_CHANNEL_DB, Flag.KILO_DISABLE_EMBEDDED_WEB_UI, Flag.KILO_DISABLE_EXTERNAL_SKILLS, Flag.KILO_SKIP_MIGRATIONS], conflicts: EnvAlias.conflicts() }))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    const output = child.stdout.toString()
    expect(JSON.parse(output)).toEqual({
      flags: [false, false, false, false, false, false, false, false],
      conflicts: [
        "RAYA_ALWAYS_NOTIFY_UPDATE/KILO_ALWAYS_NOTIFY_UPDATE",
        "RAYA_DISABLE_AUTOUPDATE/KILO_DISABLE_AUTOUPDATE",
        "RAYA_DISABLE_CHANNEL_DB/KILO_DISABLE_CHANNEL_DB",
        "RAYA_DISABLE_EMBEDDED_WEB_UI/KILO_DISABLE_EMBEDDED_WEB_UI",
        "RAYA_DISABLE_EXTERNAL_SKILLS/KILO_DISABLE_EXTERNAL_SKILLS",
        "RAYA_DISABLE_MODELS_FETCH/KILO_DISABLE_MODELS_FETCH",
        "RAYA_DISABLE_TERMINAL_TITLE/KILO_DISABLE_TERMINAL_TITLE",
        "RAYA_SKIP_MIGRATIONS/KILO_SKIP_MIGRATIONS",
      ],
    })
    expect(output).not.toContain("secret")
  })

  for (const item of [
    { name: "neither name", raya: undefined, kilo: undefined, expected: false },
    { name: "Raya true", raya: "true", kilo: undefined, expected: true },
    { name: "Kilo true", raya: undefined, kilo: "1", expected: true },
    { name: "both true", raya: "true", kilo: "true", expected: true },
    { name: "Raya false and Kilo true", raya: "false", kilo: "true", expected: true },
    { name: "Raya true and Kilo false", raya: "1", kilo: "0", expected: true },
    { name: "empty Raya and Kilo true", raya: "", kilo: "true", expected: true },
    { name: "invalid Raya and Kilo true", raya: "invalid", kilo: "1", expected: true },
  ]) {
    test(`wires direct Claude safety aliases from ${item.name}`, () => {
      const env: NodeJS.ProcessEnv = {}
      if (item.raya !== undefined) {
        env.RAYA_DISABLE_CLAUDE_CODE_PROMPT = item.raya
        env.RAYA_DISABLE_CLAUDE_CODE_SKILLS = item.raya
      }
      if (item.kilo !== undefined) {
        env.KILO_DISABLE_CLAUDE_CODE_PROMPT = item.kilo
        env.KILO_DISABLE_CLAUDE_CODE_SKILLS = item.kilo
      }

      expect(JSON.parse(claude(env)).flags).toEqual([false, item.expected, item.expected])
    })

    test(`inherits the broad Claude safety alias from ${item.name}`, () => {
      const env: NodeJS.ProcessEnv = {
        RAYA_DISABLE_CLAUDE_CODE_PROMPT: "false",
        RAYA_DISABLE_CLAUDE_CODE_SKILLS: "invalid",
      }
      if (item.raya !== undefined) env.RAYA_DISABLE_CLAUDE_CODE = item.raya
      if (item.kilo !== undefined) env.KILO_DISABLE_CLAUDE_CODE = item.kilo

      expect(JSON.parse(claude(env)).flags).toEqual([item.expected, item.expected, item.expected])
    })
  }

  for (const item of [
    {
      name: "prompt",
      env: { RAYA_DISABLE_CLAUDE_CODE_PROMPT: "true" },
      expected: [false, true, false],
    },
    {
      name: "skills",
      env: { KILO_DISABLE_CLAUDE_CODE_SKILLS: "1" },
      expected: [false, false, true],
    },
  ]) {
    test(`keeps the direct Claude ${item.name} switch independent`, () => {
      expect(JSON.parse(claude(item.env)).flags).toEqual(item.expected)
    })
  }

  test("reports Claude safety alias conflicts without their values", () => {
    const output = claude({
      RAYA_DISABLE_CLAUDE_CODE: "raya-broad-secret",
      KILO_DISABLE_CLAUDE_CODE: "kilo-broad-secret",
      RAYA_DISABLE_CLAUDE_CODE_PROMPT: "raya-prompt-secret",
      KILO_DISABLE_CLAUDE_CODE_PROMPT: "kilo-prompt-secret",
      RAYA_DISABLE_CLAUDE_CODE_SKILLS: "raya-skills-secret",
      KILO_DISABLE_CLAUDE_CODE_SKILLS: "kilo-skills-secret",
    })

    expect(JSON.parse(output)).toEqual({
      flags: [false, false, false],
      conflicts: [
        "RAYA_DISABLE_CLAUDE_CODE/KILO_DISABLE_CLAUDE_CODE",
        "RAYA_DISABLE_CLAUDE_CODE_PROMPT/KILO_DISABLE_CLAUDE_CODE_PROMPT",
        "RAYA_DISABLE_CLAUDE_CODE_SKILLS/KILO_DISABLE_CLAUDE_CODE_SKILLS",
      ],
    })
    expect(output).not.toContain("secret")
  })

  for (const item of [
    { name: "Raya input", env: { RAYA_SHOW_TTFD: "true" }, expected: true },
    { name: "Kilo fallback", env: { KILO_SHOW_TTFD: "1" }, expected: true },
    {
      name: "false Raya precedence",
      env: { RAYA_SHOW_TTFD: "false", KILO_SHOW_TTFD: "true" },
      expected: false,
    },
    {
      name: "empty Raya precedence",
      env: { RAYA_SHOW_TTFD: "", KILO_SHOW_TTFD: "true" },
      expected: false,
    },
  ]) {
    test(`wires the time-to-first-draw flag from ${item.name}`, () => {
      const names = ["RAYA_SHOW_TTFD", "KILO_SHOW_TTFD"]
      const env = { ...process.env }
      for (const name of names) delete env[name]
      Object.assign(env, item.env)
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify(Flag.KILO_SHOW_TTFD))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toBe(item.expected)
    })
  }

  test("reports time-to-first-draw alias conflicts without their values", () => {
    const names = ["RAYA_SHOW_TTFD", "KILO_SHOW_TTFD"]
    const env = { ...process.env }
    for (const name of names) delete env[name]
    Object.assign(env, { RAYA_SHOW_TTFD: "raya-secret", KILO_SHOW_TTFD: "legacy-secret" })
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; import { EnvAlias } from "./src/kilocode/env-alias.ts"; console.log(JSON.stringify({ enabled: Flag.KILO_SHOW_TTFD, conflicts: EnvAlias.conflicts() }))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    const output = child.stdout.toString()
    expect(JSON.parse(output)).toEqual({ enabled: false, conflicts: ["RAYA_SHOW_TTFD/KILO_SHOW_TTFD"] })
    expect(output).not.toContain("raya-secret")
    expect(output).not.toContain("legacy-secret")
  })

  for (const item of [
    { name: "neither name", env: {}, expected: false },
    { name: "Raya input", env: { RAYA_DISABLE_MOUSE: "true" }, expected: true },
    { name: "Kilo input", env: { KILO_DISABLE_MOUSE: "1" }, expected: true },
    {
      name: "both true",
      env: { RAYA_DISABLE_MOUSE: "true", KILO_DISABLE_MOUSE: "1" },
      expected: true,
    },
    {
      name: "false Raya and true Kilo",
      env: { RAYA_DISABLE_MOUSE: "false", KILO_DISABLE_MOUSE: "true" },
      expected: true,
    },
    {
      name: "true Raya and false Kilo",
      env: { RAYA_DISABLE_MOUSE: "1", KILO_DISABLE_MOUSE: "0" },
      expected: true,
    },
    {
      name: "empty Raya and true Kilo",
      env: { RAYA_DISABLE_MOUSE: "", KILO_DISABLE_MOUSE: "true" },
      expected: true,
    },
    {
      name: "invalid Raya and true Kilo",
      env: { RAYA_DISABLE_MOUSE: "invalid", KILO_DISABLE_MOUSE: "true" },
      expected: true,
    },
  ]) {
    test(`wires the mouse-disable flag from ${item.name}`, () => {
      const names = ["RAYA_DISABLE_MOUSE", "KILO_DISABLE_MOUSE"]
      const env = { ...process.env }
      for (const name of names) delete env[name]
      Object.assign(env, item.env)
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify(Flag.KILO_DISABLE_MOUSE))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toBe(item.expected)
    })
  }

  test("reports mouse-disable alias conflicts without their values", () => {
    const names = ["RAYA_DISABLE_MOUSE", "KILO_DISABLE_MOUSE"]
    const env = { ...process.env }
    for (const name of names) delete env[name]
    Object.assign(env, { RAYA_DISABLE_MOUSE: "raya-secret", KILO_DISABLE_MOUSE: "legacy-secret" })
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; import { EnvAlias } from "./src/kilocode/env-alias.ts"; console.log(JSON.stringify({ disabled: Flag.KILO_DISABLE_MOUSE, conflicts: EnvAlias.conflicts() }))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    const output = child.stdout.toString()
    expect(JSON.parse(output)).toEqual({ disabled: false, conflicts: ["RAYA_DISABLE_MOUSE/KILO_DISABLE_MOUSE"] })
    expect(output).not.toContain("raya-secret")
    expect(output).not.toContain("legacy-secret")
  })

  test("resolves credentials explicitly and fails closed on conflicting aliases", () => {
    const conflict = { RAYA_SERVER_PASSWORD: "raya-secret", KILO_SERVER_PASSWORD: "legacy-secret" }

    expect(EnvAlias.credential("explicit", "RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", conflict)).toBe("explicit")
    expect(EnvAlias.credential(undefined, "RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", {})).toBeUndefined()
    expect(
      EnvAlias.credential(undefined, "RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", {
        RAYA_SERVER_PASSWORD: "same",
        KILO_SERVER_PASSWORD: "same",
      }),
    ).toBe("same")
    expect(() => EnvAlias.credential(undefined, "RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", conflict)).toThrow(
      "RAYA_SERVER_PASSWORD and KILO_SERVER_PASSWORD",
    )

    try {
      EnvAlias.credential(undefined, "RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", conflict)
    } catch (cause) {
      expect(cause).toBeInstanceOf(EnvAlias.Conflict)
      expect(String(cause)).not.toContain("raya-secret")
      expect(String(cause)).not.toContain("legacy-secret")
    }
  })

  test("wires strict server credential aliases through mutable legacy Flag properties", () => {
    const names = ["RAYA_SERVER_PASSWORD", "KILO_SERVER_PASSWORD", "RAYA_SERVER_USERNAME", "KILO_SERVER_USERNAME"]
    const env = { ...process.env }
    for (const name of names) delete env[name]
    Object.assign(env, { RAYA_SERVER_PASSWORD: "raya-secret", KILO_SERVER_USERNAME: "legacy-user" })
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; const initial = [Flag.KILO_SERVER_PASSWORD, Flag.KILO_SERVER_USERNAME]; Flag.KILO_SERVER_PASSWORD = "written"; console.log(JSON.stringify([...initial, process.env.RAYA_SERVER_PASSWORD, process.env.KILO_SERVER_PASSWORD]))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual(["raya-secret", "legacy-user", "written", "written"])

    Object.assign(env, { RAYA_SERVER_PASSWORD: "raya-secret", KILO_SERVER_PASSWORD: "legacy-secret" })
    const conflict = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; try { console.log(Flag.KILO_SERVER_PASSWORD) } catch (cause) { console.log(String(cause)) }',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })
    const output = conflict.stdout.toString()
    expect(conflict.exitCode).toBe(0)
    expect(output).toContain("RAYA_SERVER_PASSWORD and KILO_SERVER_PASSWORD")
    expect(output).not.toContain("raya-secret")
    expect(output).not.toContain("legacy-secret")
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

  test("aliases the TUI configuration path through mutable Kilo access", () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; const initial = Flag.KILO_TUI_CONFIG; Flag.KILO_TUI_CONFIG = "written.json"; console.log(JSON.stringify([initial, process.env.RAYA_TUI_CONFIG, process.env.KILO_TUI_CONFIG]))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        RAYA_TUI_CONFIG: "raya.json",
        KILO_TUI_CONFIG: "legacy.json",
      },
    })

    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual(["raya.json", "written.json", "written.json"])
  })

  test("aliases the model catalog URL through mutable Kilo access", () => {
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; const initial = Flag.KILO_MODELS_URL; Flag.KILO_MODELS_URL = "https://written.test"; console.log(JSON.stringify([initial, process.env.RAYA_MODELS_URL, process.env.KILO_MODELS_URL]))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        RAYA_MODELS_URL: "https://raya.test",
        KILO_MODELS_URL: "https://legacy.test",
      },
    })

    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual([
      "https://raya.test",
      "https://written.test",
      "https://written.test",
    ])
  })

  for (const item of [
    { name: "legacy fallback", env: { KILO_DISABLE_PROJECT_CONFIG: "1" }, expected: true },
    { name: "Raya input", env: { RAYA_DISABLE_PROJECT_CONFIG: "true" }, expected: true },
    {
      name: "Raya precedence on conflict",
      env: { RAYA_DISABLE_PROJECT_CONFIG: "0", KILO_DISABLE_PROJECT_CONFIG: "1" },
      expected: false,
    },
  ]) {
    test(`resolves the project configuration opt-out from ${item.name}`, () => {
      const names = ["RAYA_DISABLE_PROJECT_CONFIG", "KILO_DISABLE_PROJECT_CONFIG"]
      const env = { ...process.env }
      for (const name of names) delete env[name]
      Object.assign(env, item.env)
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify(Flag.KILO_DISABLE_PROJECT_CONFIG))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toBe(item.expected)
    })
  }

  test("writes the project configuration opt-out through both names", () => {
    const names = ["RAYA_DISABLE_PROJECT_CONFIG", "KILO_DISABLE_PROJECT_CONFIG"]
    const env = { ...process.env }
    for (const name of names) delete env[name]
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'import { Flag } from "./src/flag/flag.ts"; Flag.KILO_DISABLE_PROJECT_CONFIG = true; const enabled = [process.env.RAYA_DISABLE_PROJECT_CONFIG, process.env.KILO_DISABLE_PROJECT_CONFIG, Flag.KILO_DISABLE_PROJECT_CONFIG]; Flag.KILO_DISABLE_PROJECT_CONFIG = false; console.log(JSON.stringify([...enabled, process.env.RAYA_DISABLE_PROJECT_CONFIG, process.env.KILO_DISABLE_PROJECT_CONFIG, Flag.KILO_DISABLE_PROJECT_CONFIG]))',
      ],
      cwd: `${import.meta.dir}/../..`,
      env,
    })

    expect(child.exitCode).toBe(0)
    expect(JSON.parse(child.stdout.toString())).toEqual(["1", "1", true, "0", "0", false])
  })

  for (const item of [
    { name: "legacy fallback", env: { KILO_SESSION_RETRY_LIMIT: "4" }, expected: 4 },
    { name: "Raya input", env: { RAYA_SESSION_RETRY_LIMIT: "5" }, expected: 5 },
    {
      name: "Raya precedence on conflict",
      env: { RAYA_SESSION_RETRY_LIMIT: "6", KILO_SESSION_RETRY_LIMIT: "7" },
      expected: 6,
    },
    {
      name: "explicit empty Raya input",
      env: { RAYA_SESSION_RETRY_LIMIT: "", KILO_SESSION_RETRY_LIMIT: "8" },
      expected: null,
    },
    {
      name: "invalid Raya input",
      env: { RAYA_SESSION_RETRY_LIMIT: "invalid", KILO_SESSION_RETRY_LIMIT: "9" },
      expected: null,
    },
  ]) {
    test(`resolves the session retry limit from ${item.name}`, () => {
      const names = ["RAYA_SESSION_RETRY_LIMIT", "KILO_SESSION_RETRY_LIMIT"]
      const env = { ...process.env }
      for (const name of names) delete env[name]
      Object.assign(env, item.env)
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; console.log(JSON.stringify(Flag.KILO_SESSION_RETRY_LIMIT ?? null))',
        ],
        cwd: `${import.meta.dir}/../..`,
        env,
      })

      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toBe(item.expected)
    })
  }

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
