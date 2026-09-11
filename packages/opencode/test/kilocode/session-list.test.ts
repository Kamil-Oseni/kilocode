import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { seedProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Session } from "../../src/session/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { InstanceRef } from "../../src/effect/instance-ref"
import { AbsolutePath } from "@opencode-ai/core/schema"
import * as Log from "@opencode-ai/core/util/log"

Log.init({ print: false })
const layer = LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node]))
const it = testEffect(layer)

describe("Kilo Session.list", () => {
  it.instance(
    "includes directory matches from legacy project ids",
    () =>
      Effect.gen(function* () {
        yield* seedProject
        const ctx = yield* InstanceRef
        if (!ctx) return yield* Effect.die(new Error("missing test instance"))
        const sessions = yield* Session.Service
        const { db } = yield* Database.Service
        const session = yield* sessions.create({ title: "legacy-session" })
        const project = ProjectV2.ID.make("legacy-project")
        yield* db.insert(ProjectTable).values({
          id: project,
          worktree: AbsolutePath.make(ctx.directory),
          vcs: "git",
          time_created: Date.now(),
          time_updated: Date.now(),
          sandboxes: [],
        })
        yield* db.update(SessionTable).set({ project_id: project }).where(eq(SessionTable.id, session.id))
        const list = yield* sessions.list({ directory: ctx.directory })
        expect(list.map((item) => item.id)).toContain(session.id)
      }),
  )

  it.instance(
    "matches legacy project ids through active sandboxes",
    () =>
      Effect.gen(function* () {
        yield* seedProject
        const ctx = yield* InstanceRef
        if (!ctx) return yield* Effect.die(new Error("missing test instance"))
        const sessions = yield* Session.Service
        const { db } = yield* Database.Service
        const session = yield* sessions.create({ title: "sandbox-session" })
        const project = ProjectV2.ID.make(`sandbox-project-${Date.now()}`)
        yield* db.insert(ProjectTable).values({
          id: project,
          worktree: AbsolutePath.make(path.join(ctx.directory, "removed-worktree")),
          vcs: "git",
          time_created: Date.now(),
          time_updated: Date.now(),
          sandboxes: [AbsolutePath.make(ctx.directory)],
        })
        yield* db.update(SessionTable).set({ project_id: project }).where(eq(SessionTable.id, session.id))
        const list = yield* Session.listGlobal({
          projectID: ctx.project.id,
          directories: [ctx.directory],
          roots: true,
        })
        expect(list.map((item) => item.id)).toContain(session.id)
      }),
  )

  it.instance(
    "omits marked routine execution sessions from the default chat list",
    () =>
      Effect.gen(function* () {
        yield* seedProject
        const ctx = yield* InstanceRef
        if (!ctx) return yield* Effect.die(new Error("missing test instance"))
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Accounts review" })
        const work = yield* sessions.create({
          title: "Accounts",
          metadata: {
            rayaRoutine: {
              version: 1,
              agentID: "agt_books",
              runID: "run_1",
              scheduleVersion: 1,
              trigger: { kind: "manual" },
            },
          },
        })
        const listed = (yield* sessions.list({ directory: ctx.directory })).map((item) => item.id)
        expect(listed).toContain(chat.id)
        expect(listed).not.toContain(work.id)
        expect((yield* sessions.get(work.id)).id).toBe(work.id)
        const only = (yield* sessions.list({ directory: ctx.directory, kind: "routine" })).map((item) => item.id)
        expect(only).toContain(work.id)
        expect(only).not.toContain(chat.id)
        const all = (yield* sessions.list({ directory: ctx.directory, kind: "all" })).map((item) => item.id)
        expect(all).toContain(chat.id)
        expect(all).toContain(work.id)
        const global = (yield* Session.listGlobal({ directory: ctx.directory, roots: true })).map((item) => item.id)
        expect(global).toContain(chat.id)
        expect(global).not.toContain(work.id)
      }),
  )
})
