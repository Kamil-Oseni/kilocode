import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import z from "zod"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { composerDrafts, type DraftContent, type DraftIdentity } from "@/kilocode/session/composer-drafts"

const who: DraftIdentity = {
  key: "prompt:default:pending:new:123",
  box: "prompt:default",
  workspace: "C:\\projects\\violin",
  projectID: "project-1",
  pendingID: "new:123",
}
const rich: DraftContent = {
  text: "  Learn violin\n你好 🎻  ",
  comments: [
    { id: "review-1", file: "src/app.ts", side: "additions", line: 4, comment: "Keep this", selectedText: "x()" },
    {
      id: "pr-1",
      origin: "pr",
      author: "reviewer",
      body: "Check",
      outdated: false,
      replies: [{ author: "me", body: "Yes" }],
    },
  ],
  images: [{ id: "image-1", filename: "violin.png", mime: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" }],
  scroll: 43.5,
}
async function refused(body: Promise<unknown>, code?: string) {
  const err = await body.then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(err).toBeInstanceOf(Error)
  if (code) expect(err instanceof Error ? err.message : "").toContain(code)
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-drafts-"))
  const dir = path.join(root, "storage")
  const run = <A, E>(body: (store: Storage.Interface) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Storage.Service.use(body).pipe(
        Effect.provide(Storage.layerFromDir(dir)),
        Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
      ),
    )
  return {
    root,
    dir,
    run,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("rich drafts survive a fresh real Storage layer and committed acknowledgements identify the saved snapshot", async () => {
  await using tmp = await fixture()
  const saved = await tmp.run((store) => composerDrafts(store, tmp.dir).save(who, undefined, rich, "save-1"))
  expect(saved.mutation).toBe("save-1")
  expect(saved.token.revision).toBe(1)
  expect(saved.digest).toHaveLength(64)
  const loaded = await tmp.run((store) => composerDrafts(store, tmp.dir).load(who))
  expect(loaded).toEqual(saved)
  expect(loaded?.content).toEqual(rich)
  expect(loaded?.identity).toEqual(who)
})

test("delayed saves and stale send clears cannot overwrite newer typing or resurrect a cleared generation", async () => {
  await using tmp = await fixture()
  const first = await tmp.run((store) => composerDrafts(store, tmp.dir).save(who, undefined, rich, "first"))
  const next = await tmp.run((store) =>
    composerDrafts(store, tmp.dir).save(who, first.token, { ...rich, text: "new typing" }, "next"),
  )
  await refused(
    tmp.run((store) => composerDrafts(store, tmp.dir).clear(who, first.token, "old-send")),
    "conflict",
  )
  await refused(
    tmp.run((store) => composerDrafts(store, tmp.dir).save(who, first.token, rich, "late")),
    "conflict",
  )
  const cleared = await tmp.run((store) => composerDrafts(store, tmp.dir).clear(who, next.token, "sent"))
  expect(cleared.content).toBeNull()
  await refused(
    tmp.run((store) => composerDrafts(store, tmp.dir).save(who, undefined, rich, "old-create")),
    "conflict",
  )
  const renewed = await tmp.run((store) => composerDrafts(store, tmp.dir).save(who, cleared.token, rich, "new"))
  expect(renewed.token.generation).not.toBe(first.token.generation)
  expect(renewed.token.revision).toBe(cleared.token.revision + 1)
})

test("pending promotion atomically preserves all rich state and rejects an old pending save", async () => {
  await using tmp = await fixture()
  const saved = await tmp.run((store) => composerDrafts(store, tmp.dir).save(who, undefined, rich, "pending"))
  const target = { ...who, key: "prompt:default:session:session-2", pendingID: undefined, sessionID: "session-2" }
  const moved = await tmp.run((store) =>
    composerDrafts(store, tmp.dir).promote(who, target, saved.token, undefined, "promote"),
  )
  expect(moved.target.content).toEqual(rich)
  expect(moved.source.content).toBeNull()
  expect(await tmp.run((store) => composerDrafts(store, tmp.dir).load(target))).toEqual(moved.target)
  await refused(
    tmp.run((store) => composerDrafts(store, tmp.dir).save(who, saved.token, rich, "late")),
    "conflict",
  )
})

test("missing initialized or corrupt storage refuses without resetting data", async () => {
  await using tmp = await fixture()
  await tmp.run((store) => composerDrafts(store, tmp.dir).save(who, undefined, rich, "saved"))
  await tmp.run((store) => store.remove(["raya", "composer-drafts"]))
  await refused(
    tmp.run((store) => composerDrafts(store, tmp.dir).save(who, undefined, rich, "reset")),
    "missing",
  )
  const file = path.join(tmp.dir, "raya", "composer-drafts.json")
  await Bun.write(file, "{broken")
  await refused(tmp.run((store) => composerDrafts(store, tmp.dir).load(who)))
  expect(await Bun.file(file).text()).toBe("{broken")
})

test("oversized and unknown-field payloads fail before persistence", async () => {
  await using tmp = await fixture()
  await refused(
    tmp.run((store) =>
      composerDrafts(store, tmp.dir).save(who, undefined, { ...rich, text: "x".repeat(1_000_001) }, "too-big"),
    ),
    "invalid",
  )
  await refused(
    tmp.run((store) =>
      composerDrafts(store, tmp.dir).save(
        who,
        undefined,
        { ...rich, secret: "not a draft field" } as DraftContent,
        "bad-field",
      ),
    ),
    "invalid",
  )
  expect(await Bun.file(path.join(tmp.dir, "raya", "composer-drafts.json")).exists()).toBe(false)
})

test("independent backend processes serialize compare-and-swap and a fresh process cannot replace the winner", async () => {
  await using tmp = await fixture()
  const saved = await tmp.run((store) => composerDrafts(store, tmp.dir).save(who, undefined, rich, "seed"))
  const children: Bun.Subprocess[] = []
  const start = async (name: string) => {
    const request = path.join(tmp.root, `${name}.json`)
    const receipt = path.join(tmp.root, `${name}-receipt.json`)
    await Bun.write(
      request,
      JSON.stringify({
        dir: tmp.dir,
        receipt,
        who,
        content: { ...rich, text: name },
        token: saved.token,
        mutation: name,
      }),
    )
    const home = path.join(tmp.root, name)
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "composer-drafts-worker.ts"), request], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        KILO_TEST_HOME: home,
        HOME: home,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
      },
    })
    children.push(child)
    const out = new Response(child.stdout).text()
    const err = new Response(child.stderr).text()
    const result = await child.exited
    const output = await out
    const errors = await err
    if (result !== 0) throw new Error(`Draft fixture process exited ${result}: ${errors || output}`)
    expect(errors).not.toContain("error:")
    expect(result).toBe(0)
    return z
      .object({
        ok: z.boolean(),
        mutation: z.string().optional(),
        code: z.string().optional(),
        token: z.unknown().optional(),
      })
      .strict()
      .parse(await Bun.file(receipt).json())
  }
  try {
    const pair = await Promise.all([start("one"), start("two")])
    expect(pair.filter((item) => item.ok)).toHaveLength(1)
    expect(pair.find((item) => !item.ok)?.code).toBe("conflict")
    const winner = pair.find((item) => item.ok)
    const loaded = await tmp.run((store) => composerDrafts(store, tmp.dir).load(who))
    expect(loaded?.content?.text).toBe(winner?.mutation)
    expect(loaded?.token.revision).toBe(2)
    expect((await start("restarted")).code).toBe("conflict")
    expect(await tmp.run((store) => composerDrafts(store, tmp.dir).load(who))).toEqual(loaded)
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  }
}, 30_000)
