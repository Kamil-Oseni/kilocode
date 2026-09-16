import { afterEach, describe, expect, test } from "bun:test"
import { KiloLog } from "@/kilocode/log"
import { EnvAlias } from "@opencode-ai/core/kilocode/env-alias"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

afterEach(() => EnvAlias.conflicts())

describe("KiloLog environment aliases", () => {
  test("reads Raya logging variables", () => {
    expect(
      KiloLog.options({
        RAYA_LOG_LEVEL: "warn",
        RAYA_PRINT_LOGS: "1",
      }),
    ).toMatchObject({
      level: "WARN",
      print: true,
    })
  })

  test("prefers Raya variables when both names are set", () => {
    expect(
      KiloLog.options({
        RAYA_LOG_LEVEL: "error",
        KILO_LOG_LEVEL: "debug",
        RAYA_PRINT_LOGS: "0",
        KILO_PRINT_LOGS: "1",
      }),
    ).toMatchObject({
      level: "ERROR",
      print: false,
    })
  })

  test("falls back to Kilo variables", () => {
    expect(
      KiloLog.options({
        KILO_LOG_LEVEL: "info",
        KILO_PRINT_LOGS: "1",
      }),
    ).toMatchObject({
      level: "INFO",
      print: true,
    })
  })

  test("synchronizes aliases and keeps explicit CLI values above inherited inputs", () => {
    const env = {
      RAYA_LOG_LEVEL: "ERROR",
      KILO_LOG_LEVEL: "DEBUG",
      RAYA_PRINT_LOGS: "0",
      KILO_PRINT_LOGS: "0",
    }

    KiloLog.configure({ logLevel: "INFO", printLogs: true }, env)

    expect(env).toEqual({
      RAYA_LOG_LEVEL: "INFO",
      KILO_LOG_LEVEL: "INFO",
      RAYA_PRINT_LOGS: "1",
      KILO_PRINT_LOGS: "1",
    })
    expect(KiloLog.options(env)).toMatchObject({ level: "INFO", print: true })
  })

  test("keeps explicit CLI flags above conflicting inherited aliases", async () => {
    await using tmp = await tmpdir()
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        path.join(process.cwd(), "src/index.ts"),
        "--print-logs",
        "--log-level",
        "INFO",
        "debug",
        "paths",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          RAYA_LOG_LEVEL: "ERROR",
          KILO_LOG_LEVEL: "DEBUG",
          RAYA_PRINT_LOGS: "0",
          KILO_PRINT_LOGS: "0",
          RAYA_NO_DAEMON: "1",
          KILO_NO_DAEMON: "1",
          RAYA_CONFIG_CONTENT: '{"experimental":{"openTelemetry":false}}',
          KILO_CONFIG_CONTENT: '{"experimental":{"openTelemetry":false}}',
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_DISABLE_AUTOUPDATE: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
          RAYA_AUTH_CONTENT: "{}",
          KILO_AUTH_CONTENT: "{}",
          KILO_PURE: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const code = await child.exited
    const stderr = await new Response(child.stderr).text()

    expect(code).toBe(0)
    expect(stderr).toContain("level=INFO")
    expect(stderr).toContain("command=--print-logs")
    expect(stderr).toContain("Raya environment variables override conflicting Kilo aliases")
    expect(stderr).toContain("RAYA_LOG_LEVEL/KILO_LOG_LEVEL")
    expect(stderr).toContain("RAYA_PRINT_LOGS/KILO_PRINT_LOGS")
  }, 30_000)
})
