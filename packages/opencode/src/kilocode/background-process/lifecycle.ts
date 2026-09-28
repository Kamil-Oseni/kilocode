import { Effect, ManagedRuntime } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { RayaRoutineOrganizationTable as Organization } from "@opencode-ai/core/kilocode/routine.sql"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { SessionID } from "@/session/schema"
import { Filesystem } from "@/util/filesystem"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { and, eq, inArray, or, sql } from "drizzle-orm"
import { KiloShutdown } from "@/kilocode/cli/shutdown"
import { memoMap } from "@opencode-ai/core/effect/memo-map"

const runtime = ManagedRuntime.make(LayerNode.compile(Database.node), { memoMap })
KiloShutdown.register(() => runtime.dispose())
const directory = () => path.join(Global.Path.state, "background-process", "lifecycle")
const file = (id: SessionID) => path.join(directory(), `${id}.json`)

export async function acquire() {
  await mkdir(directory(), { recursive: true, mode: 0o700 })
  return Flock.acquire("background-process-lifecycle-v1", { dir: directory(), timeoutMs: 60_000 })
}

export async function locked<A>(body: () => Promise<A>) {
  const lease = await acquire()
  try {
    return await body()
  } finally {
    await lease.release()
  }
}

export async function mark(organization: string, sessions: readonly SessionID[]) {
  for (const id of sessions)
    await Filesystem.writeJson(
      file(id),
      { version: 1, sessionID: id, organizationID: organization, at: Date.now() },
      0o600,
    )
}

async function denied(id: SessionID) {
  const raw = await readFile(file(id), "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined
    throw err
  })
  return raw !== undefined
}

/** Read only persisted ancestry and organization lifecycle; never project command, output, or credentials. */
export const authorize = Effect.fn("BackgroundProcess.authorize")(function* (
  database: Database.Interface,
  id: SessionID,
) {
  const db = database.db
  const seen = new Set<SessionID>()

  let current: SessionID | undefined = id
  while (current) {
    if (seen.has(current)) throw new Error("Background process session ancestry is inconsistent")
    if (seen.size >= 10_000) throw new Error("Background process session ancestry exceeded its limit")
    seen.add(current)
    if (yield* Effect.tryPromise(() => denied(current!)))
      throw new Error("This process session belongs to a stopping or archived organization")
    const row: { parent: SessionID | null; metadata: Record<string, unknown> | null } | undefined = yield* db
      .select({ parent: SessionTable.parent_id, metadata: SessionTable.metadata })
      .from(SessionTable)
      .where(eq(SessionTable.id, current))
      .get()
    if (!row) return
    const routine = row.metadata?.rayaRoutine
    if (routine && typeof routine === "object" && !Array.isArray(routine) && "organizationID" in routine) {
      const organization = routine.organizationID
      if (typeof organization === "string") {
        const owner = yield* db
          .select({ stopping: Organization.stopping_at, archived: Organization.archived_at })
          .from(Organization)
          .where(eq(Organization.id, organization))
          .get()
        if (!owner || owner.stopping !== null || owner.archived !== null)
          throw new Error("This process session belongs to a stopping or archived organization")
      }
    }
    current = row.parent ?? undefined
  }
})

export async function allowed(id: SessionID) {
  await runtime.runPromise(Database.Service.use((database) => authorize(database, id)))
}

export const lineage = Effect.fn("BackgroundProcess.lineage")(function* (
  database: Database.Interface,
  members: readonly string[],
  history: readonly SessionID[],
) {
  const max = 10_000
  if (history.length > max) throw new Error("Organization process lineage exceeds the bounded inspection limit")
  const rows = yield* database.db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(
      or(
        inArray(SessionTable.id, [...history]),
        and(
          sql`json_valid(${SessionTable.metadata})`,
          inArray(sql`json_extract(${SessionTable.metadata}, '$.rayaRoutine.agentID')`, [...members]),
        ),
      ),
    )
    .limit(max + 1)
    .all()
  if (rows.length > max) throw new Error("Organization process lineage exceeds the bounded inspection limit")
  const ids = new Set(history)
  for (const row of rows) ids.add(row.id)
  if (ids.size > max) throw new Error("Organization process lineage exceeds the bounded inspection limit")
  const queue = [...ids]
  while (queue.length) {
    const batch = queue.splice(0, 200)
    const children = yield* database.db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(inArray(SessionTable.parent_id, batch))
      .limit(max + 1)
      .all()
    if (children.length > max) throw new Error("Organization process lineage exceeds the bounded inspection limit")
    for (const child of children) {
      if (ids.has(child.id)) continue
      ids.add(child.id)
      if (ids.size > max) throw new Error("Organization process lineage exceeds the bounded inspection limit")
      queue.push(child.id)
    }
  }
  return [...ids]
})

export const expand = (members: readonly string[], history: readonly SessionID[]) =>
  runtime.runPromise(Database.Service.use((database) => lineage(database, members, history)))

export async function witness(id: SessionID) {
  const row = await runtime.runPromise(
    Database.Service.use(({ db }) =>
      db.select({ directory: SessionTable.directory }).from(SessionTable).where(eq(SessionTable.id, id)).get(),
    ),
  )
  if (!row) throw new Error("Organization process has no persisted session owner")
  return row.directory
}
