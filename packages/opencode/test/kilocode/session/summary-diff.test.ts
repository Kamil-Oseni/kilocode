import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { MessageID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { provideTmpdirProject } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { boundaries } from "@/kilocode/session/review-boundaries"

const env = LayerNode.compile(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    SessionSummary.node,
    Snapshot.node,
    Storage.node,
    Database.node,
    CrossSpawnSpawner.node,
  ]),
)
const it = testEffect(env)

// A delegated (agent=auto) turn edits inside child subagent sessions, which own
// the real session_diff; the displayed parent frequently stores none of its own.
// session.diff on the parent must fold in descendant sessions so the in-editor
// review and "review changes" show what the subagents actually wrote.
describe("SessionSummary.diff subagent aggregation", () => {
  it.live(
    "ancestor boundary lookup does not import sibling acceptance",
    provideTmpdirProject(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const storage = yield* Storage.Service
          const parent = yield* sessions.create({})
          const target = yield* sessions.create({ parentID: parent.id })
          const sibling = yield* sessions.create({ parentID: parent.id })
          for (const session of [parent, target, sibling]) {
            yield* sessions.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              agent: "auto",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
              time: { created: Date.now() },
            })
          }
          yield* storage.write(["session_kept", sibling.id], { "shared.txt": "newer-sibling" })
          expect(yield* boundaries(storage, sessions, target.id)).toEqual({})
          yield* storage.write(["session_kept", parent.id], { "shared.txt": "ancestor" })
          expect(Object.values(yield* boundaries(storage, sessions, target.id))).toEqual(["ancestor"])
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "surfaces a child subagent session's stored diff from the parent",
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const summary = yield* SessionSummary.Service
          const storage = yield* Storage.Service

          const parent = yield* sessions.create({})
          const child = yield* sessions.create({ parentID: parent.id })
          const providerID = ProviderV2.ID.make("test")
          // Persist both session rows (create is lazy until a message lands), so
          // Session.children() can find the child by parent_id.
          yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: parent.id,
            role: "user",
            agent: "auto",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })
          yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: child.id,
            role: "user",
            agent: "designer",
            model: { providerID, modelID: ModelV2.ID.make("test") },
            time: { created: Date.now() },
          })

          const childDiff = [
            {
              file: "greetings.txt",
              patch:
                "diff --git a/greetings.txt b/greetings.txt\nnew file mode 100644\n--- /dev/null\n+++ b/greetings.txt\n@@ -0,0 +1 @@\n+Hi Kamil\n",
              additions: 1,
              deletions: 0,
              status: "added" as const,
            },
          ]
          // Parent stores nothing of its own; child owns the real diff.
          yield* storage.write(["session_diff", parent.id], [])
          yield* storage.write(["session_diff", child.id], childDiff)

          const result = yield* summary.diff({ sessionID: parent.id })

          expect(result).toHaveLength(1)
          expect(result[0].file).toBe("greetings.txt")
          expect(result[0].patch).toContain("+Hi Kamil")
          expect(result[0].status).toBe("added")
        }),
      { git: true },
    ),
    30_000,
  )

  it.live(
    "prefers the entry that carries patch text when both sessions list a file",
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const summary = yield* SessionSummary.Service
          const storage = yield* Storage.Service

          const parent = yield* sessions.create({})
          const child = yield* sessions.create({ parentID: parent.id })

          // Parent has an empty-patch placeholder for the file; child has the real patch.
          yield* storage.write(
            ["session_diff", parent.id],
            [{ file: "a.txt", patch: "", additions: 0, deletions: 0, status: "modified" as const }],
          )
          yield* storage.write(
            ["session_diff", child.id],
            [
              {
                file: "a.txt",
                patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
                additions: 1,
                deletions: 1,
                status: "modified" as const,
              },
            ],
          )

          const result = yield* summary.diff({ sessionID: parent.id })

          expect(result).toHaveLength(1)
          expect(result[0].file).toBe("a.txt")
          expect(result[0].patch).toContain("+new")
        }),
      { git: true },
    ),
    30_000,
  )
})
