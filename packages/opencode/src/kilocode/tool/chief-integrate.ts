import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefEdits } from "@/kilocode/chief/edits"
import { ChiefIntegration } from "@/kilocode/chief/integration"
import { RayaChief } from "@/kilocode/chief"
import { mutation } from "@/kilocode/goal/mutation"
import { assertMutablePath } from "@/kilocode/agent-manager/protection"
import { RayaPath } from "@/kilocode/task/path-boundary"
import type { RayaGoal } from "@/kilocode/goal"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"

/** Native integration is never retried after a durable reservation. */
export namespace ChiefIntegrate {
  function git(dir: string, args: string[], input?: Buffer) {
    const result = spawnSync("git", args, {
      cwd: dir,
      input,
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    })
    if (result.error || result.status !== 0)
      throw new Error(`Git integration failed: ${result.error?.message ?? result.stderr.toString("utf8").trim()}`)
    return result.stdout.toString("utf8").trim()
  }

  export async function root(dir: string) {
    const actual = await realpath(dir)
    return realpath(git(actual, ["rev-parse", "--show-toplevel"]))
  }

  export function check(parent: string, prepared: ChiefIntegration.Prepared) {
    if (process.platform === "win32")
      throw new Error("Windows integration requires an anchored no-reparse native file driver")
    if (prepared.untracked.some((item) => item.path.includes("/")))
      throw new Error("Nested untracked integration requires anchored native file creation")
    if (!prepared.patch.length) return
    git(parent, ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "apply", "--check", "--binary", "-"], prepared.patch)
  }

  /** Called once, only after reserveIntegration has been durably written. */
  export async function dispatch(parent: string, prepared: ChiefIntegration.Prepared) {
    if (process.platform === "win32")
      throw new Error("Windows integration requires an anchored no-reparse native file driver")
    if (prepared.untracked.some((item) => item.path.includes("/")))
      throw new Error("Nested untracked integration requires anchored native file creation")
    if (prepared.patch.length)
      git(parent, ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "apply", "--binary", "-"], prepared.patch)
    for (const item of prepared.untracked) {
      const target = path.join(parent, item.path)
      const names = await readdir(parent)
      if (names.some((name) => name.toLowerCase() === item.path.toLowerCase()))
        throw new Error(`Parent path changed before untracked copy: ${item.path}`)
      await writeFile(target, item.bytes, { flag: "wx", mode: item.mode === "100755" ? 0o755 : 0o644 })
    }
  }

  /** A complete integration receipt requires exact final bytes or proven absence for every path. */
  export async function verify(parent: string, manifest: ChiefEdits.Manifest) {
    for (const item of manifest.files) {
      const parts = item.path.split("/")
      let current = parent
      for (const [index, part] of parts.entries()) {
        const names = await readdir(current)
        if (names.some((name) => name.toLowerCase() === part.toLowerCase() && name !== part)) return false
        current = path.join(current, part)
        const info = await lstat(current).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return undefined
          throw err
        })
        if (!info) {
          if (item.final || (index < parts.length - 1 && item.base)) return false
          break
        }
        if (info.isSymbolicLink()) return false
        if (index < parts.length - 1) {
          if (!info.isDirectory()) return false
          if (path.normalize(await realpath(current)).toLowerCase() !== path.normalize(current).toLowerCase())
            return false
          continue
        }
        if (!item.final || !info.isFile() || info.size !== item.final.size) return false
        if (process.platform !== "win32" && (info.mode & 0o111 ? "100755" : "100644") !== item.final.mode) return false
        const bytes = await readFile(current)
        const after = await lstat(current)
        if (
          !after.isFile() ||
          info.ino !== after.ino ||
          info.mtimeMs !== after.mtimeMs ||
          bytes.length !== item.final.size ||
          createHash("sha256").update(bytes).digest("hex") !== item.final.sha256
        )
          return false
      }
    }
    return true
  }
}

/** Unregistered until real installed-host recovery and sandbox behavior are accepted. */
export function chiefIntegrateTool(deps: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get">
  goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
}) {
  const parameters = Schema.Struct({ branch_id: Schema.String, digest: Schema.String })
  return Tool.define(
    "chief_integrate",
    Effect.succeed({
      description:
        "Integrate one exactly reviewed Auto Chief edit into its parent repository after one edit permission check. Unknown native outcomes are never retried automatically.",
      parameters,
      execute: (input: typeof parameters.Type, ctx) =>
        Effect.gen(function* () {
          if (ctx.agent !== "auto" || !ctx.callID)
            throw new Error("Only an identified Auto Chief call can integrate edits")
          if (ctx.abort.aborted) throw new Error("Auto Chief integration was cancelled")
          const parent = yield* deps.sessions.get(ctx.sessionID)
          if (RayaChief.phase(parent.metadata) !== "task" && RayaChief.phase(parent.metadata) !== "goal")
            throw new Error("Auto Chief integration is unavailable in this phase")
          const goal = yield* deps.goals.get(ctx.sessionID)
          const ledger = ChiefBranches.make(deps.storage)
          const plan = yield* ledger.read(ctx.sessionID)
          if (!plan || !ChiefBranches.matches(plan, goal)) throw new Error("Auto Chief plan changed")
          const branch = plan.branches.find((item) => item.id === input.branch_id)
          if (
            !branch ||
            branch.access !== "edit" ||
            branch.state !== "completed" ||
            !branch.sessionID ||
            branch.worktree?.phase !== "ready" ||
            branch.review?.digest !== input.digest ||
            branch.worktree.integration
          )
            throw new Error("Only an exact reviewed edit branch can be integrated")
          const worktree = branch.worktree
          const childID = branch.sessionID
          const child = yield* deps.sessions.get(childID)
          if (
            child.parentID !== ctx.sessionID ||
            path.normalize(child.directory) !== path.normalize(branch.worktree.directory)
          )
            throw new Error("Chief child lineage or worktree changed")
          const target = yield* Effect.tryPromise(() => ChiefIntegrate.root(parent.directory))
          if (path.normalize(target).toLowerCase() === path.normalize(branch.worktree.directory).toLowerCase())
            throw new Error("Edit worktree cannot integrate into itself")
          const snapshot = yield* Effect.tryPromise(() =>
            ChiefEdits.preview({
              directory: branch.worktree!.directory,
              baseCommit: branch.worktree!.baseCommit,
              maxFiles: 20,
              maxBytes: 24 * 1024,
            }),
          )
          if (snapshot.digest !== input.digest) throw new Error("Edit changed after review")
          const manifest = yield* Effect.tryPromise(() => ChiefEdits.manifest({ preview: snapshot }))
          if (!manifest.files.length) throw new Error("Chief edit has no files to integrate")
          const prepared = yield* Effect.tryPromise(() => ChiefIntegration.prepare({ manifest, preview: snapshot }))
          yield* Effect.tryPromise(() => ChiefIntegration.preflight({ manifest, parent: target }))
          yield* Effect.sync(() => ChiefIntegrate.check(target, prepared))
          for (const item of manifest.files) assertMutablePath(path.join(target, ...item.path.split("/")))
          if (ctx.abort.aborted) throw new Error("Auto Chief integration was cancelled")
          const paths = manifest.files.map((item) => path.join(target, ...item.path.split("/")))
          const patterns = [...new Set([...RayaPath.patterns(target, paths), ...paths])]
          yield* ctx.ask({
            permission: "edit",
            patterns,
            always: patterns,
            metadata: { paths: manifest.files.map((item) => item.path), digest: manifest.digest },
          })
          if (ctx.abort.aborted) throw new Error("Auto Chief integration was cancelled")
          const saved = yield* mutation(
            deps.storage,
            `chief-integrate:${target.toLowerCase()}`,
            Effect.gen(function* () {
              const current = yield* ledger.read(ctx.sessionID)
              const latest = current?.branches.find((item) => item.id === input.branch_id)
              const nextGoal = yield* deps.goals.get(ctx.sessionID)
              if (
                !current ||
                !ChiefBranches.matches(current, nextGoal) ||
                latest?.review?.digest !== input.digest ||
                latest.worktree?.integration ||
                latest.worktree?.phase !== "ready" ||
                latest.sessionID !== branch.sessionID ||
                latest.worktree.directory !== worktree.directory ||
                latest.worktree.baseCommit !== worktree.baseCommit ||
                latest.worktree.branch !== worktree.branch ||
                latest.worktree.callID !== worktree.callID
              )
                throw new Error("Chief edit changed while awaiting integration")
              const linked = yield* deps.sessions.get(childID)
              if (
                linked.parentID !== ctx.sessionID ||
                path.normalize(linked.directory) !== path.normalize(latest.worktree.directory)
              )
                throw new Error("Chief child lineage changed while awaiting integration")
              const same = yield* Effect.tryPromise(() => ChiefIntegrate.root(parent.directory))
              if (same.toLowerCase() !== target.toLowerCase()) throw new Error("Chief parent repository changed")
              const fresh = yield* Effect.tryPromise(() =>
                ChiefEdits.preview({
                  directory: latest.worktree!.directory,
                  baseCommit: latest.worktree!.baseCommit,
                  maxFiles: 20,
                  maxBytes: 24 * 1024,
                }),
              )
              if (fresh.digest !== snapshot.digest)
                throw new Error("Chief edit source changed while awaiting integration")
              const exact = yield* Effect.tryPromise(() => ChiefEdits.manifest({ preview: fresh }))
              if (exact.digest !== manifest.digest)
                throw new Error("Chief edit bytes changed while awaiting integration")
              const ready = yield* Effect.tryPromise(() =>
                ChiefIntegration.prepare({ manifest: exact, preview: fresh }),
              )
              yield* Effect.tryPromise(() => ChiefIntegration.preflight({ manifest: exact, parent: target }))
              yield* Effect.sync(() => ChiefIntegrate.check(target, ready))
              if (ctx.abort.aborted) throw new Error("Auto Chief integration was cancelled")
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* ledger.reserveIntegration({
                    goalID: ctx.sessionID,
                    goalCreatedAt: current.goalCreatedAt,
                    branchID: latest.id,
                    callID: ctx.callID!,
                    digest: input.digest,
                    target,
                  })
                  const result = yield* Effect.exit(
                    Effect.tryPromise(async () => {
                      if (ctx.abort.aborted) throw new Error("Auto Chief integration was cancelled before dispatch")
                      await ChiefIntegrate.dispatch(target, ready)
                      if (ctx.abort.aborted) throw new Error("Auto Chief integration was cancelled after dispatch")
                      if (!(await ChiefIntegrate.verify(target, exact)))
                        throw new Error("Parent postconditions did not match")
                    }),
                  )
                  const phase = Exit.isSuccess(result) ? ("integrated" as const) : ("unknown" as const)
                  yield* ledger.settleIntegration({
                    goalID: ctx.sessionID,
                    goalCreatedAt: current.goalCreatedAt,
                    branchID: latest.id,
                    callID: ctx.callID!,
                    digest: input.digest,
                    phase,
                  })
                  return phase
                }),
              )
            }),
          )
          return {
            title: `${branch.name} ${saved}`,
            output:
              saved === "integrated"
                ? `Integrated ${branch.name} into the parent checkout; exact final bytes were verified.`
                : `Integration outcome is unknown. Inspect the parent and child worktrees; do not replay this call.`,
            metadata: { branchID: branch.id, requestID: plan.requestID, phase: saved, digest: manifest.digest },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
