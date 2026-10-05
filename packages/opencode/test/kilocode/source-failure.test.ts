import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import z from "zod"
import { failure } from "../../src/kilocode/migration/source-failure"
import { preparation } from "@opencode-ai/core/kilocode/source-offline-frame"

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
