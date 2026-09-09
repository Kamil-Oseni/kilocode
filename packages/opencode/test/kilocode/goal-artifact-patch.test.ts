import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import * as Artifact from "@/kilocode/goal/artifact"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
  ),
)

describe("goal patch artifact revisions", () => {
  it.instance(
    "checks every final file and absent path from a real multi-file patch",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const fs = yield* FSUtil.Service
        for (const file of ["update.txt", "delete.txt", "source.txt"])
          yield* fs.writeFileString(path.join(instance.directory, file), "original\n")
        const info = yield* ApplyPatchTool
        const tool = yield* info.init()
        const result = yield* tool.execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Add File: added.txt",
              "+added",
              "*** Update File: update.txt",
              "@@",
              "-original",
              "+updated",
              "*** Delete File: delete.txt",
              "*** Update File: source.txt",
              "*** Move to: destination.txt",
              "@@",
              "-original",
              "+moved",
              "*** End Patch",
            ].join("\n"),
          },
          {
            sessionID: SessionID.make("ses_artifact_patch"),
            messageID: MessageID.make("msg_artifact_patch"),
            callID: "patch",
            agent: "code",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const revision = result.metadata.rayaRevision
        expect(revision.status).toBe("bundle")
        expect(revision.revisions).toHaveLength(5)
        expect(yield* Artifact.current(revision)).toBe(true)
        yield* fs.writeFileString(path.join(instance.directory, "unrelated.txt"), "independent")
        expect(yield* Artifact.current(revision)).toBe(true)
        for (const file of ["added.txt", "update.txt", "destination.txt"]) {
          const target = path.join(instance.directory, file)
          const before = yield* fs.readFile(target)
          yield* fs.writeFileString(target, "changed\n")
          expect(yield* Artifact.current(revision)).toBe(false)
          yield* fs.writeFile(target, before)
          expect(yield* Artifact.current(revision)).toBe(true)
        }
        for (const file of ["delete.txt", "source.txt"]) {
          const target = path.join(instance.directory, file)
          yield* fs.writeFileString(target, "recreated\n")
          expect(yield* Artifact.current(revision)).toBe(false)
          yield* fs.remove(target)
          yield* fs.makeDirectory(target)
          expect(yield* Artifact.current(revision)).toBe(false)
          expect(path.dirname(path.resolve(target))).toBe(path.resolve(instance.directory))
          yield* fs.remove(target, { recursive: true })
          expect(yield* Artifact.current(revision)).toBe(true)
        }
        expect(yield* Artifact.current({ version: 1, status: "bundle", revisions: [] })).toBe(false)
        expect(
          yield* Artifact.current({ ...revision, revisions: [...revision.revisions, { status: "unavailable" }] }),
        ).toBe(false)
      }),
    30_000,
  )
})
