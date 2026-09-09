import { expect } from "bun:test"
import path from "node:path"
import * as fs from "node:fs/promises"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaSelfHeal } from "@/kilocode/self-heal"
import { SessionID } from "@/session/schema"
import { plan, verify } from "@/kilocode/self-heal/worktree"
import { checkout, git, lfs } from "./fixtures/self-heal-worktree"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { capture, materialize, unchanged } from "@/kilocode/self-heal/snapshot"
const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
function instance<A, E>(
  directory: string,
  run: (backlog: ReturnType<typeof RayaSelfHeal.make>) => Effect.Effect<A, E>,
  root = path.join(path.dirname(directory), "managed"),
) {
  return Effect.gen(function* () {
    return yield* run(RayaSelfHeal.make(yield* Storage.Service, root))
  }).pipe(Effect.provide(Storage.layerFromDir(directory)))
}

it.live(
  "owned preparation and source capture support long Windows paths without changing repository Git configuration",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const directory = path.join(root, "storage")
      const source = yield* Effect.promise(() => checkout(directory))
      const name = path.join(
        "nested-" + "a".repeat(40),
        "nested-" + "b".repeat(40),
        "source-" + "c".repeat(40) + ".txt",
      )
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(path.join(source.root, name)), { recursive: true })
        await fs.writeFile(path.join(source.root, name), "long captured source")
        await git(source.root, ["-c", "core.longpaths=true", "add", "."])
        await git(source.root, [
          "-c",
          "core.longpaths=true",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "long source fixture",
        ])
        source.commit = await git(source.root, ["rev-parse", "HEAD"])
        await git(source.root, ["config", "core.longpaths", "false"])
      })
      const managed = path.join(root, "managed-" + "d".repeat(40))
      const item = yield* instance(
        directory,
        (backlog) => backlog.create({ description: "Prepare long source paths" }),
        managed,
      )
      const granted = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source }), managed))!
      const prepared = yield* instance(
        directory,
        (backlog) => backlog.prepare(item.id, { token: granted.token!, revision: 0 }),
        managed,
      )
      expect(prepared.phase).toBe("worktree_ready")
      expect(path.join(prepared.worktree!.directory, name).length).toBeGreaterThan(260)
      yield* Effect.promise(async () => {
        await verify(source, prepared.worktree!)
        expect(await fs.readFile(path.join(prepared.worktree!.directory, name), "utf8")).toBe("long captured source")
        const store = path.join(root, "captured-" + "e".repeat(40))
        const snapshot = await capture(prepared.worktree!.directory, store, prepared.worktree)
        expect(snapshot.files.some((file) => file.path === name.replaceAll("\\", "/"))).toBe(true)
        const copy = await materialize(store, snapshot)
        await unchanged(copy, snapshot)
        expect(await fs.readFile(path.join(copy, name), "utf8")).toBe("long captured source")
        expect(await git(source.root, ["config", "--get", "core.longpaths"])).toBe("false")
      })
    }),
  30_000,
)

it.live(
  "independent owners create one exact-commit checkout without changing dirty source or running hooks/setup",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const source = yield* Effect.tryPromise(() => checkout(directory))
      yield* Effect.tryPromise(async () => {
        await fs.mkdir(path.join(source.root, ".kilo"))
        await fs.writeFile(path.join(source.root, ".kilo", "setup-script"), "#!/bin/sh\nprintf ran > .setup-ran\n", {
          mode: 0o755,
        })
        await git(source.root, ["add", "."])
        await git(source.root, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "setup fixture",
        ])
        source.commit = await git(source.root, ["rev-parse", "HEAD"])
        await fs.writeFile(
          path.join(source.root, ".git", "hooks", "post-checkout"),
          "#!/bin/sh\nprintf ran > .hook-ran\n",
          { mode: 0o755 },
        )
        await fs.writeFile(path.join(source.root, "tracked.txt"), "dirty user changes")
        await fs.writeFile(path.join(source.root, ".env"), "PRIVATE=fixture")
      })
      const item = yield* instance(directory, (backlog) =>
        backlog.create({ description: "Create one repair checkout" }),
      )
      const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
      const results = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          instance(directory, (backlog) =>
            backlog.prepare(item.id, { token: claim.token!, revision: 0 }).pipe(Effect.exit),
          ),
        ),
        { concurrency: 4 },
      )
      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      const outcome = (yield* instance(directory, (backlog) => backlog.outcome(item.id)))!
      expect(outcome.phase).toBe("worktree_ready")
      const worktree = outcome.worktree!
      expect(worktree.commit).toBe(source.commit)
      expect(worktree.branch).toBe(`raya/repair/${claim.outcome.id}`)
      expect(yield* Effect.tryPromise(() => fs.readFile(path.join(source.root, "tracked.txt"), "utf8"))).toBe(
        "dirty user changes",
      )
      expect(yield* Effect.tryPromise(() => fs.readFile(path.join(worktree.directory, "tracked.txt"), "utf8"))).toBe(
        "committed content\n",
      )
      expect(yield* Effect.tryPromise(() => fs.readdir(worktree.directory))).not.toContain(".env")
      expect(yield* Effect.tryPromise(() => fs.readdir(worktree.directory))).not.toContain(".hook-ran")
      expect(yield* Effect.tryPromise(() => fs.readdir(worktree.directory))).not.toContain(".setup-ran")
      expect(yield* Effect.tryPromise(() => git(worktree.directory, ["rev-parse", "HEAD"]))).toBe(source.commit)
      expect(yield* Effect.tryPromise(() => git(worktree.directory, ["symbolic-ref", "HEAD"]))).toBe(
        `refs/heads/${worktree.branch}`,
      )
    }),
  30_000,
)

it.live(
  "an existing partial checkout stays reserved and is never overwritten or retried",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const source = yield* Effect.tryPromise(() => checkout(directory))
      const item = yield* instance(directory, (backlog) =>
        backlog.create({ description: "Creation acknowledgement was lost" }),
      )
      const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
      const planned = yield* Effect.tryPromise(() =>
        plan(source, claim.outcome.id, path.join(path.dirname(directory), "managed")),
      )
      yield* Effect.tryPromise(async () => {
        await fs.mkdir(planned.root)
        await git(source.root, [
          "worktree",
          "add",
          "--no-checkout",
          "-b",
          planned.branch,
          planned.directory,
          source.commit,
        ])
        await fs.writeFile(path.join(planned.directory, "keep.txt"), "partial user evidence")
      })
      const outcome = yield* instance(directory, (backlog) =>
        backlog.prepare(item.id, { token: claim.token!, revision: 0 }),
      )
      expect(outcome.phase).toBe("worktree_unknown")
      expect(outcome.worktree).toEqual(planned)
      expect(yield* Effect.tryPromise(() => fs.readFile(path.join(planned.directory, "keep.txt"), "utf8"))).toBe(
        "partial user evidence",
      )
      expect(
        Exit.isFailure(
          yield* instance(directory, (backlog) =>
            backlog.prepare(item.id, { token: claim.token!, revision: 0 }).pipe(Effect.exit),
          ),
        ),
      ).toBe(true)
      expect((yield* instance(directory, (backlog) => backlog.outcome(item.id)))?.phase).toBe("worktree_unknown")
    }),
  30_000,
)

it.live(
  "linked-worktree source retains canonical common Git identity",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const original = yield* Effect.tryPromise(() => checkout(directory))
      const root = path.join(path.dirname(directory), "linked")
      yield* Effect.tryPromise(() =>
        git(original.root, ["worktree", "add", "-b", "fixture-linked", root, original.commit]),
      )
      const source = { root, commit: original.commit }
      const item = yield* instance(directory, (backlog) => backlog.create({ description: "Linked source repair" }))
      const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
      const outcome = yield* instance(directory, (backlog) =>
        backlog.prepare(item.id, { token: claim.token!, revision: 0 }),
      )
      expect(outcome.phase).toBe("worktree_ready")
      expect(outcome.worktree?.common).toBe(
        yield* Effect.tryPromise(() => fs.realpath(path.join(original.root, ".git"))),
      )
    }),
  30_000,
)

it.live(
  "active checkout filters fail closed without invoking their external program",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const source = yield* Effect.tryPromise(() => checkout(directory))
      yield* Effect.tryPromise(async () => {
        await fs.writeFile(path.join(source.root, ".gitattributes"), "tracked.txt filter=denied\n")
        await git(source.root, ["add", ".gitattributes"])
        await git(source.root, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "attributes",
        ])
        source.commit = await git(source.root, ["rev-parse", "HEAD"])
        await git(source.root, ["config", "filter.denied.smudge", "sh -c 'printf ran > .filter-ran; cat'"])
      })
      const item = yield* instance(directory, (backlog) =>
        backlog.create({ description: "Filtered checkout requires review" }),
      )
      const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
      const outcome = yield* instance(directory, (backlog) =>
        backlog.prepare(item.id, { token: claim.token!, revision: 0 }),
      )
      expect(outcome.phase).toBe("blocked")
      expect(outcome.reason).toContain("checkout filter")
      expect(outcome.worktree).toBeUndefined()
      expect(yield* Effect.tryPromise(() => fs.readdir(source.root))).not.toContain(".filter-ran")
      expect(yield* Effect.tryPromise(() => fs.readdir(path.dirname(directory)))).not.toContain("managed")
    }),
  30_000,
)

it.live(
  "checkout modification before dispatch blocks the dependent prompt and retains session identity",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const source = yield* Effect.tryPromise(() => checkout(directory))
      const item = yield* instance(directory, (backlog) =>
        backlog.create({ description: "Do not dispatch a changed checkout" }),
      )
      const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
      const ready = yield* instance(directory, (backlog) =>
        backlog.prepare(item.id, { token: claim.token!, revision: 0 }),
      )
      expect(ready.phase).toBe("worktree_ready")
      const phases = ["session_creating", "session_created", "goal_creating", "goal_created"] as const
      for (const [index, phase] of phases.entries())
        yield* instance(directory, (backlog) =>
          backlog.advance(item.id, {
            token: claim.token!,
            revision: index + 2,
            phase,
            ...(phase === "session_created" ? { sessionID: SessionID.make("ses_repair") } : {}),
          }),
        )
      yield* Effect.tryPromise(() =>
        fs.writeFile(path.join(ready.worktree!.directory, "tracked.txt"), "unexpected edit"),
      )
      const blocked = yield* instance(directory, (backlog) =>
        backlog.advance(item.id, { token: claim.token!, revision: 6, phase: "dispatching" }),
      )
      expect(blocked.phase).toBe("blocked")
      expect(blocked.sessionID).toBe(SessionID.make("ses_repair"))
      expect(blocked.reason).toContain("before dispatching")
      yield* Effect.tryPromise(async () => {
        await fs.writeFile(path.join(ready.worktree!.directory, "tracked.txt"), "committed content\n")
        await fs.writeFile(path.join(ready.worktree!.directory, "untracked.txt"), "unexpected content")
      })
      expect(Exit.isFailure(yield* Effect.tryPromise(() => verify(source, ready.worktree!)).pipe(Effect.exit))).toBe(
        true,
      )
    }),
  30_000,
)

for (const mode of ["cache", "source"] as const)
  it.live(
    `offline LFS ${mode} materialization verifies bytes without invoking filter helpers`,
    () =>
      Effect.gen(function* () {
        const directory = path.join(yield* tmpdirScoped(), "storage")
        const source = yield* Effect.tryPromise(() => checkout(directory))
        const bytes = yield* Effect.tryPromise(() => lfs(source, mode === "source" ? "corrupt" : "cache"))
        if (mode === "source") yield* Effect.tryPromise(() => fs.writeFile(path.join(source.root, "asset.bin"), bytes))
        const item = yield* instance(directory, (backlog) =>
          backlog.create({ description: `Materialize verified LFS from ${mode}` }),
        )
        const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
        const ready = yield* instance(directory, (backlog) =>
          backlog.prepare(item.id, { token: claim.token!, revision: 0 }),
        )
        expect(ready.phase).toBe("worktree_ready")
        const target = path.join(ready.worktree!.directory, "asset.bin")
        expect(yield* Effect.tryPromise(() => fs.readFile(target))).toEqual(bytes)
        expect(yield* Effect.tryPromise(() => fs.readdir(ready.worktree!.directory))).not.toContain(".filter-ran")
        expect(yield* Effect.tryPromise(() => fs.readdir(source.root))).not.toContain(".filter-ran")
        yield* Effect.tryPromise(() =>
          git(ready.worktree!.directory, ["update-index", "--assume-unchanged", "asset.bin"]),
        )
        const stat = yield* Effect.tryPromise(() => fs.stat(target))
        yield* Effect.tryPromise(() => fs.writeFile(target, Buffer.alloc(bytes.length, 2)))
        yield* Effect.tryPromise(() => fs.utimes(target, stat.atime, stat.mtime))
        expect(yield* Effect.tryPromise(() => git(ready.worktree!.directory, ["diff-files", "--name-only"]))).toBe("")
        const blocked = yield* instance(directory, (backlog) =>
          backlog.advance(item.id, { token: claim.token!, revision: 2, phase: "session_creating" }),
        )
        expect(blocked.phase).toBe("blocked")
      }),
    30_000,
  )

it.live(
  "missing or corrupt local LFS content blocks before worktree mutation without fetching",
  () =>
    Effect.gen(function* () {
      for (const mode of ["missing", "corrupt"] as const) {
        const directory = path.join(yield* tmpdirScoped(), "storage")
        const source = yield* Effect.tryPromise(() => checkout(directory))
        yield* Effect.tryPromise(() => lfs(source, mode))
        const item = yield* instance(directory, (backlog) => backlog.create({ description: `LFS object is ${mode}` }))
        const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
        const blocked = yield* instance(directory, (backlog) =>
          backlog.prepare(item.id, { token: claim.token!, revision: 0 }),
        )
        expect(blocked.phase).toBe("blocked")
        expect(blocked.reason).toContain("SHA-256/size")
        expect(yield* Effect.tryPromise(() => fs.readdir(path.dirname(directory)))).not.toContain("managed")
        expect(yield* Effect.tryPromise(() => fs.readdir(source.root))).not.toContain(".filter-ran")
      }
    }),
  30_000,
)

it.live(
  "managed paths cannot overlap source or follow a junction into unrelated files",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const source = yield* Effect.tryPromise(() => checkout(directory))
      const unrelated = path.join(path.dirname(directory), "unrelated")
      const linked = path.join(path.dirname(directory), "redirected")
      yield* Effect.tryPromise(async () => {
        await fs.mkdir(unrelated)
        await fs.writeFile(path.join(unrelated, "keep.txt"), "unrelated user work")
        await fs.symlink(unrelated, linked, process.platform === "win32" ? "junction" : "dir")
      })
      for (const root of [path.join(source.root, "repairs"), linked]) {
        const item = yield* instance(directory, (backlog) =>
          backlog.create({ description: `Refuse unsafe managed root ${path.basename(root)}` }),
        )
        const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
        const blocked = yield* instance(
          directory,
          (backlog) => backlog.prepare(item.id, { token: claim.token!, revision: 0 }),
          root,
        )
        expect(blocked.phase).toBe("blocked")
        expect(blocked.worktree).toBeUndefined()
      }
      expect(yield* Effect.tryPromise(() => fs.readdir(unrelated))).toEqual(["keep.txt"])
      expect(yield* Effect.tryPromise(() => fs.readdir(source.root))).not.toContain("repairs")
    }),
  30_000,
)

it.live(
  "source revision change after preparation blocks session creation",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const source = yield* Effect.tryPromise(() => checkout(directory))
      const item = yield* instance(directory, (backlog) =>
        backlog.create({ description: "Source changed after checkout" }),
      )
      const claim = (yield* instance(directory, (backlog) => backlog.admit(item.id, { source })))!
      const ready = yield* instance(directory, (backlog) =>
        backlog.prepare(item.id, { token: claim.token!, revision: 0 }),
      )
      expect(ready.phase).toBe("worktree_ready")
      yield* Effect.tryPromise(() =>
        git(source.root, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "new source revision",
        ]),
      )
      const blocked = yield* instance(directory, (backlog) =>
        backlog.advance(item.id, { token: claim.token!, revision: 2, phase: "session_creating" }),
      )
      expect(blocked.phase).toBe("blocked")
      expect(blocked.sessionID).toBeUndefined()
    }),
  30_000,
)
