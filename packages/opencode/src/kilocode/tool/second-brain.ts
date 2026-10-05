import { Effect } from "effect"
import path from "node:path"
import { createHash } from "node:crypto"
import { KiloReadObject } from "./read-object"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Command } from "@/kilocode/second-brain/protocol"
import { SecondBrain, HostError } from "@/kilocode/second-brain/service"
import * as Tool from "@/tool/tool"

function abort(signal: AbortSignal) {
  return Effect.callback<never, HostError>((resume) => {
    const fail = () =>
      resume(
        Effect.fail(
          new HostError({
            code: "cancelled",
            detail:
              "The proposal request was cancelled; its outcome may be unknown. Do not automatically retry creation.",
          }),
        ),
      )
    if (signal.aborted) return fail()
    signal.addEventListener("abort", fail, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", fail))
  })
}

type Meta = {
  status: "pending" | "inspected" | "unconfirmed"
  action: Command["action"]
  code?: string
  count?: number
  applied?: boolean
}

export const SecondBrainTool = Tool.define<
  typeof Command,
  Meta,
  SecondBrain.Service | Session.Service | FSUtil.Service
>(
  "second_brain_proposal",
  Effect.gen(function* () {
    const brain = yield* SecondBrain.Service
    const sessions = yield* Session.Service
    const fs = yield* FSUtil.Service
    return {
      description:
        "List or read Second Brain proposals, or create a source-backed pending proposal for this trusted project. Supply actual project source paths and their SHA-256 hashes, bounded note changes and expected note revisions. Pending creation never applies changes to notes, grants file-edit authority or enables capture. The user must separately review and apply an exact proposal. Never automatically retry a creation after an unconfirmed outcome; list/read the original ID first. This tool cannot apply, confirm, cancel or edit proposals.",
      parameters: Command,
      execute: (command: Command, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const inst = yield* InstanceState.context
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          if (path.resolve(session.directory) !== path.resolve(inst.directory))
            return yield* Effect.die(
              new Tool.InvalidArgumentsError({
                tool: "second_brain_proposal",
                detail: "Proposal session directory changed",
              }),
            )
          const project = inst.directory
          const request =
            command.action === "propose"
              ? yield* Effect.gen(function* () {
                  const root = yield* fs.realPath(project).pipe(Effect.orDie)
                  const sources = yield* Effect.forEach(command.request.sources, (source) =>
                    Effect.gen(function* () {
                      const requested = path.resolve(project, source.path)
                      const target = yield* fs.realPath(requested).pipe(Effect.orDie)
                      const relative = path.relative(root, target)
                      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
                        return yield* Effect.die(
                          new Tool.InvalidArgumentsError({
                            tool: "second_brain_proposal",
                            detail: "Proposal sources must remain inside the current project",
                          }),
                        )
                      yield* ctx.ask({
                        permission: "read",
                        patterns: [...new Set([requested, target].map((file) => path.relative(inst.worktree, file)))],
                        always: [path.relative(inst.worktree, target)],
                        metadata: {},
                      })
                      const file = yield* KiloReadObject.file(target).pipe(Effect.orDie)
                      yield* KiloReadObject.use(file, (held) =>
                        Effect.tryPromise({
                          try: async () => {
                            const before = await held.handle.stat({ bigint: true })
                            if (before.size > 2000000n)
                              throw new Tool.InvalidArgumentsError({
                                tool: "second_brain_proposal",
                                detail: "Source exceeds the snapshot limit",
                              })
                            const raw = await held.read(2000001, ctx.abort)
                            const after = await held.handle.stat({ bigint: true })
                            if (
                              before.size !== after.size ||
                              before.mtimeNs !== after.mtimeNs ||
                              before.ctimeNs !== after.ctimeNs ||
                              BigInt(raw.length) !== before.size ||
                              createHash("sha256").update(raw).digest("hex") !== source.sha256
                            )
                              throw new Tool.InvalidArgumentsError({
                                tool: "second_brain_proposal",
                                detail: "Source revision changed; read the actual source hash again",
                              })
                            new TextDecoder("utf-8", { fatal: true }).decode(raw)
                          },
                          catch: (err) => err,
                        }),
                      ).pipe(Effect.orDie)
                      return { source: { ...source, path: target }, size: Number(file.stat.size) }
                    }),
                  )
                  if (sources.reduce((sum, row) => sum + row.size, 0) > 8000000)
                    return yield* Effect.die(
                      new Tool.InvalidArgumentsError({
                        tool: "second_brain_proposal",
                        detail: "Source snapshots exceed the aggregate limit",
                      }),
                    )
                  return { ...command, request: { ...command.request, sources: sources.map((row) => row.source) } }
                })
              : command
          yield* ctx.ask({
            permission: "second_brain_proposal",
            patterns: [project],
            always: [project],
            metadata: { action: command.action },
          })
          if (ctx.abort.aborted) return yield* abort(ctx.abort).pipe(Effect.orDie)
          return yield* brain.request({ sessionID: ctx.sessionID, project, command: request }).pipe(
            Effect.raceFirst(abort(ctx.abort)),
            Effect.matchEffect({
              onFailure: (err) =>
                command.action === "propose" || err.code === "cancelled"
                  ? Effect.fail(err)
                  : Effect.succeed({
                      title: "Second Brain proposal outcome unconfirmed",
                      output: `Proposal request was not confirmed (${err.code}). No apply was requested. Do not automatically retry creation; inspect the original pending proposal ID.`,
                      metadata: { status: "unconfirmed" as const, action: command.action, code: err.code },
                    }),
              onSuccess: (result) =>
                Effect.succeed({
                  title: result.action === "propose" ? "Pending Second Brain proposal" : "Second Brain proposals",
                  output: JSON.stringify(result),
                  metadata: {
                    status: result.action === "propose" ? ("pending" as const) : ("inspected" as const),
                    action: result.action,
                    count: result.proposals.length,
                    applied: false,
                  },
                }),
            }),
            Effect.orDie,
          )
        }),
    }
  }),
)
