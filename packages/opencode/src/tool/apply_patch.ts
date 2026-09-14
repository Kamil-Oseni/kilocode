import * as path from "path"
import { createHash } from "node:crypto" // kilocode_change
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { filterDiagnostics } from "./diagnostics" // kilocode_change
import { ConfigValidation } from "../kilocode/config-validation" // kilocode_change
import * as EncodedIO from "../kilocode/tool/encoded-io" // kilocode_change
import * as Artifact from "@/kilocode/goal/artifact" // kilocode_change
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { assertMutablePath } from "../kilocode/agent-manager/protection" // kilocode_change
import { RayaPath } from "@/kilocode/task/path-boundary" // kilocode_change
import { Storage } from "@/storage/storage" // kilocode_change
import { transact, type Item } from "@/kilocode/tool/apply-patch-transaction" // kilocode_change
import { records, seal, type Intent } from "@/kilocode/tool/apply-patch-receipt" // kilocode_change
import { Conflict, journals } from "@/kilocode/tool/mutation-journal" // kilocode_change

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const storage = yield* Storage.Service // kilocode_change - durable all-file transaction journal

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context
      // kilocode_change start - bind retries before reading mutable preimages
      const invocation = JSON.stringify([
        ctx.sessionID,
        ctx.messageID,
        ctx.callID || createHash("sha256").update(params.patchText).digest("hex"),
        instance.worktree,
      ])
      const request = createHash("sha256")
        .update(JSON.stringify([instance.worktree, params.patchText]))
        .digest("hex")
      const replay = records(storage)
      const finish = Effect.fn("ApplyPatchTool.finish")(function* (intent: Intent) {
        for (const change of intent.changes) {
          if (change.type === "delete") continue
          yield* lsp.touchFile(change.movePath ?? change.filePath, "document")
        }
        const diagnostics = yield* lsp.diagnostics()
        const summary = intent.changes.map((change) => {
          if (change.type === "add")
            return `A ${path.relative(intent.workspace, change.filePath).replaceAll("\\", "/")}`
          if (change.type === "delete")
            return `D ${path.relative(intent.workspace, change.filePath).replaceAll("\\", "/")}`
          return `M ${path.relative(intent.workspace, change.movePath ?? change.filePath).replaceAll("\\", "/")}`
        })
        let output = `Success. Updated the following files:\n${summary.join("\n")}`
        const changed = intent.changes
          .filter((change) => change.type !== "delete")
          .map((change) => FSUtil.normalizePath(change.movePath ?? change.filePath))
        for (const change of intent.changes) {
          if (change.type === "delete") continue
          const target = change.movePath ?? change.filePath
          const block = LSP.Diagnostic.report(target, diagnostics[FSUtil.normalizePath(target)] ?? [])
          if (block) {
            const rel = path.relative(intent.workspace, target).replaceAll("\\", "/")
            output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
          }
          output += yield* Effect.promise(() => ConfigValidation.check(target))
        }
        const result = {
          title: output,
          metadata: {
            diff: intent.diff,
            files: intent.files,
            diagnostics: filterDiagnostics(diagnostics, changed),
            rayaRevision: yield* Artifact.patch(afs, intent.changes),
          },
          output,
        }
        const saved = yield* replay.publish({
          version: 1,
          invocation: intent.invocation,
          request: intent.request,
          digest: intent.digest,
          result,
        })
        if (!saved.owned) return saved.receipt.result
        const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
        for (const change of intent.changes) {
          const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
          if (change.type === "add") updates.push({ file: change.filePath, event: "add" })
          if (change.type === "update") updates.push({ file: change.filePath, event: "change" })
          if (change.type === "delete") updates.push({ file: change.filePath, event: "unlink" })
          if (change.type === "move" && change.movePath) {
            updates.push({ file: change.filePath, event: "unlink" })
            updates.push({ file: change.movePath, event: "add" })
          }
          if (edited) yield* events.publish(FileSystem.Event.Edited, { file: edited })
        }
        for (const update of updates) yield* events.publish(Watcher.Event.Updated, update)
        return saved.receipt.result
      })
      const cached = yield* replay.getReceipt(invocation)
      const retained = yield* replay.getIntent(invocation)
      if (cached && !retained)
        return yield* new Conflict({ message: "Apply Patch response receipt has no retained intent." })
      if (retained) {
        if (retained.request !== request)
          return yield* new Conflict({ message: "This Apply Patch invocation is already bound to different content." })
        const outcome = yield* journals(storage).get(invocation)
        if (outcome && outcome.digest !== retained.digest)
          return yield* new Conflict({ message: "Apply Patch replay state is not bound to its transaction." })
        if (cached && outcome) {
          if (cached.request !== request || cached.digest !== retained.digest)
            return yield* new Conflict({ message: "This Apply Patch invocation has a conflicting response receipt." })
          if (outcome.phase !== "done" || outcome.decision !== "commit")
            return yield* new Conflict({ message: "Apply Patch response exists without a committed transaction." })
          return cached.result
        }
        if (outcome?.phase === "done" && outcome.decision === "commit") return yield* finish(retained)
        if (outcome)
          return yield* new Conflict({
            message: `Apply Patch invocation is retained at ${outcome.phase}/${outcome.decision ?? "undecided"}.`,
          })
      }
      // kilocode_change end

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
        encoding: string // kilocode_change - preserved per-file encoding
        // kilocode_change start - bind every reviewed existing pathname to its exact bytes
        proof?: { readonly dev: string; readonly ino: string }
        sha256?: string
        destinationProof?: { readonly dev: string; readonly ino: string }
        destinationSha256?: string
        destinationExists?: boolean
        destinationAnchor?: { readonly path: string; readonly identity: { readonly dev: string; readonly ino: string } }
        // kilocode_change end
      }> = []
      const targets = new Map<string, string>() // kilocode_change - retain each canonical target through approval
      const owners = new Map<string, string>() // kilocode_change - one mutation per canonical pathname

      // kilocode_change start - ambiguous patches can otherwise invalidate their own review proofs midway through commit
      const reserve = (target: string, label: string) =>
        Effect.gen(function* () {
          const owner = owners.get(target)
          if (!owner) {
            owners.set(target, label)
            return
          }
          return yield* Effect.fail(
            new Error(`apply_patch verification failed: ${label} resolves to the same target as ${owner}`),
          )
        })
      // kilocode_change end

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        assertMutablePath(filePath) // kilocode_change
        const target = yield* RayaPath.canonical(afs, filePath) // kilocode_change
        assertMutablePath(target) // kilocode_change - path aliases cannot bypass protected worktree boundaries
        yield* reserve(target, hunk.path) // kilocode_change
        targets.set(filePath, target) // kilocode_change
        yield* assertExternalDirectoryEffect(ctx, target) // kilocode_change - inspect the target behind a path alias

        switch (hunk.type) {
          case "add": {
            // kilocode_change start - adding over an existing file is still an overwrite and needs an exact review proof
            const stats = yield* afs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (stats?.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Cannot add over directory: ${filePath}`),
              )
            }
            const prior = stats ? yield* EncodedIO.read(afs, target) : undefined
            const proof = stats ? yield* EncodedIO.identity(target) : undefined
            const anchor = stats ? undefined : yield* EncodedIO.anchor(afs, path.dirname(target))
            // kilocode_change end
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
              encoding: "utf-8", // kilocode_change - new files default to utf-8
              proof, // kilocode_change
              sha256: prior?.sha256, // kilocode_change
              destinationExists: Boolean(stats), // kilocode_change
              destinationAnchor: anchor, // kilocode_change
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!stats || stats.type === "Directory") {
              return yield* Effect.fail(
                new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`),
              )
            }

            // kilocode_change start - encoding-aware read so non-UTF-8 files decode without
            // mojibake; the resulting diff, additions/deletions counts, and permission-prompt
            // metadata shown to the user must reflect the real file contents.
            const read = yield* EncodedIO.read(afs, target).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const source = Bom.split(read.text)
            const proof = yield* EncodedIO.identity(target) // kilocode_change - identity pairs with reviewed bytes
            // kilocode_change end
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom
            let encoding = read.encoding // kilocode_change - overwritten by deriveNewContentsFromChunks below

            // Apply the update chunks to get new content
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(
                filePath,
                hunk.chunks,
                Bom.join(source.text, source.bom),
              )
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
              return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
            // kilocode_change start - inspect the target behind a move destination alias
            if (movePath) {
              const target = yield* RayaPath.canonical(afs, movePath)
              assertMutablePath(target)
              yield* reserve(target, hunk.move_path!)
              targets.set(movePath, target)
              yield* assertExternalDirectoryEffect(ctx, target)
            }
            // kilocode_change end

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
              encoding, // kilocode_change
              proof, // kilocode_change
              sha256: read.sha256, // kilocode_change
            })

            // kilocode_change start - a move may overwrite a reviewed destination, so prove that pathname too
            if (movePath) {
              const destination = targets.get(movePath)!
              const stats = yield* afs.stat(destination).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (stats?.type === "Directory") {
                return yield* Effect.fail(
                  new Error(`apply_patch verification failed: Cannot move over directory: ${movePath}`),
                )
              }
              const change = fileChanges.at(-1)!
              change.destinationExists = Boolean(stats)
              if (stats) {
                const prior = yield* EncodedIO.read(afs, destination)
                change.destinationProof = yield* EncodedIO.identity(destination)
                change.destinationSha256 = prior.sha256
              } else {
                change.destinationAnchor = yield* EncodedIO.anchor(afs, path.dirname(destination))
              }
            }
            // kilocode_change end

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            // kilocode_change start - encoding-aware read so non-UTF-8 files decode without corruption
            const deleteRead = yield* EncodedIO.read(afs, target).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  new Error(
                    `apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            )
            const contentToDelete = deleteRead.text
            const source = Bom.split(contentToDelete)
            const proof = yield* EncodedIO.identity(target) // kilocode_change - deletion is bound to reviewed identity
            // kilocode_change end
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
              encoding: deleteRead.encoding, // kilocode_change
              proof, // kilocode_change
              sha256: deleteRead.sha256, // kilocode_change
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      // Check permissions if needed
      // kilocode_change start - require both visible aliases and canonical targets
      const relativePaths = RayaPath.patterns(
        instance.worktree,
        [...targets].flatMap(([file, target]) => [file, target]),
      )
      // kilocode_change end
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // kilocode_change start - format every proposed result away from reviewed paths before any target mutation
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = targets.get(change.movePath ?? change.filePath)!
        if (!(yield* format.available(target))) continue
        change.newContent = yield* EncodedIO.stage(
          afs,
          target,
          Bom.join(change.newContent, change.bom),
          change.encoding,
          format.file,
        )
      }

      // Validate the complete reviewed set after staging and before the first mutation. A stale later
      // file therefore cannot leave earlier files partially updated.
      for (const [file, target] of targets) yield* RayaPath.check(afs, file, target)
      for (const change of fileChanges) {
        const source = targets.get(change.filePath)!
        if (change.proof && change.sha256) yield* EncodedIO.validate(source, change.proof, change.sha256)
        const destination = change.movePath ? targets.get(change.movePath)! : source
        if (change.destinationProof && change.destinationSha256) {
          yield* EncodedIO.validate(destination, change.destinationProof, change.destinationSha256)
        }
        if (change.destinationExists === false && (yield* afs.exists(destination))) {
          return yield* Effect.fail(new Error("File target changed after approval."))
        }
      }
      // kilocode_change end

      // kilocode_change start - apply the complete reviewed set as one durable transaction
      const seed = createHash("sha256").update(invocation).digest("hex").slice(0, 32)
      const items: Item[] = []
      const append = (input: {
        kind: "create" | "replace" | "remove"
        target: string
        data?: Uint8Array
        review?: { readonly identity: { readonly dev: string; readonly ino: string }; readonly sha256: string }
        anchor?: { readonly path: string; readonly identity: { readonly dev: string; readonly ino: string } }
      }) => {
        const index = items.length
        const stem = path.join(path.dirname(input.target), `.raya-txn-${seed}-${index}`)
        const result = input.data
          ? { sha256: createHash("sha256").update(input.data).digest("hex") }
          : undefined
        items.push({
          entry: {
            kind: input.kind,
            target: input.target,
            ...(input.kind !== "remove" ? { stage: `${stem}.stage`, result } : {}),
            ...(input.kind !== "create" ? { hold: `${stem}.hold`, review: input.review } : {}),
            ...(input.kind === "create" ? { anchor: input.anchor } : {}),
          },
          ...(input.data ? { data: input.data } : {}),
        })
      }
      for (const change of fileChanges) {
        const source = targets.get(change.filePath)!
        const data =
          change.type === "delete"
            ? undefined
            : EncodedIO.encode(Bom.join(change.newContent, change.bom), change.encoding)
        const review = change.proof && change.sha256 ? { identity: change.proof, sha256: change.sha256 } : undefined
        if (change.type === "add") {
          append({
            kind: review ? "replace" : "create",
            target: source,
            data,
            review,
            anchor: change.destinationAnchor,
          })
          continue
        }
        if (change.type === "update") {
          append({ kind: "replace", target: source, data, review })
          continue
        }
        if (change.type === "delete") {
          append({ kind: "remove", target: source, review })
          continue
        }
        const destination = targets.get(change.movePath!)!
        const prior =
          change.destinationProof && change.destinationSha256
            ? { identity: change.destinationProof, sha256: change.destinationSha256 }
            : undefined
        append({
          kind: prior ? "replace" : "create",
          target: destination,
          data,
          review: prior,
          anchor: change.destinationAnchor,
        })
        append({ kind: "remove", target: source, review })
      }
      const proposed = {
        version: 1,
        invocation,
        request,
        workspace: instance.worktree,
        diff: totalDiff,
        files,
        changes: fileChanges.map((change) => ({
          filePath: change.filePath,
          type: change.type,
          movePath: change.movePath,
        })),
      } as const
      const intent = yield* replay.prepare({ ...proposed, digest: seal(proposed) })
      yield* transact(storage, { invocation, digest: intent.digest, workspace: instance.worktree, items })
      return yield* finish(intent)
      // kilocode_change end
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
