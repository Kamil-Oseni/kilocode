import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import z from "zod"
import { failure } from "../../src/kilocode/migration/source-failure"
import { preparation, retirement } from "@opencode-ai/core/kilocode/source-offline-frame"
import { registry } from "@opencode-ai/core/kilocode/source-offline"
import { check, checked, staged } from "../../src/kilocode/migration/source-stage"

test("actual correspondence stage wrappers retain causes while publishing only fixed categories", async () => {
  const secret = "PRIVATE_CORRESPONDENCE_PATH_PASSWORD_AND_VALUE"
  const original = new Error(secret)
  const async = await checked("correspondence-storage", () => Promise.reject(original)).catch((error: unknown) => error)
  expect(async).toBeInstanceOf(Error)
  if (!(async instanceof Error)) throw new Error("Actual asynchronous wrapper did not refuse")
  expect(async.cause).toBe(original)
  const nested = staged(async, "capture-profile")
  expect(failure(nested).errors.map((entry) => entry.code)).toEqual([
    "RAYA_SOURCE_CAPTURE_PROFILE_REFUSED",
    "RAYA_SOURCE_CORRESPONDENCE_STORAGE_REFUSED",
    undefined,
  ])
  expect(JSON.stringify(failure(nested))).not.toContain(secret)
  const sync = (() => {
    try {
      check("correspondence-markdown", () => {
        throw original
      })
      return undefined
    } catch (error) {
      return error
    }
  })()
  expect(sync).toBeInstanceOf(Error)
  if (!(sync instanceof Error)) throw new Error("Actual synchronous wrapper did not refuse")
  expect(sync.cause).toBe(original)
  expect(failure(sync).errors[0].code).toBe("RAYA_SOURCE_CORRESPONDENCE_MARKDOWN_REFUSED")
  const result = { same: true }
  expect(check("correspondence-config", () => result)).toBe(result)
  expect(await checked("correspondence-host", () => Promise.resolve(result))).toBe(result)
})

test("actual profile root refinements expose only exact fixed reasons without source JSON or SQL values", async () => {
  const { snapshot } = await import("../../src/kilocode/migration/profile-bundle")
  const secret = "PRIVATE_PROFILE_JSON_AND_SQL_VALUE"
  const base = {
    format: "raya.profile-data",
    version: 1,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    schema: "a".repeat(64),
    workspaces: [],
    sql: [],
    json: [],
    review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
  }
  for (const [patch, expected] of [
    [
      {
        json: [
          { path: "raya/goal/example.json", value: JSON.stringify({ secret }) },
          { path: "raya/goal/example.json", value: JSON.stringify({ secret }) },
        ],
      },
      "RAYA_PROFILE_JSON_PATH_DUPLICATED",
    ],
    [{ sql: [{ table: "session", columns: ["id"], rows: [[secret, secret]] }] }, "RAYA_PROFILE_SQL_ROW_SHAPE_DIFFERS"],
    [
      { sql: [{ table: "project_directory", columns: ["directory"], rows: [[42]] }] },
      "RAYA_PROFILE_DIRECTORY_SHAPE_REFUSED",
    ],
  ] as const) {
    const checked = snapshot.safeParse({ ...base, ...patch })
    if (checked.success) throw new Error("Invalid profile refinement was accepted")
    const result = failure(staged(checked.error, "capture-profile"))
    expect(result.errors[1].issues?.some((issue) => issue.reason === expected && issue.path.length === 0)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(base.id)
  }
})

test("custom reason diagnostics neither invoke message getters nor classify private near matches", () => {
  const secret = "PRIVATE_CUSTOM_ISSUE_PASSWORD"
  const message = "Duplicate JSON path"
  for (const text of [message + secret, secret.repeat(100)]) {
    const error = new z.ZodError([{ code: "custom", path: [], message: text }])
    expect(failure(error).errors[0].issues).toEqual([{ code: "custom", path: [] }])
    expect(JSON.stringify(failure(error))).not.toContain(secret)
  }
  const error = new z.ZodError([{ code: "custom", path: [], message }])
  let reads = 0
  Object.defineProperty(error.issues[0], "message", {
    get() {
      reads++
      return message
    },
  })
  expect(failure(error).errors[0].issues).toEqual([{ code: "custom", path: [] }])
  expect(reads).toBe(0)
})

test("actual readonly registry refusal keeps its original nested error and publishes only a fixed category", () => {
  const original = (() => {
    try {
      registry({})
      throw new Error("Missing registry was accepted")
    } catch (err) {
      return err
    }
  })()
  const wrapped = staged(staged(original, "capture-planning"), "export-callback")
  expect(wrapped.cause).toBeInstanceOf(Error)
  if (!(wrapped.cause instanceof Error)) throw new Error("Actual planning wrapper did not retain its cause")
  expect(wrapped.cause.cause).toBe(original)
  expect(failure(wrapped).errors.map((value) => value.code)).toEqual([
    "RAYA_SOURCE_EXPORT_CALLBACK_REFUSED",
    "RAYA_SOURCE_CAPTURE_PLANNING_REFUSED",
    "RAYA_SOURCE_REGISTRY_LOCALAPPDATA_MISSING",
  ])
  expect(JSON.stringify(failure(wrapped))).not.toContain("Offline stable registry requires Windows LOCALAPPDATA")
})

test("planning diagnostics refuse near matches, oversized messages and accessors without publishing private text", () => {
  const secret = "PRIVATE_PLANNING_PATH_PASSWORD"
  for (const message of ["Offline helper pin changed", "Selected profile path lacks a held image mapping"]) {
    const value = failure(new Error(message))
    expect(value.errors[0].code).toBeDefined()
    expect(JSON.stringify(value)).not.toContain(message)
    expect(failure(new Error(`${message}: ${secret}`)).errors[0].code).toBeUndefined()
  }
  expect(failure(new Error(secret.repeat(100))).errors[0].code).toBeUndefined()
  let reads = 0
  const error = new Error()
  Object.defineProperty(error, "message", {
    get() {
      reads++
      return secret
    },
  })
  expect(failure(error).errors[0].code).toBeUndefined()
  expect(reads).toBe(0)
  expect(JSON.stringify(failure(error))).not.toContain(secret)
})

test("release rollback diagnostics retain native classifications through source failure intake", () => {
  const generation = crypto.randomUUID()
  const secret = "PRIVATE_RELEASE_SOURCE_PATH_AND_PASSWORD"
  try {
    retirement(
      {
        version: 4,
        generation,
        state: "retired",
        restored: false,
        failures: ["Offline rollback remains uncertain; journal retained", secret],
        portableCaptureAuthorized: false,
      },
      generation,
      4,
    )
    throw new Error("Failed native rollback was accepted")
  } catch (err) {
    const value = failure(err)
    expect(value.errors.map((item) => item.code).filter(Boolean)).toEqual([
      "RAYA_OFFLINE_ROLLBACK_REMAINS_UNCERTAIN_JOURNAL_RETAINED",
      "RAYA_OFFLINE_UNKNOWN_REFUSAL",
      "RAYA_OFFLINE_ROLLBACK_UNCONFIRMED",
    ])
    expect(JSON.stringify(value)).not.toContain(secret)
    expect(JSON.stringify(value)).not.toContain(generation)
  }
})

test("SQLite verification diagnostics retain fixed pragma fields without rejected values", () => {
  const confidential = "PRIVATE_SQLITE_VALUE_AND_PATH"
  for (const [field, expected] of [
    ["quick_check", "ok"],
    ["busy", 0],
  ] as const) {
    const result = z.object({ [field]: z.literal(expected) }).safeParse({ [field]: confidential })
    if (result.success) throw new Error("Invalid pragma result was accepted")
    const value = failure(result.error)
    expect(value.errors[0].issues).toEqual([{ code: "invalid_value", path: [field] }])
    expect(JSON.stringify(value)).not.toContain(confidential)
  }
})

test("native early-retirement diagnostics expose fixed codes without native packet values", () => {
  const generation = crypto.randomUUID()
  const confidential = "PRIVATE_NATIVE_PASSWORD_AND_FILENAME"
  try {
    preparation(
      {
        version: 1,
        generation,
        state: "retired",
        restored: false,
        failures: ["Offline exclusive source handle refused", confidential],
        portableCaptureAuthorized: false,
      },
      generation,
    )
    throw new Error("Early native terminal frame was accepted")
  } catch (err) {
    const value = failure(err)
    expect(value.errors.map((item) => item.code).filter(Boolean)).toEqual([
      "RAYA_OFFLINE_EXCLUSIVE_SOURCE_HANDLE_REFUSED",
      "RAYA_OFFLINE_UNKNOWN_REFUSAL",
      "RAYA_OFFLINE_ROLLBACK_UNCONFIRMED",
    ])
    expect(JSON.stringify(value)).not.toContain(confidential)
    expect(JSON.stringify(value)).not.toContain(generation)
    expect(JSON.stringify(value)).not.toContain("Offline exclusive source handle refused")
  }
})

test("actual native and schema failures publish fixed classifications without source values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-source-failure-"))
  const confidential = "PRIVATE_CHANNEL_PASSWORD_MODEL_USER_KEY"
  const native = await readFile(path.join(root, confidential)).catch((err: unknown) => err)
  const schema = z
    .object({ memory: z.array(z.object({ state: z.number() })) })
    .safeParse({ memory: [{ state: confidential }] })
  if (schema.success) throw new Error("Actual invalid schema fixture must reject")
  const db = new Database(":memory:")
  const sql = (() => {
    try {
      db.query(`SELECT * FROM "${confidential}"`).all()
      throw new Error("Actual missing table must reject")
    } catch (err) {
      return err
    } finally {
      db.close()
    }
  })()
  const value = failure(new AggregateError([native, schema.error, sql], confidential))
  expect(value.errors.map((item) => item.type)).toEqual(["AggregateError", "Error", "ZodError", "Error"])
  expect(value.errors[1].code).toBe("ENOENT")
  expect(value.errors[3].code).toBe("SQLITE_ERROR")
  expect(value.errors[2].issues).toEqual([{ code: "invalid_type", path: ["memory", 0] }])
  expect(JSON.stringify(value)).not.toContain(confidential)
  expect(JSON.stringify(value)).not.toContain(root)
  expect(value.truncated).toBe(false)
})

test("failure diagnostics bound cyclic causes, issue indexes and arbitrary getters", () => {
  const confidential = "PRIVATE_VALUE"
  const error = new Error(confidential)
  Object.defineProperty(error, "cause", { value: error })
  let reads = 0
  Object.defineProperty(error, "code", {
    get: () => {
      reads++
      return confidential
    },
  })
  const value = failure(
    new AggregateError(
      Array.from({ length: 100 }, () => error),
      confidential,
    ),
  )
  expect(reads).toBe(0)
  expect(value.truncated).toBe(true)
  expect(value.errors.length).toBeLessThanOrEqual(32)
  expect(JSON.stringify(value)).not.toContain(confidential)
  const schema = new z.ZodError([{ code: "custom", path: [confidential, 0, confidential, 3], message: confidential }])
  expect(failure(schema).errors[0].issues).toEqual([{ code: "custom", path: [0, 3] }])
  const deep = Array.from({ length: 20 }).reduce((cause) => new Error(confidential, { cause }), error)
  expect(failure(deep).errors.length).toBe(7)
  expect(failure(deep).truncated).toBe(true)
})

test("fixed cleanup stage metadata never invokes arbitrary getters or publishes private fields", () => {
  const secret = "PRIVATE_STAGE_PASSWORD_AND_PATH"
  let reads = 0
  const err = Object.assign(new Error(secret), { code: "RAYA_SERVE_TASK_FAILED" })
  Object.defineProperty(err, "stage", {
    get() {
      reads++
      throw new Error(secret)
    },
  })
  expect(failure(err).errors).toEqual([{ type: "Error", depth: 0, code: "RAYA_SERVE_TASK_FAILED" }])
  expect(reads).toBe(0)
  expect(
    failure(Object.assign(new Error(secret), { code: "RAYA_SERVE_TASK_TIMEOUT", stage: 1000 })).errors[0].stage,
  ).toBeUndefined()
  expect(failure(Object.assign(new Error(secret), { code: secret, stage: 1 })).errors[0].stage).toBeUndefined()
  expect(JSON.stringify(failure(err))).not.toContain(secret)
})
