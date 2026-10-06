import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Config } from "../../src/config/config"
import { Snapshot } from "../../src/snapshot"
import { provideInstance, testInstanceStoreLayer, tmpdir } from "../fixture/fixture"

async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, err).toBe(0)
  return out.trim()
}

async function track(dir: string) {
  const calls: string[][] = []
  const recorder = Layer.effect(
    AppProcess.Service,
    Effect.gen(function* () {
      const process = yield* AppProcess.Service
      return AppProcess.Service.of({
        ...process,
        run: (cmd, opts) =>
          Effect.suspend(() => {
            if (cmd._tag === "StandardCommand") calls.push([...cmd.args])
            return process.run(cmd, opts)
          }),
      })
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(AppProcess.node)))
  const hash = await Effect.runPromise(
    Snapshot.Service.use((snapshot) => snapshot.track()).pipe(
      provideInstance(dir),
      Effect.provide(
        Snapshot.layer.pipe(
          Layer.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Config.node, EffectFlock.node]))),
          Layer.provide(recorder),
        ),
      ),
      Effect.provide(testInstanceStoreLayer),
    ),
  )
  expect(hash).toBeTruthy()
  const command = calls.find((cmd) => cmd.includes("write-tree") && cmd.includes("--git-dir"))!
  const store = command[command.indexOf("--git-dir") + 1]
  const files = (await git(dir, "--git-dir", store, "ls-tree", "-r", "--name-only", hash!)).split("\n")
  return { calls, files }
}

test("nonrepo snapshots preserve protected exclusions without source check-ignore processes", async () => {
  await using tmp = await tmpdir()
  await writeFile(path.join(tmp.path, "work.txt"), "actual user work")
  await mkdir(path.join(tmp.path, ".raya-profile-locks"))
  await writeFile(path.join(tmp.path, ".raya-profile-locks", "owner.json"), "protected runtime metadata")
  const result = await track(tmp.path)
  expect(result.calls.some((cmd) => cmd.includes("write-tree"))).toBe(true)
  expect(result.calls.filter((cmd) => cmd.includes("check-ignore"))).toHaveLength(0)
  expect(result.files).toContain("work.txt")
  expect(result.files.some((file) => file.includes(".raya-profile-locks"))).toBe(false)
}, 30_000)

test("actual repository and linked gitfile snapshots retain source ignore rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await writeFile(path.join(tmp.path, ".gitignore"), "ignored.txt\n")
  await writeFile(path.join(tmp.path, "work.txt"), "tracked work")
  await git(tmp.path, "add", ".gitignore", "work.txt")
  await git(tmp.path, "commit", "-m", "fixture")
  const linked = path.join(tmp.path, "linked")
  await git(tmp.path, "worktree", "add", "-b", "linked", linked)
  for (const dir of [tmp.path, linked]) {
    await writeFile(path.join(dir, "ignored.txt"), "ignored bytes")
    await writeFile(path.join(dir, "visible.txt"), "visible bytes")
    const result = await track(dir)
    expect(result.calls.some((cmd) => cmd.includes("check-ignore"))).toBe(true)
    expect(result.files).toContain("visible.txt")
    expect(result.files).not.toContain("ignored.txt")
  }
}, 30_000)
