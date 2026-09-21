import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { RayaAdminLog } from "@/kilocode/admin/log"
import { RayaAdminService } from "@/kilocode/admin/service"
import { RayaMigrationLedger } from "@/kilocode/migration/compatibility"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskOrganization } from "@/kilocode/task/organization"
import { PersonalTodo } from "@/kilocode/personal-todo"
import { Canvas } from "@/kilocode/canvas/service"
import { RayaContactOutbox } from "@/kilocode/contact/outbox"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { Skill } from "@/skill"
import { RayaGoalHealth } from "@/kilocode/goal/health"
import { RayaTaskHealth } from "@/kilocode/task/health"

export const adminHandlers = HttpApiBuilder.group(InstanceHttpApi, "raya-admin", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const database = yield* Database.Service
    const logs = yield* RayaAdminLog.Service
    const skills = yield* Skill.Service
    const canvas = yield* Canvas.Service
    const memory = yield* MemoryService.Service
    const tasks = RayaTask.make({ storage, database })
    const organizations = RayaTaskOrganization.make(database, { get: tasks.get }, storage)
    const todos = PersonalTodo.make({ storage })
    const contacts = RayaContactOutbox.make(database)

    const health = Effect.fn("RayaAdminHttpApi.health")(function* () {
      const ctx = yield* InstanceState.context
      const admin = RayaAdminService.make({
        runtime: () => "connected",
        sessions: {
          list: (input) => sessions.list(input).pipe(Effect.provideService(InstanceRef, ctx)),
        },
        tasks,
        goals: () => Effect.runPromise(RayaGoalHealth.inspect(storage)),
        scheduler: () => Effect.runPromise(RayaTaskHealth.inspect(database, storage)),
        organizations: () =>
          Effect.runPromise(organizations.list({ limit: 1 }).pipe(Effect.provideService(InstanceRef, ctx))),
        skills: () => Effect.runPromise(skills.all().pipe(Effect.provideService(InstanceRef, ctx))),
        todos: () => Effect.runPromise(todos.list().pipe(Effect.provideService(InstanceRef, ctx))),
        contacts: () =>
          Effect.runPromise(
            Effect.all([contacts.listDestinations(1), contacts.listMessages(1)]).pipe(
              Effect.provideService(InstanceRef, ctx),
            ),
          ),
        memory: () => Effect.runPromise(memory.status({ ctx })),
        canvas: () => Effect.runPromise(canvas.list().pipe(Effect.provideService(InstanceRef, ctx))),
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
