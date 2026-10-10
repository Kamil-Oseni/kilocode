import { expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { statements } from "@opencode-ai/core/kilocode/routine-revocation"
import migration from "@opencode-ai/core/database/migration/20261010235900_kilocode-routine-revocation-v1"

async function fixture(body: (db: SQLite, peer: SQLite, file: string) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-revocation-"))
  const file = path.join(root, "authority.sqlite")
  await opened(file, body)
  // A failed assertion retains the owned database, including its original rows.
  await rm(root, { recursive: true })
}

async function opened(file: string, body: (db: SQLite, peer: SQLite, file: string) => void) {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Database.Service
      yield* Effect.sync(() => {
        const db = new SQLite(file)
        const peer = new SQLite(file)
        try {
          db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000")
          peer.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000")
          body(db, peer, file)
        } finally {
          peer.close()
          db.close()
        }
      })
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped),
  )
}

function seed(db: SQLite, kind: string, principal: string, digit: string, state = "active") {
  const scope = digit.repeat(64)
  const capsule = digit.repeat(32)
  const generation = "a".repeat(32)
  // These synthetic states exercise negative trigger semantics only. They do not
  // qualify a native participant, enrollment, transport, or permission to POST.
  db.query(
    "INSERT OR IGNORE INTO raya_routine_effect_participant (id, profile, protocol, cohort, pid, birth, state) VALUES (?, ?, 'raya.routine.effect.v1', ?, 123, '456', 'qualified')",
  ).run("f".repeat(32), "f".repeat(64), "e".repeat(64))
  db.query(
    "INSERT INTO raya_routine_effect_scope (id, kind, principal, birth, generation, projection, state) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(scope, kind, principal, digit, generation, "b".repeat(64), state)
  db.query(
    "INSERT INTO raya_routine_effect_capsule (id, participant, generation, run, session, step, owner, projection, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    capsule,
    "f".repeat(32),
    generation,
    `run-${digit}`,
    `session-${digit}`,
    `step-${digit}`,
    "c".repeat(64),
    "d".repeat(64),
    state,
  )
  db.query("INSERT INTO raya_routine_effect_membership (capsule, scope, generation) VALUES (?, ?, ?)").run(
    capsule,
    scope,
    generation,
  )
  db.query(
    "INSERT INTO raya_routine_effect_attempt (id, capsule, generation, kind, purpose, digest, owner, state) VALUES (?, ?, ?, 'model', 'model:original', ?, ?, 'started')",
  ).run(digit.repeat(31) + "0", capsule, generation, "e".repeat(64), "c".repeat(64))
  return { scope, capsule, generation, attempt: digit.repeat(31) + "0" }
}

function parents(db: SQLite) {
  db.exec(
    "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project', '/repo', 1, 1, '[]')",
  )
  for (const id of ["one", "two"])
    db.query(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'project', ?, '/repo', ?, '7.4.23', 1, 1)",
    ).run(id, id, id)
  for (const id of ["org-one", "org-two"])
    db.query(
      "INSERT INTO raya_routine_organization (id, name, revision, time_created, time_updated) VALUES (?, ?, 1, 1, 1)",
    ).run(id, id)
  db.exec(
    "INSERT INTO raya_routine_organization_member (organization_id, agent_id, role, position, time_created, time_updated) VALUES ('org-one', 'agent', 'worker', 0, 1, 1)",
  )
  db.exec(
    "INSERT INTO raya_routine_delegation (id, source, sender_id, recipient_id, objective, depth, state, time_created, time_updated) VALUES ('delegation', 'original', 'sender', 'recipient', 'Original task', 0, 'running', 1, 1)",
  )
}

function states(db: SQLite) {
  return {
    scopes: db.query("SELECT id, generation, state FROM raya_routine_effect_scope ORDER BY id").all(),
    capsules: db.query("SELECT id, generation, state FROM raya_routine_effect_capsule ORDER BY id").all(),
    attempts: db.query("SELECT * FROM raya_routine_effect_attempt ORDER BY id").all(),
  }
}

function state(db: SQLite, table: "scope" | "capsule", id: string) {
  return db.query<{ state: string }, [string]>(`SELECT state FROM raya_routine_effect_${table} WHERE id = ?`).get(id)
    ?.state
}

test("production migrations install the exact immutable revocation trigger policy", async () => {
  await fixture((db) => {
    const names = statements
      .map((value) => {
        const name = value.match(/^CREATE TRIGGER (\w+)/)?.[1]
        if (!name) throw new Error("Shipped trigger identity is missing")
        return name
      })
      .sort()
    expect(names.every((name) => typeof name === "string")).toBe(true)
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBeGreaterThan(0)
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'raya_routine_authority_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual(names)
    const triggers = db
      .query<{ tbl_name: string; sql: string }, []>("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
    expect(triggers.length).toBeLessThanOrEqual(256)
    expect(triggers.reduce((size, row) => size + Buffer.byteLength(row.sql, "utf8"), 0)).toBeLessThanOrEqual(
      1024 * 1024,
    )
    const tables = db
      .query<
        { tbl_name: string },
        []
      >("SELECT DISTINCT tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'raya_routine_authority_%'")
      .all()
    expect(tables).toHaveLength(21)
    for (const row of tables) {
      const table = '"' + row.tbl_name.replaceAll('"', '""') + '"'
      const column = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).get()?.name
      expect(column).toBeDefined()
      if (!column) throw new Error("Migrated trigger table lacks columns")
      const field = '"' + column.replaceAll('"', '""') + '"'
      for (const query of [
        `INSERT INTO ${table} DEFAULT VALUES`,
        `UPDATE ${table} SET ${field} = ${field}`,
        `DELETE FROM ${table} WHERE 0`,
      ])
        expect(db.query(`EXPLAIN ${query}`).all().length).toBeGreaterThan(0)
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
  })
})

for (const mutation of [
  {
    kind: "organization",
    principal: "org-one",
    sql: "UPDATE raya_routine_organization SET stopping_at = 2 WHERE id = 'org-one'",
  },
  { kind: "organization", principal: "org-one", sql: "DELETE FROM raya_routine_organization WHERE id = 'org-one'" },
  {
    kind: "organization",
    principal: "org-one",
    sql: "DELETE FROM raya_routine_organization_member WHERE organization_id = 'org-one'",
  },
  {
    kind: "delegation",
    principal: "delegation",
    sql: "UPDATE raya_routine_delegation SET state = 'cancelled' WHERE id = 'delegation'",
  },
  {
    kind: "session",
    principal: "one",
    sql: 'UPDATE session SET permission = \'[{"permission":"read","action":"deny"}]\' WHERE id = \'one\'',
  },
  { kind: "session", principal: "one", sql: "DELETE FROM session WHERE id = 'one'" },
  {
    kind: "session",
    principal: "one",
    sql: "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('input', 'one', 2, 2, '{\"role\":\"user\"}')",
  },
])
  test(`direct legacy SQL ${mutation.sql.split(" ").slice(0, 3).join(" ")} revokes only its ${mutation.kind} identity and retains original attempts`, async () => {
    await fixture((db, peer) => {
      parents(db)
      const own = seed(db, mutation.kind, mutation.principal, "1")
      const other = seed(
        db,
        mutation.kind,
        mutation.kind === "session" ? "two" : mutation.kind === "delegation" ? "other-delegation" : "org-two",
        "2",
      )
      const before = states(db)
      peer.exec(mutation.sql)
      expect(state(db, "scope", own.scope)).toBe("revoking")
      expect(state(db, "capsule", own.capsule)).toBe("revoked")
      expect(state(db, "scope", other.scope)).toBe("active")
      expect(state(db, "capsule", other.capsule)).toBe("active")
      expect(states(db).attempts).toEqual(before.attempts)
      expect(db.query("SELECT * FROM raya_routine_effect_membership ORDER BY capsule").all()).toHaveLength(2)
      expect(db.query("SELECT * FROM raya_routine_effect_revocation").all()).toEqual([])
      expect(db.query("SELECT state FROM raya_routine_effect_participant").all()).toEqual([{ state: "qualified" }])
      db.query("UPDATE raya_routine_effect_attempt SET state = 'settled', receipt = ? WHERE id = ?").run(
        "9".repeat(64),
        own.attempt,
      )
      expect(
        db
          .query("SELECT state, receipt, generation, capsule FROM raya_routine_effect_attempt WHERE id = ?")
          .get(own.attempt),
      ).toEqual({
        state: "settled",
        receipt: "9".repeat(64),
        generation: own.generation,
        capsule: own.capsule,
      })
      expect(state(peer, "scope", own.scope)).toBe("revoking")
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
    })
  })

test("two SQLite connections observe authority and revocation atomically; rollback restores both", async () => {
  await fixture((db, peer) => {
    parents(db)
    const own = seed(db, "organization", "org-one", "1")
    const before = states(db)
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec("UPDATE raya_routine_organization SET revision = 2 WHERE id = 'org-one'")
      expect(state(db, "scope", own.scope)).toBe("revoking")
      expect(state(db, "capsule", own.capsule)).toBe("revoked")
      expect(states(peer)).toEqual(before)
      expect(peer.query("SELECT revision FROM raya_routine_organization WHERE id = 'org-one'").get()).toEqual({
        revision: 1,
      })
    } finally {
      db.exec("ROLLBACK")
    }
    expect(states(db)).toEqual(before)
    expect(states(peer)).toEqual(before)
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec("UPDATE raya_routine_organization SET revision = 2 WHERE id = 'org-one'")
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
    expect(peer.query("SELECT revision FROM raya_routine_organization WHERE id = 'org-one'").get()).toEqual({
      revision: 2,
    })
    expect(state(peer, "scope", own.scope)).toBe("revoking")
    expect(state(peer, "capsule", own.capsule)).toBe("revoked")
    expect(states(peer).attempts).toEqual(before.attempts)
  })
})

test("assistant text, timestamps, and occurrence lease heartbeats do not revoke authority", async () => {
  await fixture((db, peer) => {
    parents(db)
    db.exec(
      "INSERT INTO raya_routine_occurrence (id, agent_id, schedule_version, scheduled_at, observed_at, state, time_updated) VALUES ('occurrence', 'agent', 1, 1, 1, 'starting', 1)",
    )
    const own = seed(db, "session", "one", "1")
    seed(db, "principal", "agent", "2")
    seed(db, "organization", "org-one", "3")
    const before = states(db)
    peer.exec("UPDATE session SET title = 'Renamed', time_updated = 2 WHERE id = 'one'")
    peer.exec("UPDATE raya_routine_organization SET time_updated = 2 WHERE id = 'org-one'")
    peer.exec(
      "UPDATE raya_routine_occurrence SET lease_until = 99, observed_at = 2, time_updated = 2 WHERE id = 'occurrence'",
    )
    peer.exec(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (\'assistant\', \'one\', 2, 2, \'{"role":"assistant","text":"streaming"}\')',
    )
    peer.exec(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('text', 'assistant', 'one', 2, 2, '{\"type\":\"text\",\"text\":\"partial\"}')",
    )
    peer.exec('UPDATE part SET data = \'{"type":"text","text":"finished"}\', time_updated = 3 WHERE id = \'text\'')
    expect(states(db)).toEqual(before)
    peer.exec("UPDATE message SET data = '{\"role\":\"user\"}' WHERE id = 'assistant'")
    expect(state(db, "scope", own.scope)).toBe("revoking")
    expect(state(db, "capsule", own.capsule)).toBe("revoked")
    expect(state(db, "scope", "2".repeat(64))).toBe("active")
    expect(state(db, "scope", "3".repeat(64))).toBe("active")
  })
})

test("membership generation mismatch is not current authority; inactive scopes never activate on mutation or cold open", async () => {
  await fixture((db, peer, file) => {
    parents(db)
    const own = seed(db, "organization", "org-one", "1")
    const idle = seed(db, "organization", "org-one", "2", "inactive")
    db.query("UPDATE raya_routine_effect_membership SET generation = ? WHERE capsule = ?").run(
      "8".repeat(32),
      own.capsule,
    )
    peer.exec("UPDATE raya_routine_organization SET budget = 10 WHERE id = 'org-one'")
    expect(state(db, "scope", own.scope)).toBe("revoking")
    // A stale membership does not match the current generation. Its untouched
    // capsule state grants nothing: the scope is revoked and enrollment is absent.
    expect(state(db, "capsule", own.capsule)).toBe("active")
    expect(state(db, "scope", idle.scope)).toBe("inactive")
    expect(state(db, "capsule", idle.capsule)).toBe("inactive")
    const cold = new SQLite(file)
    try {
      expect(states(cold)).toEqual(states(db))
      expect(state(cold, "scope", idle.scope)).toBe("inactive")
      expect(state(cold, "capsule", idle.capsule)).toBe("inactive")
    } finally {
      cold.close()
    }
  })
})

test("legacy malformed input refuses its owner; assistant ownership transfer revokes both OLD and NEW session identities", async () => {
  await fixture((db, peer) => {
    parents(db)
    const own = seed(db, "session", "one", "1")
    const next = seed(db, "session", "two", "2")
    const other = seed(db, "organization", "org-two", "3")
    const before = states(db)
    peer.exec(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'one', 2, 2, '{\"role\":\"assistant\"}')",
    )
    expect(states(db)).toEqual(before)
    peer.exec("UPDATE message SET session_id = 'two' WHERE id = 'assistant'")
    expect(state(db, "scope", own.scope)).toBe("revoking")
    expect(state(db, "scope", next.scope)).toBe("revoking")
    expect(state(db, "capsule", own.capsule)).toBe("revoked")
    expect(state(db, "capsule", next.capsule)).toBe("revoked")
    expect(state(db, "scope", other.scope)).toBe("active")
    expect(states(db).attempts).toEqual(before.attempts)
  })
  await fixture((db, peer) => {
    parents(db)
    const own = seed(db, "session", "one", "1")
    const other = seed(db, "session", "two", "2")
    peer.exec(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('malformed', 'one', 2, 2, 'not-json')",
    )
    expect(state(db, "scope", own.scope)).toBe("revoking")
    expect(state(db, "capsule", own.capsule)).toBe("revoked")
    expect(state(db, "scope", other.scope)).toBe("active")
    expect(db.query("SELECT data FROM message WHERE id = 'malformed'").get()).toEqual({ data: "not-json" })
  })
})

test("direct capsule session binding revokes without a membership and does not invent scope authority", async () => {
  await fixture((db, peer) => {
    parents(db)
    const own = seed(db, "organization", "org-two", "1")
    const other = seed(db, "organization", "org-one", "2")
    db.query("DELETE FROM raya_routine_effect_membership WHERE capsule = ?").run(own.capsule)
    db.query("UPDATE raya_routine_effect_capsule SET session = 'one' WHERE id = ?").run(own.capsule)
    const before = states(db)
    peer.exec("UPDATE session SET time_archived = 2 WHERE id = 'one'")
    expect(state(db, "capsule", own.capsule)).toBe("revoked")
    expect(state(db, "scope", own.scope)).toBe("active")
    expect(state(db, "scope", other.scope)).toBe("active")
    expect(state(db, "capsule", other.capsule)).toBe("active")
    expect(states(db).attempts).toEqual(before.attempts)
    expect(db.query("SELECT * FROM raya_routine_effect_revocation").all()).toEqual([])
  })
})

for (const field of ["parentID", "modelID", "providerID", "agent", "time_created", "delete"])
  test(`assistant ${field} substitution revokes its exact session while benign streamed usage remains valid`, async () => {
    await fixture((db, peer) => {
      parents(db)
      const original = {
        role: "assistant",
        parentID: "original-user",
        modelID: "model",
        providerID: "provider",
        agent: "worker",
        time: { created: 1 },
      }
      db.query(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'one', 1, 1, ?)",
      ).run(JSON.stringify(original))
      const own = seed(db, "session", "one", "1")
      const other = seed(db, "session", "two", "2")
      const before = states(db)
      peer.query("UPDATE message SET data = ?, time_updated = 2 WHERE id = 'assistant'").run(
        JSON.stringify({
          ...original,
          finish: "stop",
          tokens: { input: 2, output: 3 },
          time: { created: 1, completed: 2 },
        }),
      )
      expect(states(db)).toEqual(before)
      if (field === "time_created") peer.exec("UPDATE message SET time_created = 3 WHERE id = 'assistant'")
      if (field === "delete") peer.exec("DELETE FROM message WHERE id = 'assistant'")
      if (field !== "time_created" && field !== "delete")
        peer
          .query("UPDATE message SET data = ? WHERE id = 'assistant'")
          .run(JSON.stringify({ ...original, [field]: "substituted" }))
      expect(state(db, "scope", own.scope)).toBe("revoking")
      expect(state(db, "capsule", own.capsule)).toBe("revoked")
      expect(state(db, "scope", other.scope)).toBe("active")
      expect(state(db, "capsule", other.capsule)).toBe("active")
      expect(states(db).attempts).toEqual(before.attempts)
    })
  })

test("malformed new-schema assistant data cannot bypass the SQL authority barrier", async () => {
  await fixture((db, peer) => {
    parents(db)
    const own = seed(db, "session", "one", "1")
    const other = seed(db, "session", "two", "2")
    const before = states(db)
    peer.exec(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('invalid', 'one', 'assistant', 1, 2, 2, 'not-json')",
    )
    expect(state(db, "scope", own.scope)).toBe("revoking")
    expect(state(db, "capsule", own.capsule)).toBe("revoked")
    expect(state(db, "scope", other.scope)).toBe("active")
    expect(state(db, "capsule", other.capsule)).toBe("active")
    expect(states(db).attempts).toEqual(before.attempts)
    expect(db.query("SELECT data FROM session_message WHERE id = 'invalid'").get()).toEqual({ data: "not-json" })
  })
})

function modern(status: "running" | "completed") {
  return {
    type: "assistant",
    agent: "worker",
    model: { providerID: "provider", modelID: "model" },
    content: [
      {
        type: "tool",
        id: "original-call",
        name: "read",
        provider: { executed: false, metadata: { original: true } },
        state: {
          status,
          input: { path: "/repo" },
          structured: {},
          content: [{ type: "text", text: "Observed output" }],
        },
        time: { created: 1, ...(status === "completed" ? { completed: 2 } : {}) },
      },
    ],
    time: { created: 1 },
  }
}

test("modern assistant original running tool may complete and stream text without revoking", async () => {
  await fixture((db, peer) => {
    parents(db)
    db.query(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('assistant', 'one', 'assistant', 1, 1, 1, ?)",
    ).run(JSON.stringify(modern("running")))
    seed(db, "session", "one", "1")
    seed(db, "session", "two", "2")
    const before = states(db)
    const completed = modern("completed")
    peer
      .query("UPDATE session_message SET data = ?, time_updated = 2 WHERE id = 'assistant'")
      .run(JSON.stringify(completed))
    expect(states(db)).toEqual(before)
    peer.query("UPDATE session_message SET data = ?, time_updated = 3 WHERE id = 'assistant'").run(
      JSON.stringify({
        ...completed,
        finish: "stop",
        tokens: { input: 2, output: 3 },
        time: { created: 1, completed: 3 },
        content: [...completed.content, { type: "text", id: "text", text: "Final text" }],
      }),
    )
    expect(states(db)).toEqual(before)
  })
})

for (const field of ["status", "content", "input", "structured", "metadata"])
  test(`modern previously completed tool ${field} rewrite revokes only its actual session`, async () => {
    await fixture((db, peer) => {
      parents(db)
      const original = modern("completed")
      db.query(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('assistant', 'one', 'assistant', 1, 1, 1, ?)",
      ).run(JSON.stringify(original))
      const own = seed(db, "session", "one", "1")
      const other = seed(db, "session", "two", "2")
      const before = states(db)
      const tool = original.content[0]
      const phase =
        field === "status"
          ? { ...tool.state, status: "running" }
          : field === "content"
            ? { ...tool.state, content: [{ type: "text", text: "Substituted output" }] }
            : field === "input"
              ? { ...tool.state, input: { path: "/other" } }
              : field === "structured"
                ? { ...tool.state, structured: { changed: true } }
                : tool.state
      const content = {
        ...tool,
        state: phase,
        provider: field === "metadata" ? { ...tool.provider, metadata: { changed: true } } : tool.provider,
      }
      peer
        .query("UPDATE session_message SET data = ? WHERE id = 'assistant'")
        .run(JSON.stringify({ ...original, content: [content] }))
      expect(state(db, "scope", own.scope)).toBe("revoking")
      expect(state(db, "scope", other.scope)).toBe("active")
      expect(state(db, "capsule", own.capsule)).toBe("revoked")
      expect(state(db, "capsule", other.capsule)).toBe("active")
      expect(states(db).attempts).toEqual(before.attempts)
    })
  })

test("legacy completed tool part output rewrite invalidates retained evidence", async () => {
  await fixture((db, peer) => {
    parents(db)
    db.exec(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('assistant', 'one', 1, 1, '{\"role\":\"assistant\"}')",
    )
    const original = {
      type: "tool",
      tool: "read",
      callID: "original",
      state: { status: "completed", input: { path: "/repo" }, output: "Observed output", time: { start: 1, end: 2 } },
    }
    db.query(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('tool', 'assistant', 'one', 1, 1, ?)",
    ).run(JSON.stringify(original))
    const own = seed(db, "session", "one", "1")
    const other = seed(db, "session", "two", "2")
    const before = states(db)
    peer
      .query("UPDATE part SET data = ? WHERE id = 'tool'")
      .run(JSON.stringify({ ...original, state: { ...original.state, output: "Substituted" } }))
    expect(state(db, "scope", own.scope)).toBe("revoking")
    expect(state(db, "capsule", own.capsule)).toBe("revoked")
    expect(state(db, "scope", other.scope)).toBe("active")
    expect(state(db, "capsule", other.capsule)).toBe("active")
    expect(states(db).attempts).toEqual(before.attempts)
  })
})

test("modern assistant raw JSON at 2MiB remains streamable; one extra UTF8 byte revokes only its owner", async () => {
  await fixture((db, peer) => {
    parents(db)
    const own = seed(db, "session", "one", "1")
    const other = seed(db, "session", "two", "2")
    const before = states(db)
    const empty = { ...modern("running"), content: [{ type: "text", id: "text", text: "" }] }
    const padding = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty), "utf8")
    const value = { ...empty, content: [{ type: "text", id: "text", text: "x".repeat(padding) }] }
    const encoded = JSON.stringify(value)
    expect(Buffer.byteLength(encoded, "utf8")).toBe(2 * 1024 * 1024)
    peer
      .query(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('assistant', 'one', 'assistant', 1, 1, 1, ?)",
      )
      .run(encoded)
    expect(states(db)).toEqual(before)
    const overflow = JSON.stringify({ ...value, content: [{ ...value.content[0], text: value.content[0].text + "x" }] })
    expect(Buffer.byteLength(overflow, "utf8")).toBe(2 * 1024 * 1024 + 1)
    peer.query("UPDATE session_message SET data = ? WHERE id = 'assistant'").run(overflow)
    expect(state(db, "scope", own.scope)).toBe("revoking")
    expect(state(db, "capsule", own.capsule)).toBe("revoked")
    expect(state(db, "scope", other.scope)).toBe("active")
    expect(state(db, "capsule", other.capsule)).toBe("active")
    expect(states(db).attempts).toEqual(before.attempts)
    expect(
      db
        .query<
          { bytes: number },
          []
        >("SELECT length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE id = 'assistant'")
        .get(),
    ).toEqual({ bytes: 2 * 1024 * 1024 + 1 })
  })
})

test("modern assistant content at 1024 entries remains streamable; 1025 revokes without skipping its owner", async () => {
  await fixture((db, peer) => {
    parents(db)
    const own = seed(db, "session", "one", "1")
    const other = seed(db, "session", "two", "2")
    const before = states(db)
    const content = Array.from({ length: 1024 }, (_, index) => ({
      type: "text",
      id: `text-${index}`,
      text: "Bounded output",
    }))
    const value = { ...modern("running"), content }
    peer
      .query(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('assistant', 'one', 'assistant', 1, 1, 1, ?)",
      )
      .run(JSON.stringify(value))
    expect(states(db)).toEqual(before)
    peer
      .query("UPDATE session_message SET data = ? WHERE id = 'assistant'")
      .run(JSON.stringify({ ...value, content: [...content, { type: "text", id: "overflow", text: "Extra" }] }))
    expect(state(db, "scope", own.scope)).toBe("revoking")
    expect(state(db, "capsule", own.capsule)).toBe("revoked")
    expect(state(db, "scope", other.scope)).toBe("active")
    expect(state(db, "capsule", other.capsule)).toBe("active")
    expect(states(db).attempts).toEqual(before.attempts)
  })
})

test("real incremental Core migration restores the shipped triggers once and preserves prior SQL and inactive evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-revocation-upgrade-"))
  const file = path.join(root, "authority.sqlite")
  await opened(file, (db) => {
    parents(db)
    seed(db, "session", "one", "1", "inactive")
    db.exec(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (\'original\', \'one\', 1, 1, \'{"role":"user","text":"Retained input"}\')',
    )
  })
  // The complete original service scope has closed before the owned old-schema
  // fixture removes exactly this additive migration's triggers and journal row.
  const prior = new SQLite(file)
  const baseline = (() => {
    try {
      const value = {
        sessions: prior.query("SELECT * FROM session ORDER BY id").all(),
        messages: prior.query("SELECT * FROM message ORDER BY id").all(),
        effects: states(prior),
        participants: prior.query("SELECT * FROM raya_routine_effect_participant ORDER BY id").all(),
        memberships: prior.query("SELECT * FROM raya_routine_effect_membership ORDER BY capsule, scope").all(),
        journal: prior.query("SELECT * FROM migration WHERE id <> ? ORDER BY id").all(migration.id),
        triggers: inventory(prior),
      }
      expect(value.triggers).toHaveLength(statements.length)
      expect(prior.query("SELECT count(*) AS count FROM migration WHERE id = ?").get(migration.id)).toEqual({
        count: 1,
      })
      prior.exec("BEGIN IMMEDIATE")
      try {
        for (const trigger of value.triggers) prior.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`)
        expect(prior.query("DELETE FROM migration WHERE id = ?").run(migration.id).changes).toBe(1)
        prior.exec("COMMIT")
      } catch (err) {
        prior.exec("ROLLBACK")
        throw err
      }
      expect(inventory(prior)).toEqual([])
      expect(prior.query("SELECT * FROM migration WHERE id <> ? ORDER BY id").all(migration.id)).toEqual(value.journal)
      expect(states(prior)).toEqual(value.effects)
      return value
    } finally {
      prior.close()
    }
  })()
  const receipts: { id: string; time_completed: number }[] = []
  for (let turn = 0; turn < 2; turn++)
    await opened(file, (db, peer) => {
      expect(inventory(db)).toEqual(baseline.triggers)
      expect(inventory(db).map((row) => row.sql)).toEqual(statements.map(normal).sort())
      expect(db.query("SELECT count(*) AS count FROM migration WHERE id = ?").get(migration.id)).toEqual({ count: 1 })
      expect(db.query("SELECT * FROM migration WHERE id <> ? ORDER BY id").all(migration.id)).toEqual(baseline.journal)
      expect(db.query("SELECT * FROM session ORDER BY id").all()).toEqual(baseline.sessions)
      expect(db.query("SELECT * FROM message ORDER BY id").all()).toEqual(baseline.messages)
      expect(states(db)).toEqual(baseline.effects)
      expect(states(peer)).toEqual(baseline.effects)
      expect(db.query("SELECT * FROM raya_routine_effect_participant ORDER BY id").all()).toEqual(baseline.participants)
      expect(db.query("SELECT * FROM raya_routine_effect_membership ORDER BY capsule, scope").all()).toEqual(
        baseline.memberships,
      )
      expect(state(db, "scope", "1".repeat(64))).toBe("inactive")
      expect(state(db, "capsule", "1".repeat(32))).toBe("inactive")
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([])
      const receipt = db
        .query<{ id: string; time_completed: number }, [string]>("SELECT * FROM migration WHERE id = ?")
        .get(migration.id)
      expect(receipt).not.toBeNull()
      if (!receipt) throw new Error("Incremental migration receipt is missing")
      receipts.push(receipt)
    })
  expect(receipts).toHaveLength(2)
  expect(receipts[1]).toEqual(receipts[0])
  // Every original service and direct connection is closed. A failure above
  // retains the owned database rather than removing the migration evidence.
  await rm(root, { recursive: true })
})

function normal(value: string) {
  return value.replace(/\s+/g, " ").trim().replace(/;$/, "")
}

function inventory(db: SQLite) {
  return db
    .query<{ name: string; sql: string }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'raya_routine_authority_%'",
    )
    .all()
    .map((row) => ({ name: row.name, sql: normal(row.sql) }))
    .sort((a, b) => (a.sql < b.sql ? -1 : a.sql > b.sql ? 1 : 0))
}
