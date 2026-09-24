import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Agent } from "@/agent/agent"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { RayaChief } from "@/kilocode/chief"
import type { RayaGoal } from "@/kilocode/goal"
import { ChiefEdits } from "@/kilocode/chief/edits"
import { ChiefIntegration } from "@/kilocode/chief/integration"
import { ChiefIntegrate, chiefIntegrateTool } from "@/kilocode/tool/chief-integrate"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
}, 30_000)

function git(dir: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function repos() {
  const root = await mkdtemp(path.join(tmpdir(), "raya-chief-parent-"))
  const child = await mkdtemp(path.join(tmpdir(), "raya-chief-child-"))
  dirs.push(root, child)
  git(root, "init", "-q")
  git(root, "config", "user.name", "Raya test")
  git(root, "config", "user.email", "raya@example.test")
  await Bun.write(path.join(root, "tracked.txt"), "base\n")
  git(root, "add", ".")
  git(root, "commit", "-qm", "base")
  const base = git(root, "rev-parse", "HEAD")
  git(root, "worktree", "add", "-q", "-b", `raya-test-${crypto.randomUUID()}`, child, base)
  return { root, child, base }
}

async function prepared(item: Awaited<ReturnType<typeof repos>>) {
  const preview = await ChiefEdits.preview({
    directory: item.child,
    baseCommit: item.base,
    maxFiles: 20,
    maxBytes: 24 * 1024,
  })
  const manifest = await ChiefEdits.manifest({ preview })
  const ready = await ChiefIntegration.prepare({ manifest, preview })
  await ChiefIntegration.preflight({ manifest, parent: item.root })
  ChiefIntegrate.check(item.root, ready)
  return { manifest, ready }
}

describe("Chief native integration boundary", () => {
  it.live(
    "settles an abort after durable reservation as unknown without dispatch or replay",
    () =>
      Effect.gen(function* () {
        const item = yield* Effect.promise(repos)
        yield* Effect.promise(() => Bun.write(path.join(item.child, "tracked.txt"), "changed\n"))
        const preview = yield* Effect.promise(() =>
          ChiefEdits.preview({ directory: item.child, baseCommit: item.base, maxFiles: 20, maxBytes: 24 * 1024 }),
        )
        const id = SessionID.make(`ses_chief_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const message = MessageID.make(`msg_${crypto.randomUUID()}`)
        const createdAt = Date.now()
        const state = { createdAt, status: "active", revisions: [] as { id: string }[] } as unknown as RayaGoal.State
        const storage = yield* Storage.Service
        yield* storage.replace(["raya", "goal", id], state)
        yield* Effect.addFinalizer(() =>
          Effect.all([storage.remove(["raya", "goal", id]), storage.remove(["raya", "chief", "branches", id])]).pipe(
            Effect.ignore,
          ),
        )
        const ledger = ChiefBranches.make(storage)
        yield* ledger.start({
          goalID: id,
          goalCreatedAt: createdAt,
          requestID: message,
          branches: [
            {
              id: "edit",
              name: "Edit",
              specialist: "builder",
              access: "edit",
              brief: { objective: "Change tracked file", constraints: [], expectedReturn: "Patch" },
            },
            {
              id: "read",
              name: "Read",
              specialist: "researcher",
              access: "read",
              brief: { objective: "Read repository", constraints: [], expectedReturn: "Findings" },
            },
          ],
        })
        yield* ledger.reserveWorktree({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: "edit",
          callID: "worktree-call",
          name: "edit",
          directory: item.child,
          branch: "child-edit",
          baseCommit: item.base,
        })
        yield* ledger.readyWorktree({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: "edit",
          callID: "worktree-call",
          directory: item.child,
          baseCommit: item.base,
        })
        yield* ledger.admit({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: "edit",
          callID: "worktree-call",
          sessionID: child,
          access: "edit",
        })
        yield* ledger.settle({
          goalID: id,
          goalCreatedAt: createdAt,
          branchID: "edit",
          callID: "worktree-call",
          sessionID: child,
          state: "completed",
          result: "Child completed",
        })
        const plan = (yield* ledger.read(id))!
        yield* storage.replace(["raya", "chief", "branches", id], {
          ...plan,
          branches: plan.branches.map((entry) =>
            entry.id === "edit"
              ? {
                  ...entry,
                  review: {
                    callID: "evidence",
                    messageID: "message",
                    partID: "part",
                    digest: preview.digest,
                    at: Date.now(),
                  },
                }
              : entry,
          ),
        })
        const abort = new AbortController()
        const proxy = {
          ...storage,
          replace: (key: string[], value: unknown) =>
            storage.replace(key, value).pipe(
              Effect.tap(() => {
                const rows = (value as { branches?: { worktree?: { integration?: { phase: string } } }[] }).branches
                if (
                  key[0] === "raya" &&
                  key[1] === "chief" &&
                  rows?.some((entry) => entry.worktree?.integration?.phase === "reserved")
                )
                  abort.abort()
                return Effect.void
              }),
            ),
        } as Storage.Interface
        const parent = { directory: item.root, metadata: { [RayaChief.phaseKey]: "task" } } as unknown as Session.Info
        const specialist = { parentID: id, directory: item.child } as unknown as Session.Info
        const sessions = {
          get: (sessionID: SessionID) => Effect.succeed(sessionID === id ? parent : specialist),
        } as Pick<Session.Interface, "get">
        const agents = { get: () => Effect.succeed({}) } as unknown as Agent.Interface
        const truncate = {
          output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
        } as Truncate.Interface
        const tool = yield* chiefIntegrateTool({
          storage: proxy,
          sessions,
          goals: { get: () => Effect.succeed(state) } as Pick<ReturnType<typeof RayaGoal.make>, "get">,
        }).pipe(Effect.provideService(Agent.Service, agents), Effect.provideService(Truncate.Service, truncate))
        const def = yield* tool.init()
        const ctx = {
          sessionID: id,
          messageID: message,
          agent: "auto",
          callID: "integrate-call",
          abort: abort.signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        }
        const result = yield* def.execute({ branch_id: "edit", digest: preview.digest! }, ctx)
        expect(result.metadata.phase).toBe("unknown")
        expect(
          (yield* ledger.read(id))?.branches.find((entry) => entry.id === "edit")?.worktree?.integration?.phase,
        ).toBe("unknown")
        expect(yield* Effect.promise(() => readFile(path.join(item.root, "tracked.txt"), "utf8"))).toBe("base\n")
        expect(
          Exit.isFailure(yield* def.execute({ branch_id: "edit", digest: preview.digest! }, ctx).pipe(Effect.exit)),
        ).toBe(true)
      }),
    30_000,
  )

  test("dispatches the prepared tracked patch and untracked bytes once with exact postconditions", async () => {
    const item = await repos()
    await Bun.write(path.join(item.child, "tracked.txt"), "changed\n")
    await Bun.write(path.join(item.child, "new.txt"), "copied\n")
    git(item.root, "config", "core.autocrlf", "true")
    const result = await prepared(item)
    await ChiefIntegrate.dispatch(item.root, result.ready)
    expect(await ChiefIntegrate.verify(item.root, result.manifest)).toBe(true)
    expect(await readFile(path.join(item.root, "tracked.txt"), "utf8")).toBe("changed\n")
    expect(await readFile(path.join(item.root, "new.txt"), "utf8")).toBe("copied\n")
    expect(git(item.root, "status", "--porcelain")).toContain("M tracked.txt")
    expect(ChiefIntegrate.dispatch(item.root, result.ready)).rejects.toThrow()
  }, 30_000)

  test("partial native dispatch is not verified or silently replayed", async () => {
    const item = await repos()
    await Bun.write(path.join(item.child, "tracked.txt"), "changed\n")
    await Bun.write(path.join(item.child, "new.txt"), "copied\n")
    const result = await prepared(item)
    await Bun.write(path.join(item.root, "new.txt"), "outside edit\n")
    expect(ChiefIntegrate.dispatch(item.root, result.ready)).rejects.toThrow()
    expect(await ChiefIntegrate.verify(item.root, result.manifest)).toBe(false)
    expect(await readFile(path.join(item.root, "tracked.txt"), "utf8")).toBe("changed\n")
    expect(await readFile(path.join(item.root, "new.txt"), "utf8")).toBe("outside edit\n")
  }, 30_000)

  test("refuses nested untracked paths before any native effect", async () => {
    const item = await repos()
    await Bun.write(path.join(item.child, "tracked.txt"), "changed\n")
    await mkdir(path.join(item.child, "nested"))
    await Bun.write(path.join(item.child, "nested", "new.txt"), "copied\n")
    const preview = await ChiefEdits.preview({
      directory: item.child,
      baseCommit: item.base,
      maxFiles: 20,
      maxBytes: 24 * 1024,
    })
    const manifest = await ChiefEdits.manifest({ preview })
    const ready = await ChiefIntegration.prepare({ manifest, preview })
    await ChiefIntegration.preflight({ manifest, parent: item.root })
    expect(() => ChiefIntegrate.check(item.root, ready)).toThrow("anchored native file creation")
    expect(ChiefIntegrate.dispatch(item.root, ready)).rejects.toThrow("anchored native file creation")
    expect(await readFile(path.join(item.root, "tracked.txt"), "utf8")).toBe("base\n")
  }, 30_000)
})
