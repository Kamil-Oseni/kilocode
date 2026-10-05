export * as Log from "./log"

import path from "path"
import { existsSync, writeFileSync } from "fs" // kilocode_change
import fs from "fs/promises"
import * as Global from "../global"
import { Schema } from "effect"
import { Glob } from "./glob"
import { createStream } from "rotating-file-stream" // kilocode_change
import { KILO_RUN_ID } from "./opencode-process" // kilocode_change
import { LogOwner } from "../kilocode/log-owner" // kilocode_change
import { logRoot } from "../kilocode/log-root" // kilocode_change

export const Level = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})
export type Level = Schema.Schema.Type<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10
const initializedRunID = "KILO_LOG_INITIALIZED_RUN_ID"

let level: Level = "INFO"

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

const loggers = new Map<string, Logger>()

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
}

let logpath = ""
export function file() {
  return logpath
}
const stderr = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}
let write = stderr
let stream: ReturnType<typeof createStream> | undefined // kilocode_change

// kilocode_change start - serialize admitted initialization and retain its cleanup failures
export function drain(): Promise<void> {
  return LogOwner.drain()
}

export function init(options: Options) {
  return LogOwner.run((permit) => {
    const root = logRoot(Global.Path.log)
    return root.run(() => initialize(options, permit, root))
  })
}

async function initialize(options: Options, permit: symbol, root: ReturnType<typeof logRoot>) {
  // kilocode_change end
  if (options.level) level = options.level
  await cleanup(root.path) // kilocode_change - admitted canonical cleanup before retiring the logger
  // kilocode_change start - initialize one rotating stream and truncate dev.log once per Kilo run
  if (stream) {
    const active = stream
    stream = undefined
    write = stderr
    await LogOwner.end(active)
  }
  if (options.print) {
    write = stderr
    return
  }
  logpath = path.join(
    root.path,
    options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
  )
  const run = process.env[KILO_RUN_ID]
  if (!options.dev || !run || process.env[initializedRunID] !== run) {
    await fs.truncate(logpath).catch((err) => {
      if (err.code !== "ENOENT") throw err
    })
    if (options.dev && run) process.env[initializedRunID] = run
  }
  const dir = path.dirname(logpath)
  root.opening()
  const active = createStream(path.basename(logpath), {
    size: "50M",
    maxFiles: 10,
    history: ".log-history",
    path: dir,
  })
  stream = active
  LogOwner.own(active, permit, root)
  active.on("rotation", () => {
    if (!existsSync(dir)) return

    try {
      // RATIONALE: If current log path was deleted while stream still holds the fd,
      // rotating-file-stream will try to rename a missing path and emit ENOENT.
      writeFileSync(logpath, "", { flag: "wx" })
    } catch (err) {
      if (typeof err === "object" && err && "code" in err && err.code === "EEXIST") return

      LogOwner.fail(err)
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write("log stream warning: " + msg + "\n")
    }
  })
  active.on("error", (err: Error) => {
    process.stderr.write("log stream error: " + err.message + "\n")
  })
  active.on("warning", (err: Error) => {
    process.stderr.write("log stream warning: " + err.message + "\n")
  })
  write = (msg: any) => {
    return LogOwner.write(active, msg, stderr)
  }
  // kilocode_change end
}

async function cleanup(dir: string) {
  const files = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: false,
      include: "file",
      // kilocode_change start - retain unexpected cleanup failures
    }).catch((err) => {
      if (err.code === "ENOENT") return []
      throw err
    })
  )
    // kilocode_change end
    .filter((file) => path.basename(file) === file)
    .sort()
  if (files.length <= keep) return

  const doomed = files.slice(0, -keep)
  // kilocode_change start - join every deletion and report uncertainty
  const results = await Promise.allSettled(doomed.map((file) => fs.unlink(path.join(dir, file))))
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (failures.length) throw new AggregateError(failures, "Log cleanup failed")
  // kilocode_change end
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

let last = Date.now()
export function create(tags?: Record<string, any>) {
  tags = tags || {}

  const service = tags["service"]
  if (service && typeof service === "string") {
    const cached = loggers.get(service)
    if (cached) {
      return cached
    }
  }

  function build(message: any, extra?: Record<string, any>) {
    const prefix = Object.entries({
      ...tags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        if (value instanceof Error) return prefix + formatError(value)
        if (typeof value === "object") return prefix + JSON.stringify(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
  }
  const result: Logger = {
    debug(message?: any, extra?: Record<string, any>) {
      if (shouldLog("DEBUG")) {
        write("DEBUG " + build(message, extra))
      }
    },
    info(message?: any, extra?: Record<string, any>) {
      if (shouldLog("INFO")) {
        write("INFO  " + build(message, extra))
      }
    },
    error(message?: any, extra?: Record<string, any>) {
      if (shouldLog("ERROR")) {
        write("ERROR " + build(message, extra))
      }
    },
    warn(message?: any, extra?: Record<string, any>) {
      if (shouldLog("WARN")) {
        write("WARN  " + build(message, extra))
      }
    },
    tag(key: string, value: string) {
      if (tags) tags[key] = value
      return result
    },
    clone() {
      return create({ ...tags })
    },
    time(message: string, extra?: Record<string, any>) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      function stop() {
        result.info(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  if (service && typeof service === "string") {
    loggers.set(service, result)
  }

  return result
}
