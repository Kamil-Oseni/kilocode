import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createShutdown } from "../../src/kilocode/cli/shutdown"

let registry = createShutdown()
let cli: typeof import("../../src/kilocode/cli/setup").KiloCli
const KiloShutdown = {
  register: (task: () => void | Promise<void>) => registry.register(task),
  run: () => registry.run(),
}
void mock.module("@/kilocode/cli/shutdown", () => ({ KiloShutdown, createShutdown }))

const calls: string[] = []
const timeouts: Array<number | undefined> = []
let err: unknown
let drainErr: unknown
let drainCalls = 0
let exit: string | number | null | undefined

mock.module("@opencode-ai/core/global", () => ({
  Global: { Path: { data: "/tmp/kilo-test" } },
}))

mock.module("@opencode-ai/core/installation/version", () => ({
  InstallationBuildKind: "release",
  InstallationVersion: "test",
}))

mock.module("@kilocode/kilo-telemetry", () => ({
  Telemetry: {
    async init() {
      calls.push("telemetry:init")
    },
    async updateIdentity() {},
    trackCliStart() {},
    flushInBackground() {},
    trackCliExit(code?: number) {
      calls.push(`track:${code ?? "undefined"}`)
    },
    async shutdown(timeout?: number) {
      calls.push("telemetry")
      timeouts.push(timeout)
      if (err) throw err
    },
  },
}))

mock.module("@kilocode/kilo-gateway", () => ({
  ENV_FEATURE: "KILO_FEATURE",
  ENV_VERSION: "KILO_VERSION",
  async migrateLegacyKiloAuth() {
    calls.push("auth:migrate")
  },
}))

mock.module("@/effect/app-runtime", () => ({
  AppRuntime: {
    async runPromise() {
      calls.push("runtime")
      return { experimental: {} }
    },
    async dispose() {},
  },
}))

mock.module("@/kilocode/log", () => ({
  KiloLog: {
    async init() {
      calls.push("log")
    },
  },
}))

mock.module("@/kilocode/storage/json-migration", () => ({
  JsonMigration: {
    async bootstrap() {
      calls.push("migration")
    },
  },
}))

mock.module("@/config/config", () => ({
  Config: { Service: { use: () => ({ experimental: {} }) } },
}))

mock.module("@/auth", () => ({
  Auth: { Service: { use: () => undefined } },
}))

mock.module("@/project/instance-runtime", () => ({
  InstanceRuntime: {
    async disposeAllInstances() {
      calls.push("dispose")
    },
  },
}))

mock.module("@/kilocode/session-export", () => ({
  SessionExport: {
    async shutdown() {
      calls.push("session")
    },
  },
}))

mock.module("@/kilo-sessions/kilo-sessions", () => ({
  KiloSessions: {
    async drainIngestForShutdown() {
      drainCalls += 1
      calls.push("drain")
      if (drainErr) throw drainErr
    },
  },
}))

mock.module("@/kilocode/help-command", () => ({
  createHelpCommand: () => ({ command: "help", handler() {} }),
}))

for (const path of [
  "@/kilocode/cli/cmd/console",
  "@/kilocode/cli/cmd/cloud",
  "@/kilocode/cli/cmd/roll-call",
  "@/kilocode/cli/cmd/profile",
  "@/kilocode/cli/cmd/daemon",
  "@/kilocode/cli/dev-setup",
  "@/cli/cmd/remote",
  "@/cli/cmd/config",
]) {
  mock.module(path, () => ({
    KiloConsoleCommand: { command: "console", handler() {} },
    CloudCommand: { command: "cloud", handler() {} },
    RollCallCommand: { command: "roll-call", handler() {} },
    ProfileCommand: { command: "profile", handler() {} },
    DaemonCommand: { command: "daemon", handler() {} },
    DevSetupCommand: { command: "dev-setup", handler() {} },
    DevAliasCommand: { command: "dev-alias", handler() {} },
    RemoteCommand: { command: "remote", handler() {} },
    ConfigCommand: { command: "config", handler() {} },
  }))
}

describe("KiloCli.shutdown", () => {
  beforeEach(async () => {
    registry = createShutdown()
    calls.length = 0
    timeouts.length = 0
    err = undefined
    drainErr = undefined
    drainCalls = 0
    exit = process.exitCode
    process.exitCode = undefined
    // Each case represents a distinct process with a fresh terminal lifecycle.
    const module = await import(`../../src/kilocode/cli/setup.ts?case=${crypto.randomUUID()}`)
    cli = module.KiloCli
    await cli.bootstrap({})
    calls.length = 0
  })

  afterEach(() => {
    process.exitCode = exit
  })

  test("rejects drain without blocking dispose", async () => {
    drainErr = new Error("ingest drain failed")
    process.exitCode = 0
    const KiloCli = cli

    await expect(KiloCli.shutdown()).resolves.toBeUndefined()

    expect(drainCalls).toBe(1)
    expect(timeouts).toEqual([2000])
    expect(calls).toEqual(["track:0", "session", "telemetry", "drain", "dispose"])
    expect(process.exitCode).toBe(0)
    const closed = KiloCli.shutdown()
    expect(KiloCli.shutdown()).toBe(closed)
    await expect(KiloCli.bootstrap({})).rejects.toThrow("CLI lifecycle is closing or closed")
  })

  test("keeps telemetry shutdown timeout best-effort and still disposes instances", async () => {
    err = "Timeout while shutting down PostHog. Some events may not have been sent."
    process.exitCode = 0
    const KiloCli = cli

    await expect(KiloCli.shutdown()).resolves.toBeUndefined()

    expect(timeouts).toEqual([2000])
    expect(calls).toEqual(["track:0", "session", "telemetry", "drain", "dispose"])
    expect(process.exitCode).toBe(0)
  })

  test("preserves failing command exit status", async () => {
    process.exitCode = 1
    const KiloCli = cli

    const failed = new Error("registered cleanup failed")
    registry.register(() => {
      throw failed
    })
    await expect(KiloCli.shutdown()).rejects.toThrow("registered cleanup failed")

    expect(timeouts).toEqual([2000])
    expect(calls).toEqual(["track:1", "session", "telemetry", "drain", "dispose"])
    expect(process.exitCode).toBe(1)
  })

  test("skips lifecycle work for parsed informational flags", async () => {
    const KiloCli = cli

    for (const flag of ["help", "version"] as const) {
      await KiloCli.bootstrap({ [flag]: true })
      await KiloCli.shutdown()
    }

    expect(calls).toEqual([])
    expect(timeouts).toEqual([])
  })
})
