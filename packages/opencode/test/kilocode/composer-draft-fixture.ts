import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Result } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { DraftError } from "@/kilocode/session/composer-drafts"
import { composerRetention } from "@/kilocode/session/composer-retention"
import type {
  ComposerDraftRequest,
  ComposerDraftResult,
  DraftTarget,
} from "../../../kilo-vscode/src/shared/composer-drafts-messages"

/** Exercises the production SQL repository and genuine JSON cutover in a disposable profile. */
export async function draftStorage(opts: { workspace?: () => string; projectID?: () => string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-webview-drafts-"))
  const dir = path.join(root, "storage")
  const file = path.join(root, "composer.sqlite")
  const owner = (target: DraftTarget) => ({
    ...target,
    workspace: opts.workspace?.() ?? root,
    projectID: opts.projectID?.() ?? "fixture-project",
  })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(Storage.layerFromDir(dir), Database.layerFromPath(file)).pipe(
      Layer.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
    ),
  )
  const run = async <A, E>(body: (drafts: ReturnType<typeof composerRetention>) => Effect.Effect<A, E>) => {
    const start = performance.now()
    const exit = await runtime.runPromiseExit(
      Effect.gen(function* () {
        return yield* body(composerRetention(yield* Database.Service, yield* Storage.Service, dir, file))
      }),
    )
    const elapsedMs = Math.round(performance.now() - start)
    if (Exit.isSuccess(exit)) {
      console.log("COMPOSER_SQL_FIXTURE", { status: "ready", elapsedMs })
      return exit.value
    }
    const error =
      Result.getOrUndefined(Cause.findError(exit.cause)) ?? Result.getOrUndefined(Cause.findDefect(exit.cause))
    const code = error instanceof DraftError ? error.code : "unavailable"
    const kind =
      error instanceof DraftError ? "DraftError" : Cause.hasInterrupts(exit.cause) ? "Interrupted" : "Unknown"
    // Never serialize the actual Effect cause, request, SQL values, or private paths.
    console.error("COMPOSER_SQL_FIXTURE", { status: "failed", code, kind, elapsedMs })
    throw error ?? new Error("Draft fixture operation failed")
  }
  const handle = async (request: ComposerDraftRequest): Promise<ComposerDraftResult> => {
    const base = {
      owner: request.owner,
      type: "composerDraftResult" as const,
      requestID: request.requestID,
      epoch: request.epoch,
      generation: request.generation,
      operation: request.type,
    }
    try {
      if (request.type === "composerDraftList") {
        const entries = []
        let cursor: string | undefined
        do {
          const page = await run((drafts) =>
            drafts.page(
              {
                box: request.box,
                workspace: opts.workspace?.() ?? root,
                projectID: opts.projectID?.() ?? "fixture-project",
              },
              { cursor },
            ),
          )
          entries.push(...page.entries)
          cursor = page.cursor
        } while (cursor)
        return { ...base, entries }
      }
      if (request.type === "composerDraftLoad")
        return { ...base, entry: await run((drafts) => drafts.load(owner(request.identity))) }
      if (request.type === "composerDraftSave")
        return {
          ...base,
          entry: await run((drafts) =>
            drafts.save(owner(request.identity), request.expected, request.content, request.mutation),
          ),
        }
      if (request.type === "composerDraftClear")
        return {
          ...base,
          entry: await run((drafts) => drafts.clear(owner(request.identity), request.expected, request.mutation)),
        }
      const moved = await run((drafts) =>
        drafts.promote(owner(request.from), owner(request.to), request.source, request.target, request.mutation),
      )
      return { ...base, ...moved }
    } catch (error) {
      const code = error instanceof DraftError ? error.code : "unavailable"
      return { ...base, error: code }
    }
  }
  return {
    root,
    handle,
    async [Symbol.asyncDispose]() {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
