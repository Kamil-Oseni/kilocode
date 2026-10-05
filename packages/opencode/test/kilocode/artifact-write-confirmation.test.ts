import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import { Format } from "@/format"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Storage } from "@/storage/storage"
import { WriteTool } from "@/tool/write"
import { EditTool } from "@/tool/edit"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { MessageID, SessionID } from "@/session/schema"
import * as Artifact from "@/kilocode/goal/artifact"
import { TestInstance } from "../fixture/fixture"
import { InstanceState } from "@/effect/instance-state"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node, Storage.node]),
  ),
)

for (const kind of ["write", "edit", "patch"] as const) {
  for (const race of ["none", "missing", "changed"] as const) {
    it.instance(
      `${kind} reports ${race === "none" ? "confirmed bytes" : `unconfirmed executed mutation after ${race} readback`}`,
      () =>
        Effect.gen(function* () {
          const instance = yield* TestInstance
          const fs = yield* FSUtil.Service
          const lsp = yield* LSP.Service
          const file = path.join(instance.directory, "result.txt")
          yield* fs.writeFileString(file, "before\n")
          const observed: string[] = []
          // Simulate another real filesystem writer after mutation, before artifact readback.
          // Capture itself and all three tools execute their production implementations.
          const service = {
            ...lsp,
            touchFile: (target: string) =>
              Effect.gen(function* () {
                expect(target).toBe(file)
                observed.push(yield* fs.readFileString(target))
                if (race === "missing") yield* fs.remove(target)
                if (race === "changed") yield* fs.writeFileString(target, "another writer\n")
              }).pipe(Effect.orDie),
          }
          const ctx = {
            sessionID: SessionID.make(`ses_confirmation_${kind}_${race}`),
            messageID: MessageID.make(`msg_confirmation_${kind}_${race}`),
            callID: "mutation",
            agent: "code",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }
          const result = yield* Effect.gen(function* () {
            if (kind === "write")
              return yield* (yield* (yield* WriteTool).init()).execute({ filePath: file, content: "after\n" }, ctx)
            if (kind === "edit")
              return yield* (yield* (yield* EditTool).init()).execute(
                { filePath: file, oldString: "before", newString: "after" },
                ctx,
              )
            const tool = yield* (yield* ApplyPatchTool).init()
            const result = yield* tool.execute(
              { patchText: "*** Begin Patch\n*** Update File: result.txt\n@@\n-before\n+after\n*** End Patch" },
              ctx,
            )
            if (race !== "none") {
              const again = yield* tool.execute(
                { patchText: "*** Begin Patch\n*** Update File: result.txt\n@@\n-before\n+after\n*** End Patch" },
                ctx,
              )
              expect(again).toEqual(result)
              expect(observed).toHaveLength(1)
            }
            return result
          }).pipe(Effect.provideService(LSP.Service, service))
          expect(observed).toEqual(["after\n"])
          expect(result.metadata.rayaVerification).toBe(race === "none" ? "confirmed" : "unavailable")
          expect(yield* Artifact.current(result.metadata.rayaRevision)).toBe(race === "none")
          if (race === "none") {
            expect(result.output).toMatch(/success/i)
            expect(yield* fs.readFileString(file)).toBe("after\n")
            return
          }
          expect(result.output).toContain("Mutation executed, but saved file state could not be verified")
          expect(result.output).toContain("Do not automatically retry")
          expect(result.output).not.toMatch(/success/i)
          const diagnostics = "Pre-existing config issues (from session start):\ncontrolled warning\n"
          expect(
            Artifact.confirmation(
              result.metadata.rayaRevision,
              `Wrote file successfully.${diagnostics}`,
              "Wrote file successfully.",
            ).output,
          ).toContain(diagnostics)
          if (race === "changed") expect(yield* fs.readFileString(file)).toBe("another writer\n")
          if (race === "missing") expect(yield* fs.exists(file)).toBe(false)
        }),
      30_000,
    )
  }
}

it.instance("a recreated deleted path leaves a committed mixed patch unconfirmed", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const context = yield* InstanceState.context
    const fs = yield* FSUtil.Service
    const lsp = yield* LSP.Service
    const removed = path.join(instance.directory, "removed.txt")
    yield* fs.writeFileString(removed, "before\n")
    const service = {
      ...lsp,
      touchFile: () =>
        Effect.gen(function* () {
          expect(yield* fs.exists(removed)).toBe(false)
          yield* fs.writeFileString(removed, "recreated\n")
        }).pipe(Effect.orDie),
    }
    const result = yield* Effect.gen(function* () {
      const tool = yield* (yield* ApplyPatchTool).init()
      return yield* tool.execute(
        { patchText: "*** Begin Patch\n*** Add File: added.txt\n+after\n*** Delete File: removed.txt\n*** End Patch" },
        {
          sessionID: SessionID.make("ses_confirmation_delete"),
          messageID: MessageID.make("msg_confirmation_delete"),
          callID: "mutation",
          agent: "code",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
    }).pipe(Effect.provideService(LSP.Service, service))
    expect(result.metadata.rayaVerification).toBe("unavailable")
    expect(result.output).toContain(
      `A ${path.relative(context.worktree, path.join(instance.directory, "added.txt")).replaceAll("\\", "/")}`,
    )
    expect(result.output).toContain(`D ${path.relative(context.worktree, removed).replaceAll("\\", "/")}`)
    expect(yield* Artifact.current(result.metadata.rayaRevision)).toBe(false)
    expect(yield* fs.readFileString(removed)).toBe("recreated\n")
  }),
)
