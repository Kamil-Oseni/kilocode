import path from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import { KiloReadObject } from "./read-object"
import { KiloReference } from "@/kilocode/reference/contains"
import { Browser } from "@/kilocode/browser/service"
import { UploadStage } from "@/kilocode/browser/upload-stage"
import { FrameID, Selector, TabID } from "@/kilocode/browser/protocol"
import type { UploadFile } from "@/kilocode/browser/upload-schema"

const Params = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("start"),
    tab_id: TabID,
    frame_id: Schema.optional(FrameID),
    selector: Selector,
    destination: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20000)),
    paths: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32768))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
  }),
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literals(["inspect", "cancel"]), upload_id: Schema.String.check(Schema.isUUID()) }),
])

export const BrowserUploadTool = Tool.define<typeof Params, {}, Browser.Service | FSUtil.Service, "browser_upload">(
  "browser_upload",
  Effect.gen(function* () {
    const browser = yield* Browser.Service
    const fs = yield* FSUtil.Service
    return {
      description:
        "Attach authorized local files to one observed browser file input. Requires the observed destination URL and tab/frame. Files are staged by verified reference, never guessed host paths. Selection may trigger page-side submission: selected does not mean server-confirmed upload. Inspect the retained operation and page/network result; never automatically repeat selection after interruption. Cancel before selection stops staging; after selection reconcile the destination instead.",
      parameters: Params,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const pattern =
            params.action === "start" ? params.destination : params.action === "list" ? "list" : params.upload_id
          yield* ctx.ask({ permission: "browser_upload", patterns: [pattern], always: [pattern], metadata: {} })
          if (params.action !== "start") {
            const result = yield* browser.request(
              params.action === "list"
                ? { operation: "upload", action: "list", sessionID: ctx.sessionID }
                : { operation: "upload", action: params.action, uploadID: params.upload_id, sessionID: ctx.sessionID },
            )
            return { title: "Browser uploads", output: JSON.stringify(result, null, 2), metadata: {} }
          }
          const instance = yield* InstanceState.context
          const owner = { uploadID: randomUUID(), sessionID: ctx.sessionID, directory: instance.directory }
          const stage = new UploadStage()
          const files: Array<typeof UploadFile.Type> = []
          yield* Effect.forEach(
            params.paths,
            (input) =>
              Effect.gen(function* () {
                const requested = path.resolve(instance.directory, input)
                yield* ctx.ask({
                  permission: "read",
                  patterns: [path.relative(instance.worktree, requested)],
                  always: ["*"],
                  metadata: {},
                })
                const file = yield* KiloReadObject.file(requested)
                const explicit =
                  typeof ctx.extra?.["referenceRoot"] === "string"
                    ? yield* KiloReference.path(fs, ctx.extra["referenceRoot"], file.target).pipe(
                        Effect.option,
                        Effect.map((result) => result._tag === "Some" && result.value),
                      )
                    : false
                yield* assertExternalDirectoryEffect(ctx, file.target, { bypass: explicit, kind: "file" })
                if (file.target !== requested)
                  yield* ctx.ask({
                    permission: "read",
                    patterns: [path.relative(instance.worktree, file.target)],
                    always: ["*"],
                    metadata: {},
                  })
                const info = yield* KiloReadObject.use(file, (bound) =>
                  Effect.tryPromise({
                    try: (signal) => stage.stage(owner, bound, AbortSignal.any([ctx.abort, signal])),
                    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
                  }),
                )
                files.push(info)
              }),
            { discard: true },
          ).pipe(
            Effect.onError(() =>
              Effect.promise(() =>
                Promise.all(files.map((file) => stage.release(owner, file.id))).then(() => undefined),
              ),
            ),
          )
          const result = yield* browser.request({
            operation: "upload",
            action: "start",
            sessionID: ctx.sessionID,
            uploadID: owner.uploadID,
            tabID: params.tab_id,
            frameID: params.frame_id,
            selector: params.selector,
            destination: params.destination,
            files,
          })
          return { title: "Browser upload selection", output: JSON.stringify(result, null, 2), metadata: {} }
        }).pipe(Effect.orDie),
    }
  }),
)
