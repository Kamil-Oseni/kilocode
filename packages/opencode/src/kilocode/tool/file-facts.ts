import { Effect, Schema } from "effect"
import path from "node:path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import { KiloReference } from "@/kilocode/reference/contains"
import * as Reference from "@/kilocode/reference"
import { KiloReadObject } from "@/kilocode/tool/read-object"
import * as Tool from "@/tool/tool"

const Params = Schema.Struct({
  path: Schema.String.annotate({ description: "Absolute or relative path to a regular local file." }),
})

export const FileFactsTool = Tool.define(
  "file_facts",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return {
      description:
        "Inspect a local file's exact byte length and final newline without returning its contents. Use this for exact size, byte count, or trailing-newline claims; decoded read output and line counts cannot establish those facts. The newline result is LF, CRLF, or none. An empty file has none.",
      parameters: Params,
      execute: (params: typeof Params.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const inst = yield* InstanceState.context
          const requested = path.resolve(inst.directory, params.path)
          const info = yield* fs.stat(requested).pipe(
            Effect.catchIf(
              (err) => "reason" in err && err.reason._tag === "NotFound",
              () => Effect.succeed(undefined),
            ),
          )
          if (!info) {
            const parent = yield* fs.realPath(path.dirname(requested)).pipe(Effect.option)
            if (parent._tag === "None") return yield* Effect.fail(new Error(`File not found: ${requested}`))
            yield* assertExternalDirectoryEffect(ctx, parent.value, { bypass: false, kind: "directory" })
            yield* ctx.ask({
              permission: "read",
              patterns: [...new Set([requested, parent.value].map((item) => path.relative(inst.worktree, item)))],
              always: ["*"],
              metadata: {},
            })
            return yield* Effect.fail(new Error(`File not found: ${requested}`))
          }
          if (info.type === "Directory") {
            const target = yield* fs.realPath(requested)
            yield* assertExternalDirectoryEffect(ctx, target, { bypass: false, kind: "directory" })
            yield* ctx.ask({
              permission: "read",
              patterns: [...new Set([requested, target].map((item) => path.relative(inst.worktree, item)))],
              always: ["*"],
              metadata: {},
            })
            return yield* Effect.fail(new Error(`Not a regular file: ${requested}`))
          }

          const file = yield* KiloReadObject.file(requested)
          const cfg = yield* Effect.serviceOption(Config.Service)
          const refs =
            cfg._tag === "Some"
              ? Reference.resolveAll({
                  references: (yield* cfg.value.get()).reference ?? {},
                  directory: inst.directory,
                  worktree: inst.worktree,
                })
              : []
          const explicit =
            typeof ctx.extra?.["referenceRoot"] === "string" &&
            (yield* KiloReference.path(fs, ctx.extra["referenceRoot"], file.target))
          const referenced = explicit || (yield* KiloReference.contains({ fs, references: refs, target: file.target }))
          yield* assertExternalDirectoryEffect(ctx, file.target, { bypass: referenced, kind: "file" })
          yield* ctx.ask({
            permission: "read",
            patterns: [...new Set([requested, file.target].map((item) => path.relative(inst.worktree, item)))],
            always: ["*"],
            metadata: {},
          })

          return yield* KiloReadObject.use(file, (bound) =>
            Effect.tryPromise({
              try: async () => {
                const before = await bound.handle.stat({ bigint: true })
                if (
                  before.size !== bound.stat.size ||
                  before.mtimeNs !== bound.stat.mtimeNs ||
                  before.ctimeNs !== bound.stat.ctimeNs ||
                  before.size > BigInt(Number.MAX_SAFE_INTEGER)
                ) throw new KiloReadObject.ChangedError(`File changed while inspecting: ${requested}`)
                const size = Number(before.size)
                const tail = Buffer.alloc(Math.min(2, size))
                if (tail.length) {
                  const read = await bound.handle.read(tail, 0, tail.length, size - tail.length)
                  if (read.bytesRead !== tail.length) throw new KiloReadObject.ChangedError(`File changed while inspecting: ${requested}`)
                }
                const after = await bound.handle.stat({ bigint: true })
                if (
                  after.size !== before.size ||
                  after.mtimeNs !== before.mtimeNs ||
                  after.ctimeNs !== before.ctimeNs
                ) throw new KiloReadObject.ChangedError(`File changed while inspecting: ${requested}`)
                const newline =
                  tail.at(-1) !== 10 ? "none" : tail.length > 1 && tail.at(-2) === 13 ? "CRLF" : "LF"
                return {
                  title: path.relative(inst.worktree, bound.target),
                  output: JSON.stringify({ bytes: before.size.toString(), newline }),
                  metadata: { bytes: before.size.toString(), newline },
                }
              },
              catch: (err) => (err instanceof Error ? err : new Error(String(err))),
            }),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
