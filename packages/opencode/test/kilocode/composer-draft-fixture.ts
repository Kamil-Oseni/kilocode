import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { composerDrafts, DraftError } from "@/kilocode/session/composer-drafts"
import type { ComposerDraftRequest, ComposerDraftResult, DraftTarget } from "../../../kilo-vscode/src/shared/composer-drafts-messages"

/** Exercises the production JSON writer and CAS service in a disposable profile. */
export async function draftStorage(opts: { workspace?: () => string; projectID?: () => string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-webview-drafts-"))
  const dir = path.join(root, "storage")
  const owner = (target: DraftTarget) => ({ ...target, workspace: opts.workspace?.() ?? root, projectID: opts.projectID?.() ?? "fixture-project" })
  const run = <A, E>(body: (store: Storage.Interface) => Effect.Effect<A, E>) => Effect.runPromise(Storage.Service.use(body).pipe(
    Effect.provide(Storage.layerFromDir(dir)),
    Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  ))
  const handle = async (request: ComposerDraftRequest): Promise<ComposerDraftResult> => {
    const base = { owner: request.owner, type: "composerDraftResult" as const, requestID: request.requestID, epoch: request.epoch, generation: request.generation, operation: request.type }
    try {
      if (request.type === "composerDraftList") return { ...base, entries: await run((store) => composerDrafts(store, dir).snapshot()).then((data) => data.entries.filter((entry) => entry.identity.box === request.box && entry.identity.workspace === (opts.workspace?.() ?? root) && entry.identity.projectID === (opts.projectID?.() ?? "fixture-project"))) }
      if (request.type === "composerDraftLoad") return { ...base, entry: await run((store) => composerDrafts(store, dir).load(owner(request.identity))) }
      if (request.type === "composerDraftSave") return { ...base, entry: await run((store) => composerDrafts(store, dir).save(owner(request.identity), request.expected, request.content, request.mutation)) }
      if (request.type === "composerDraftClear") return { ...base, entry: await run((store) => composerDrafts(store, dir).clear(owner(request.identity), request.expected, request.mutation)) }
      const moved = await run((store) => composerDrafts(store, dir).promote(owner(request.from), owner(request.to), request.source, request.target, request.mutation))
      return { ...base, ...moved }
    } catch (error) {
      const code = error instanceof DraftError ? error.code : "unavailable"
      return { ...base, error: code }
    }
  }
  return { root, handle, async [Symbol.asyncDispose]() { await rm(root, { recursive: true, force: true }) } }
}
