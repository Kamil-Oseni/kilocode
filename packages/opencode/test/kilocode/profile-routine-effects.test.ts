import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect, ManagedRuntime } from "effect"
import { Database as Core } from "@opencode-ai/core/database/database"
import { declarations } from "../../src/kilocode/migration/profile-routine-declarations"
import { captureRoutineEffects, routineEffects, names } from "../../src/kilocode/migration/profile-routine-effects"
import { semantic, validateSQL } from "../../src/kilocode/migration/profile-sql-correspondence"
import { payload, seal, unseal, tables } from "../../src/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "../../src/kilocode/migration/profile-restore"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { select } from "../../src/kilocode/migration/profile-selection"
import { withWorking } from "../../src/kilocode/migration/profile-image"
import {
  readHistorical,
  historicalValues,
  historicalDigest,
} from "../../src/kilocode/migration/profile-restored-evidence"
import {
  bindRestoredComponents,
  restoredComponentValues,
  restoredComponentGroups,
} from "../../src/kilocode/migration/profile-restored-components-correspondence"
import { collectDisposition } from "../../src/kilocode/migration/profile-disposition"
import { assertCoverage } from "../../src/kilocode/migration/source-image-coverage"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function database() {
  const db = new Database(":memory:", { strict: true })
  db.exec("PRAGMA foreign_keys=ON")
  for (const sql of declarations) db.exec(sql)
  return db
}
function seed(db: Database) {
  db.query("INSERT INTO raya_routine_effect_participant VALUES (?,?,?,?,?,?,?)").run(
    "1".repeat(32),
    "1".repeat(64),
    "raya.routine.effect.v1",
    "2".repeat(64),
    123,
    "18446744073709551615",
    "revoked",
  )
  db.query("INSERT INTO raya_routine_effect_scope VALUES (?,?,?,?,?,?,?)").run(
    "3".repeat(64),
    "run",
    "original-run",
    "1234",
    "4".repeat(32),
    "5".repeat(64),
    "revoking",
  )
  db.query("INSERT INTO raya_routine_effect_capsule VALUES (?,?,?,?,?,?,?,?,?)").run(
    "6".repeat(32),
    "1".repeat(32),
    "7".repeat(32),
    "original-run",
    "original-session",
    "original-step",
    "8".repeat(64),
    "9".repeat(64),
    "revoked",
  )
  db.query("INSERT INTO raya_routine_effect_membership VALUES (?,?,?)").run(
    "6".repeat(32),
    "3".repeat(64),
    "4".repeat(32),
  )
  db.query("INSERT INTO raya_routine_effect_revocation VALUES (?,?,?,?,?,?,?)").run(
    "a".repeat(32),
    "3".repeat(64),
    "4".repeat(32),
    "5".repeat(64),
    "b".repeat(64),
    "original cancellation",
    "uncertain",
  )
  for (const [index, state] of ["reserved", "started", "uncertain", "settled", "refused"].entries()) {
    db.query("INSERT INTO raya_routine_effect_attempt VALUES (?,?,?,?,?,?,?,?,?)").run(
      (index + 1).toString(16).padStart(32, "0"),
      "6".repeat(32),
      "7".repeat(32),
      "tool",
      `original-tool-${index}`,
      "c".repeat(64),
      "8".repeat(64),
      state,
      state === "settled" ? "d".repeat(64) : null,
    )
  }
}
function group(value: NonNullable<ReturnType<typeof captureRoutineEffects>>) {
  return semantic.parse({
    kind: "sqlite-semantic",
    source: "isolated.db",
    component: "sql",
    digest: hash([]),
    schema: "a".repeat(64),
    tables: value.tables.map((table) => ({
      table: table.table,
      columns: table.columns,
      rows: table.rows.length,
      disposition: "inactive-routine-effect",
      excluded: [],
    })),
    complete: true,
    recovery: "private-sqlite-checkpoint",
    rawBytesPreserved: false,
    routineEffects: hash(value),
  })
}

test("actual SQL original owner, generation, purpose and all debt states survive inert encrypted evidence", async () => {
  const db = database()
  try {
    seed(db)
    const value = captureRoutineEffects(db)!
    expect(value.activation).toBe("inert")
    expect(value.installation).toBe(false)
    expect(value.fences[0]).toMatchObject({
      owner: "8".repeat(64),
      generation: "7".repeat(32),
      run: "original-run",
      session: "original-session",
      step: "original-step",
    })
    expect(value.fences[0].attempts.map((row) => row.state)).toEqual([
      "reserved",
      "started",
      "uncertain",
      "settled",
      "refused",
    ])
    const input = payload.parse({
      format: "raya.profile-data",
      version: 1,
      id: crypto.randomUUID(),
      createdAt: 1,
      schema: "a".repeat(64),
      workspaces: [],
      sql: [],
      json: [],
      routineEffects: value,
      review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
    })
    expect(
      (await unseal(await seal(input, "owned archive test passphrase"), "owned archive test passphrase"))
        .routineEffects,
    ).toEqual(value)
    expect(() => validateSQL(group(value), { sql: [], routineEffects: value })).not.toThrow()
    expect(() => validateSQL(group(value), { sql: [] })).toThrow()
    const excluded = new Set<string>(names)
    expect(tables.some((table) => excluded.has(table))).toBe(false)
    const changed = structuredClone(value)
    changed.tables[0].rows[0][6] = "e".repeat(64)
    expect(routineEffects.safeParse(changed).success).toBe(false)
    expect(routineEffects.safeParse({ ...value, fences: [] }).success).toBe(false)
    expect(routineEffects.safeParse({ ...value, activation: "active" }).success).toBe(false)
    expect(semantic.safeParse({ ...group(value), routineEffects: undefined }).success).toBe(false)
    expect(
      semantic.safeParse({
        ...group(value),
        routineEffects: undefined,
        tables: group(value).tables.map((row) => ({ ...row, disposition: "empty" })),
      }).success,
    ).toBe(false)
    db.query("UPDATE raya_routine_effect_attempt SET digest=? WHERE id=?").run("e".repeat(64), "1".padStart(32, "0"))
    expect(hash(captureRoutineEffects(db))).not.toBe(hash(value))
  } finally {
    db.close()
  }
})

test("absent and empty legacy cohorts differ from partial, modified and foreign original rows", () => {
  const absent = new Database(":memory:")
  try {
    expect(captureRoutineEffects(absent)).toBeUndefined()
  } finally {
    absent.close()
  }
  const db = database()
  try {
    const value = captureRoutineEffects(db)!
    const legacy = {
      ...group(value),
      routineEffects: undefined,
      tables: group(value).tables.map((row) => ({ ...row, disposition: "empty" as const })),
    }
    expect(() => validateSQL(legacy, { sql: [] })).not.toThrow()
    seed(db)
    db.exec(
      "PRAGMA foreign_keys=OFF; UPDATE raya_routine_effect_membership SET scope='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'",
    )
    expect(() => captureRoutineEffects(db)).toThrow("membership missing")
  } finally {
    db.close()
  }
  const partial = database()
  try {
    partial.exec("DROP INDEX raya_routine_effect_attempt_debt")
    expect(() => captureRoutineEffects(partial)).toThrow("partial or unknown")
  } finally {
    partial.close()
  }
  const altered = database()
  try {
    altered.exec(
      "DROP INDEX raya_routine_effect_attempt_debt; CREATE INDEX raya_routine_effect_attempt_debt ON raya_routine_effect_attempt(owner)",
    )
    expect(() => captureRoutineEffects(altered)).toThrow("unknown schema")
  } finally {
    altered.close()
  }
})

test("bounded native preflight refuses 8193 scalar rows without truncating evidence", () => {
  const db = database()
  try {
    const insert = db.query("INSERT INTO raya_routine_effect_participant VALUES (?,?,?,?,?,?,?)")
    db.transaction(() => {
      for (let index = 0; index < 8193; index++)
        insert.run(
          index.toString(16).padStart(32, "0"),
          "1".repeat(64),
          "raya.routine.effect.v1",
          "2".repeat(64),
          123,
          "1234",
          "inactive",
        )
    })()
    const query = spyOn(db, "query")
    try {
      expect(() => captureRoutineEffects(db)).toThrow("capacity exceeded")
      expect(query.mock.calls.some((call) => String(call[0]).includes("json_array"))).toBe(false)
    } finally {
      query.mockRestore()
    }
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM raya_routine_effect_participant").get()!.count,
    ).toBe(8193)
  } finally {
    db.close()
  }
})

test("same-schema corrupt native text and blob cells refuse before JSON expansion", () => {
  for (const value of ["😀".repeat(65), new Uint8Array([0xff, 0xfe])]) {
    const db = database()
    try {
      seed(db)
      db.exec("PRAGMA ignore_check_constraints=ON")
      db.query("UPDATE raya_routine_effect_scope SET principal=?").run(value)
      const query = spyOn(db, "query")
      try {
        expect(() => captureRoutineEffects(db)).toThrow("raw cell exceeds")
        // Observation only: spyOn delegates each call to the real SQLite reader.
        expect(query.mock.calls.some((call) => String(call[0]).includes("json_array"))).toBe(false)
      } finally {
        query.mockRestore()
      }
    } finally {
      db.close()
    }
  }
})

test("actual shipped SQLite encrypted restore retains component with six empty destination tables", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-routine-quarantine-"))
  const file = path.join(root, "source.db")
  const runtime = ManagedRuntime.make(Core.layerFromPath(file))
  const schema = await runtime
    .runPromise(
      Effect.gen(function* () {
        const service = yield* Core.Service
        return yield* signature((query) => service.db.all<Column>(query))
      }),
    )
    .finally(() => runtime.dispose())
  const db = new Database(file, { strict: true })
  const value = (() => {
    try {
      seed(db)
      return captureRoutineEffects(db)!
    } finally {
      db.close()
    }
  })()
  const input = payload.parse({
    format: "raya.profile-data",
    version: 1,
    id: crypto.randomUUID(),
    createdAt: 1,
    schema,
    workspaces: [],
    sql: [],
    json: [],
    routineEffects: value,
    review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
  })
  const target = path.join(root, "destination")
  await restore(await seal(input, "owned restore test passphrase"), "owned restore test passphrase", target, {})
  expect(JSON.parse(await readFile(path.join(target, "data", "kilo", "restore-routine-effects.json"), "utf8"))).toEqual(
    value,
  )
  const restored = new Database(path.join(target, "data", "kilo", "raya.db"), { readonly: true, strict: true })
  try {
    for (const name of names)
      expect(restored.query<{ count: number }, []>(`SELECT count(*) AS count FROM "${name}"`).get()!.count).toBe(0)
  } finally {
    restored.close()
  }
})

test.skipIf(process.platform !== "win32" || !process.env.RAYA_TEST_TIMESTAMP_HELPER)(
  "held native re-export binds exact restored Routine quarantine sidecar and refuses changed bytes",
  async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-routine-held-")))
    const file = path.join(root, "source.db")
    const runtime = ManagedRuntime.make(Core.layerFromPath(file))
    const schema = await runtime
      .runPromise(
        Effect.gen(function* () {
          const service = yield* Core.Service
          return yield* signature((query) => service.db.all<Column>(query))
        }),
      )
      .finally(() => runtime.dispose())
    const db = new Database(file, { strict: true })
    const value = (() => {
      try {
        seed(db)
        return captureRoutineEffects(db)!
      } finally {
        db.close()
      }
    })()
    const original = payload.parse({
      format: "raya.profile-data",
      version: 1,
      id: crypto.randomUUID(),
      createdAt: 1,
      schema,
      workspaces: [],
      sql: [],
      json: [],
      routineEffects: value,
      review: { reconnectCredentials: true, uncertainWork: "held-no-replay" },
    })
    const target = path.join(root, "restore")
    await restore(await seal(original, "owned held archive passphrase"), "owned held archive passphrase", target, {})
    const data = path.join(target, "data", "kilo")
    const helper = path.join(root, "raya-process-host.exe")
    await copyFile(process.env.RAYA_TEST_TIMESTAMP_HELPER!, helper)
    const digest = createHash("sha256")
      .update(await readFile(helper))
      .digest("hex")
    const policy = { version: 1 as const, directories: [data], files: [] }
    const selected = await select({ database: path.join(data, "raya.db"), storage: path.join(data, "storage") }, policy)
    const source = {
      ...selected,
      globals: [
        {
          data,
          config: data,
          cache: data,
          state: data,
          stateParent: data,
          log: data,
          bin: data,
          repos: data,
          homeKilocode: data,
          homeConfigKilo: data,
        },
      ],
    }
    await withImage(
      { roots: source.roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "registry") },
      (image) =>
        withWorking(image, source, async (token) => {
          const archive = await readHistorical(token)
          const claim = await bindRestoredComponents(token, archive, { archives: historicalValues(token, archive) })
          const entries = restoredComponentValues(token, claim)!.filter((entry) => entry.selector === "routineEffects")
          expect(entries).toHaveLength(1)
          // Original JSON bytes and canonical historical semantic hashes are distinct contracts.
          expect(entries[0].text).toBe(JSON.stringify(value))
          expect(entries[0].componentDigest).toBe(historicalDigest(value))
          const rows = restoredComponentGroups(token, claim).filter((entry) => entry.selector === "routineEffects")
          expect(rows).toHaveLength(1)
          expect(rows[0].digest).toBe(hash(value))
          expect(rows[0].bytes).toBe(Buffer.byteLength(JSON.stringify(value)))
          const disposition = collectDisposition(
            token,
            [],
            "selected",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            claim,
          )
          expect(() => assertCoverage(token, [{ kind: "json", path: rows[0].source }], disposition.files)).not.toThrow()
          expect(historicalValues(token, archive)[0].routineEffects).toEqual(value)
        }),
    )
    const changed = structuredClone(value)
    changed.fences[0].owner = "f".repeat(64)
    await writeFile(path.join(data, "restore-routine-effects.json"), JSON.stringify(changed))
    await withImage(
      {
        roots: source.roots,
        policy,
        helper: { executable: helper, digest },
        registry: path.join(root, "registry-tamper"),
      },
      (image) =>
        withWorking(image, source, async (token) => {
          const archive = await readHistorical(token)
          const claim = await bindRestoredComponents(token, archive, { archives: historicalValues(token, archive) })
          expect(restoredComponentValues(token, claim).some((entry) => entry.selector === "routineEffects")).toBe(false)
          const disposition = collectDisposition(
            token,
            [],
            "selected",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            claim,
          )
          const sidecar = path.join(data, "restore-routine-effects.json")
          expect(disposition.files.find((entry) => entry.path === sidecar)?.disposition.kind).toBe("unclassified")
          expect(() => assertCoverage(token, [{ kind: "json", path: sidecar }], disposition.files)).toThrow(
            "typed payload binding",
          )
        }),
    )
  },
)
