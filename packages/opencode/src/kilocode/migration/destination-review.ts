import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { lstat, open } from "node:fs/promises"
import path from "node:path"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "@/kilocode/task"
import { hold } from "@/kilocode/task/hold"
import { ReviewSchema } from "./profile-restore-review-schema"

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))
const id = Schema.String.check(Schema.isUUID())
const strict = { parseOptions: { onExcessProperty: "error" as const } }

export const Approval = Schema.Struct({
  id,
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  reviewed: Schema.Literal(true),
  workspacesAcknowledged: Schema.Literal(true),
  reconnectAcknowledged: Schema.Literal(true),
}).annotate(strict)
export const Summary = Schema.Struct({
  state: Schema.Literals(["absent", "held", "released"]),
  id: Schema.optional(id),
  revision: Schema.optional(Schema.String),
  review: Schema.optional(
    Schema.Struct({ at: Schema.Finite, by: Schema.Literal("user"), revision: Schema.optional(Schema.String) }),
  ),
  reconnectCredentials: Schema.Boolean,
  uncertainWork: Schema.Literal("held-no-replay"),
  workspaces: Schema.Array(Schema.Struct({ source: text, destination: text })),
  workers: Schema.Array(Schema.Struct({ id: text, name: text, enabled: Schema.Boolean })),
})

/** Display evidence supplies no path authority; only the live exact hold can authorize review. */
export function destinationReview(input: {
  storage: Storage.Interface
  data: string
  workers: () => Effect.Effect<readonly RayaTask.Agent[]>
}) {
  const gate = hold(input.storage)
  const invalid = (kind: "conflict" | "unavailable", message: string) =>
    new RayaTask.GuardError({ kind, field: "restore-review", message })
  const evidence = () =>
    Effect.tryPromise({
      try: async () => {
        const file = path.join(input.data, "restore-review.json")
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
          throw new Error("Review evidence is not a bounded unique regular file")
        await using handle = await open(file, "r")
        const actual = await handle.stat()
        if (
          !actual.isFile() ||
          actual.nlink !== 1 ||
          actual.dev !== stat.dev ||
          actual.ino !== stat.ino ||
          actual.size > 65536
        )
          throw new Error("Review evidence changed before its read")
        const buffer = Buffer.alloc(65537)
        const bytes = await handle.read(buffer, 0, buffer.length, 0)
        if (bytes.bytesRead > 65536) throw new Error("Review evidence exceeded the read limit")
        return JSON.parse(buffer.subarray(0, bytes.bytesRead).toString("utf8")) as unknown
      },
      catch: () =>
        invalid(
          "unavailable",
          "This transferred profile's review evidence is unreadable. Repair it before approving the profile.",
        ),
    }).pipe(
      Effect.flatMap((value) => Effect.try({ try: () => ReviewSchema.parse(value), catch: (err) => err })),
      Effect.mapError(() =>
        invalid(
          "unavailable",
          "This transferred profile's review evidence is unreadable. Repair it before approving the profile.",
        ),
      ),
    )
  const summary = () =>
    Effect.gen(function* () {
      const current = yield* gate.get()
      if (!current)
        return {
          state: "absent" as const,
          reconnectCredentials: false,
          uncertainWork: "held-no-replay" as const,
          workspaces: [],
          workers: [],
        }
      const saved = yield* evidence()
      if (saved.hold !== current.id)
        return yield* invalid(
          "conflict",
          "The transferred profile's review generation changed. Reload its review before approving.",
        )
      const entries = Object.entries(saved.workspaces)
      if (
        entries.length > 128 ||
        entries.some(([source, destination]) => !path.isAbsolute(source) || !path.isAbsolute(destination))
      )
        return yield* invalid("unavailable", "The transferred profile's workspace review is invalid.")
      const rows = yield* input
        .workers()
        .pipe(
          Effect.catchCause(() =>
            Effect.fail(
              invalid(
                "unavailable",
                "The transferred worker roster is unreadable. Repair it before approving the profile.",
              ),
            ),
          ),
        )
      if (rows.length > 1024)
        return yield* invalid("unavailable", "The transferred worker roster exceeds the review limit.")
      const workers = rows.map((row) => ({ id: row.id, name: row.name, enabled: row.enabled }))
      const workspaces = entries
        .map(([source, destination]) => ({ source, destination }))
        .sort((a, b) => a.source.localeCompare(b.source))
      const revision = createHash("sha256")
        .update(JSON.stringify({ id: current.id, workspaces, workers, evidence: saved }))
        .digest("hex")
      return {
        state: current.state,
        id: current.id,
        revision,
        ...(current.review ? { review: current.review } : {}),
        reconnectCredentials: saved.reconnectCredentials,
        uncertainWork: saved.uncertainWork,
        workspaces,
        workers,
      }
    })
  const approve = (value: typeof Approval.Type) =>
    Effect.gen(function* () {
      yield* gate.release(value.id, value, () =>
        Effect.gen(function* () {
          const current = yield* summary()
          if (!("revision" in current) || current.revision !== value.revision)
            return yield* invalid(
              "conflict",
              "The review changed. Reload it and review the current workspaces and workers.",
            )
          if (current.workers.some((worker) => worker.enabled))
            return yield* invalid(
              "conflict",
              "Pause every transferred worker before approving this profile. Approval will not pause or start work for you.",
            )
          return undefined
        }),
      )
      return yield* summary()
    })
  return { summary, approve }
}
