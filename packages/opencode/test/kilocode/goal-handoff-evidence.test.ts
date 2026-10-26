import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { MessageID, PartID } from "@/session/schema"
import { RayaGoal } from "@/kilocode/goal"
import * as Artifact from "@/kilocode/goal/artifact"
import { database, storage } from "./fixtures/effect-profile"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      Session.node,
      Storage.node,
      Git.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)

it.live(
  "saved handoff criteria require accepted delegation evidence, while file-only and negated criteria remain valid",
  () =>
    provideTmpdirInstance(
      Effect.fn(function* (dir) {
        const fs = yield* FSUtil.Service
        const sessions = yield* Session.Service
        const store = yield* Storage.Service
        const goals = RayaGoal.make({ storage: store, sessions })
        for (const mode of [
          "rejected",
          "missing",
          "observed",
          "accepted",
          "optional",
          "ordinary",
          "negated",
          "guidance",
        ]) {
          const chat = yield* sessions.create({ title: "Private handoff evidence regression" })
          const goal = yield* goals.create(chat.id, "Save the research and satisfy the saved criterion")
          yield* Effect.addFinalizer(() => goals.clear(chat.id))
          const description =
            mode === "ordinary"
              ? "Save a researched prospect note."
              : mode === "negated"
                ? "Save research without delegation."
                : mode === "guidance"
                  ? "Write delegation guidance."
                  : mode === "optional"
                    ? "Accept delegation to Builder."
                    : mode === "observed"
                      ? "Accept Builder's delegation receipt containing ONLY the written research.md file in this same job directory."
                      : "Accept delegation to Builder only if delegate_work shows the actual saved research artifact."
          const verification =
            mode === "negated"
              ? "Read the file; do not delegate."
              : mode === "ordinary"
                ? "Verify the saved file."
                : mode === "guidance"
                  ? "Read the saved document explaining delegation."
                  : mode === "optional"
                    ? "Verify an accepted delegate_work receipt, without actual file artifacts."
                    : mode === "observed"
                      ? "Verify the child tool call from Builder cites the current research.md read with actual MD bytes and hash evidence."
                      : "Delegate_work receipt contains both criterion IDs, job folder context and actual research.md artifact."
          yield* goals.edit(chat.id, {
            expectedIntent: goal.intent,
            criteria: [{ id: "result", description, verification }],
          })
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            role: "user",
            agent: "code",
            model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") },
            time: { created: Date.now() },
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            parentID: user.id,
            role: "assistant",
            agent: "code",
            mode: "code",
            providerID: user.model.providerID,
            modelID: user.model.modelID,
            cost: 0,
            path: { cwd: dir, root: dir },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          })
          const file = path.join(dir, `${mode}.md`)
          yield* fs.writeFileString(file, "Verified prospect research\n")
          const revision = yield* Artifact.capture(fs, file)
          if (revision.status !== "captured") throw new Error("Actual private file capture required")
          const write = yield* sessions.updatePart({
            id: PartID.ascending(),
            sessionID: chat.id,
            messageID: assistant.id,
            type: "tool",
            tool: "write",
            callID: `write-${mode}`,
            state: {
              status: "completed",
              input: { filePath: file },
              output: "File written",
              title: "Research file",
              metadata: { rayaRevision: revision },
              time: { start: Date.now(), end: Date.now() },
            },
          })
          if (["rejected", "missing", "observed", "accepted", "optional"].includes(mode))
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: chat.id,
              messageID: assistant.id,
              type: "tool",
              tool: "delegate_work",
              callID: `delegate-${mode}`,
              state: {
                status: "completed",
                input: {
                  deadline: mode === "rejected" ? 0 : undefined,
                  ...(mode === "accepted" ? { artifacts: [file] } : {}),
                },
                output: mode === "rejected" ? "This delegation deadline has already passed." : "Delegation accepted",
                title: "Handoff",
                metadata:
                  mode === "rejected"
                    ? { requestStatus: "error", state: "rejected" }
                    : { requestStatus: "complete", delegationID: "rdl_actual_accepted_fixture", state: "accepted" },
                time: { start: Date.now(), end: Date.now() },
              },
            })
          const evidence = yield* goals.evidence(chat.id)
          expect(evidence.some((row) => row.callID === `write-${mode}`)).toBe(true)
          expect(evidence.some((row) => row.callID === "delegate-rejected")).toBe(false)
          const result = yield* goals
            .update(chat.id, {
              status: "complete",
              audit: {
                summary: "Research and required work finished",
                requirements: [
                  {
                    criterionID: "result",
                    requirement: description,
                    passed: true,
                    evidence: [
                      {
                        callID: write.callID,
                        summary: "Wrote research and accepted delegate_work handoff to Builder.",
                      },
                      ...(["accepted", "missing", "observed", "optional"].includes(mode)
                        ? [
                            {
                              callID: `delegate-${mode}`,
                              summary: "Host recorded an accepted handoff with the research file.",
                            },
                          ]
                        : []),
                    ],
                  },
                ],
              },
            })
            .pipe(Effect.result)
          if (["rejected", "missing", "observed"].includes(mode)) {
            expect(result._tag).toBe("Failure")
            expect((yield* goals.get(chat.id))?.status).toBe("active")
            expect((yield* goals.get(chat.id))?.auditAttempt?.reason).toContain(
              mode === "rejected" ? "accepted delegate_work handoff receipt" : "actual file artifacts",
            )
            continue
          }
          expect(result._tag).toBe("Success")
          expect((yield* goals.get(chat.id))?.status).toBe("complete")
          expect(yield* fs.readFileString(file)).toBe("Verified prospect research\n")
        }
      }),
    ),
  15000,
)
