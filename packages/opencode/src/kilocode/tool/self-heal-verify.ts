import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { ShellTool } from "@/tool/shell"
import { RayaGoal } from "@/kilocode/goal"
import { verification, identity } from "@/kilocode/self-heal/verification"
import type { Storage } from "@/storage/storage"
import { MessageID } from "@/session/schema"

const Input = Schema.Union([
  Schema.Struct({
    action: Schema.optional(Schema.Literal("run")),
    command: Schema.String.check(Schema.isMinLength(1)),
    setup: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    workdir: Schema.optional(Schema.String),
    timeout: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(600_000))),
  }),
  Schema.Struct({
    action: Schema.Literal("inspect"),
    messageID: MessageID,
    callID: Schema.String.check(Schema.isMinLength(1)),
  }),
])

export function selfHealVerify(goals: ReturnType<typeof RayaGoal.make>, storage: Storage.Interface) {
  return Tool.define(
    "self_heal_verify",
    Effect.gen(function* () {
      const shell = yield* ShellTool
      const service = verification(storage)
      return {
        description:
          "Run a repair check from an immutable capture of this self-heal session's owned source. Captures tracked and nonignored untracked files, including dirty bytes; excludes ignored dependency and credential files and rejects known credential-shaped inputs. This is not a general secret scanner. Runs in a private writable checkout. Optional setup is an explicitly authorized dependency preparation command, e.g. bun install --frozen-lockfile --ignore-scripts; it runs before the check and must preserve source. workdir is relative to the snapshot. Dependencies, external services and transient writes are not sealed. Cite the resulting self_heal_verify call when completing the goal. Ordinary bash or browser evidence has unknown delivery source identity. Inspect uncertain outcomes with action=inspect and the original messageID/callID in this session; inspection never repeats setup or the check.",
        parameters: Input,
        execute: (input: typeof Input.Type, ctx) =>
          Effect.gen(function* () {
            if (!ctx.callID) throw new Error("Snapshot verification requires a durable tool invocation identity")
            if (input.action === "inspect") {
              const retained = yield* service.status(ctx.sessionID, input.messageID, input.callID)
              return {
                title: "Repair verification outcome",
                metadata: {},
                output: retained
                  ? JSON.stringify(retained, null, 2)
                  : "No retained verification invocation matches this session, message and call ID.",
              }
            }
            const outcome = yield* goals.repair(ctx.sessionID).pipe(Effect.orDie)
            const goal = yield* goals.get(ctx.sessionID)
            if (!goal || goal.status !== "active")
              throw new Error("Snapshot verification requires the active repair goal")
            const owner = identity(goal)
            const current = () =>
              Effect.gen(function* () {
                const owned = yield* goals.repair(ctx.sessionID).pipe(Effect.orDie)
                const state = yield* goals.get(ctx.sessionID)
                if (
                  owned.id !== outcome.id ||
                  !state ||
                  state.status !== "active" ||
                  state.intent !== goal.intent ||
                  JSON.stringify(identity(state)) !== JSON.stringify(owner)
                )
                  throw new Error("The repair owner or goal changed during verification")
              })
            const command = yield* Tool.init(shell)
            const result = yield* service.run({
              outcome,
              goal: owner,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              callID: ctx.callID,
              input,
              current,
              execute: (text, directory) =>
                command.execute(
                  {
                    command: text,
                    workdir: directory,
                    timeout: input.timeout,
                    description: "Verify captured repair source",
                  },
                  ctx,
                ),
            })
            return { title: "Repair source verification", ...result }
          }),
      }
    }),
  )
}
