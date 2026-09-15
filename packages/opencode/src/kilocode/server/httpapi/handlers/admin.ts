import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { RayaAdminLog } from "@/kilocode/admin/log"
import { RayaAdminService } from "@/kilocode/admin/service"
import { RayaMigrationLedger } from "@/kilocode/migration/compatibility"
import { RayaTask } from "@/kilocode/task"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"

export const adminHandlers = HttpApiBuilder.group(InstanceHttpApi, "raya-admin", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    const logs = yield* RayaAdminLog.Service
    const tasks = RayaTask.make({ storage, database })

    const health = Effect.fn("RayaAdminHttpApi.health")(function* () {
      const ctx = yield* InstanceState.context
      const admin = RayaAdminService.make({
        runtime: () => "connected",
        sessions: {
          list: (input) => sessions.list(input).pipe(Effect.provideService(InstanceRef, ctx)),
        },
        tasks,
        report: (event) => Effect.runPromise(logs.write(event).pipe(Effect.provideService(InstanceRef, ctx))),
      })
      const snapshot = yield* Effect.promise(() => admin.snapshot())
      return snapshot
    })

    return handlers
      .handle("adminHealth", health)
      .handle("adminLogs", (ctx) => logs.list({ after: ctx.query.after, limit: ctx.query.limit }))
      .handle("adminMigration", () => Effect.succeed(RayaMigrationLedger.snapshot))
  }),
)
