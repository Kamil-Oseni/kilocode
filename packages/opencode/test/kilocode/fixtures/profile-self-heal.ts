import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Effect, Layer, ManagedRuntime } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "../../../src/git"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { Storage } from "../../../src/storage/storage"
import { RayaSelfHeal } from "../../../src/kilocode/self-heal"
import { verification, identity } from "../../../src/kilocode/self-heal/verification"
import { artifacts } from "../../../src/kilocode/self-heal/artifact"
import { collectSelfHeal, planSelfHeal, selfHeal } from "../../../src/kilocode/migration/profile-self-heal"
import { select } from "../../../src/kilocode/migration/profile-selection"
import { withWorking } from "../../../src/kilocode/migration/profile-image"
import { payload, seal, unseal, tables } from "../../../src/kilocode/migration/profile-bundle"
import { restore } from "../../../src/kilocode/migration/profile-restore"
import { finish } from "../../../src/kilocode/cli/finish"
import { SessionID, MessageID } from "../../../src/session/schema"

const [root, mode] = process.argv.slice(2)
const password = "é".repeat(6)
if (mode === "setup") await import("./profile-import-bundle")
async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const streams = [new Response(child.stdout).text(), new Response(child.stderr).text()]
  const timer = setTimeout(() => child.kill(), 15_000)
  const [code, output, error] = await Promise.all([child.exited, ...streams])
  clearTimeout(timer)
  assert.equal(code, 0, error.slice(-1000))
  assert.throws(() => process.kill(child.pid, 0))
  return output.trim()
}
if (mode === "writers") {
  const workspace = path.join(root, "source-workspace")
  await command(["git", "init", "--quiet", "--template="], workspace)
  await writeFile(path.join(workspace, "proof.txt"), "Actual repair café 日本語 😀\n")
  await mkdir(path.join(workspace, "packages", "opencode"), { recursive: true })
  await mkdir(path.join(workspace, "packages", "kilo-vscode"), { recursive: true })
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "@kilocode/kilo" }))
  await writeFile(
    path.join(workspace, "packages", "opencode", "package.json"),
    JSON.stringify({ name: "@kilocode/cli" }),
  )
  await writeFile(
    path.join(workspace, "packages", "kilo-vscode", "package.json"),
    JSON.stringify({ name: "raya", publisher: "eden", version: "1.0.0" }),
  )
  await command(["git", "add", "."], workspace)
  await command(
    [
      "git",
      "-c",
      "user.name=Private Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "--quiet",
      "-m",
      "private source",
    ],
    workspace,
  )
  const commit = await command(["git", "rev-parse", "HEAD"], workspace)
  const runtime = ManagedRuntime.make(AppNodeBuilder.build(Storage.node))
  const checkouts: string[] = []
  const result = await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const backlog = RayaSelfHeal.make(storage)
      const created = yield* backlog.create({ description: "Chat runtime repaired café 日本語 😀" })
      const duplicate = yield* backlog.create({ description: created.description })
      assert.equal(duplicate.id, created.id)
      yield* backlog.update(created.id, {
        evidence: [
          {
            summary: "Actual preserved proof café",
            command: "bun --version",
            artifact: "inert evidence",
            at: Date.now(),
          },
        ],
      })
      const grant = yield* backlog.admit(created.id, { source: { root: workspace, commit } })
      assert(grant?.token && grant.owned)
      const ready = yield* backlog.prepare(created.id, { token: grant.token, revision: 0 })
      assert.equal(ready.phase, "worktree_ready")
      const first = yield* backlog.advance(created.id, {
        token: grant.token,
        revision: ready.revision,
        phase: "session_creating",
      })
      const linked = yield* backlog.advance(created.id, {
        token: grant.token,
        revision: first.revision,
        phase: "session_created",
        sessionID: SessionID.make("ses_import_fixture"),
      })
      const sessionID = SessionID.make("ses_import_fixture")
      const messageID = MessageID.make("msg_self_heal")
      const receipt = yield* verification(storage).run({
        outcome: linked,
        sessionID,
        messageID,
        callID: "call_actual_verification",
        goal: identity({ createdAt: 1, objective: "Verify captured source" }),
        input: { command: "bun --version" },
        current: () => Effect.void,
        execute: (_command, directory) =>
          Effect.promise(async () => {
            checkouts.push(directory)
            return { output: await command([process.execPath, "--version"], directory), metadata: { exit: 0 } }
          }),
      })
      assert.equal(receipt.metadata.exit, 0)
      const failed = yield* Effect.exit(
        artifacts(storage).run({
          outcome: linked,
          sessionID,
          messageID: MessageID.make("msg_artifact_unavailable"),
          callID: "call_actual_artifact",
          setup: "bun install",
          current: () => Effect.void,
          execute: (_command, directory) =>
            Effect.promise(async () => ({
              output: await command([process.execPath, "--version"], directory),
              metadata: { exit: 0 },
            })),
        }),
      )
      assert.equal(failed._tag, "Failure")
      return {
        id: created.id,
        token: grant.token,
        owner: createHash("sha256").update(grant.token).digest("hex"),
        data: Global.Path.data,
      }
    }),
  )
  await runtime.dispose()
  assert.equal(checkouts.length, 1)
  await writeFile(path.join(checkouts[0], "proof.txt"), "Changed retained verification café 日本語 😀\n")
  await writeFile(path.join(checkouts[0], "extra-verification.txt"), "Extra current verification bytes\n")
  await unlink(path.join(checkouts[0], "packages", "kilo-vscode", "package.json"))
  await mkdir(path.join(checkouts[0], "empty-current"))
  await writeFile(path.join(root, "writer-results.json"), JSON.stringify({ ...result, checkout: checkouts[0] }))
  console.log("PROFILE_SELF_HEAL_WRITERS_OK")
  await finish([])
}
if (mode === "capture") {
  const source = await Bun.file(path.join(root, "writer-results.json")).json()
  const original = await unseal(await readFile(path.join(root, "profile.raya"), "utf8"), password)
  const policy = { version: 1 as const, directories: [root], files: [] }
  const native = path.join(root, "private-native")
  await mkdir(native)
  const helper = path.join(native, "raya-process-host.exe")
  await copyFile(
    await realpath(path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe")),
    helper,
  )
  const digest = createHash("sha256")
    .update(await readFile(helper))
    .digest("hex")
  const selected = await select(
    {
      database: path.join(root, "producer", "source.db"),
      data: source.data,
      storage: path.join(source.data, "storage"),
    },
    policy,
  )
  const roots = [...selected.roots, { kind: "json" as const, path: path.join(root, "source-workspace") }]
  let value: Awaited<ReturnType<typeof collectSelfHeal>> | undefined
  let expired: Parameters<typeof collectSelfHeal>[0] | undefined
  await withImage(
    { roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "image") },
    (image) =>
      withWorking(image, { ...selected, roots }, async (working) => {
        expired = working
        const globals = [{ data: source.data, storage: path.join(source.data, "storage") }]
        const plan = await planSelfHeal(working, globals)
        assert(plan.requirements.some((item) => item.kind === "repair-worktree"))
        assert(plan.requirements.some((item) => item.kind === "verification-store"))
        value = await collectSelfHeal(working, globals)
        assert.equal(plan.fingerprint, (await planSelfHeal(working, globals)).fingerprint)
        assert(value.records.some((item) => item.path.startsWith("artifact/") && item.path.endsWith("terminal.json")))
        assert(value.files.some((item) => item.kind === "snapshot-blob"))
        assert(value.files.some((item) => item.kind === "snapshot-manifest"))
        const checkout = value.checkouts?.find((row) => row.original === source.checkout)
        assert(checkout)
        assert(checkout.changes.some((row) => row.path === "proof.txt" && row.status === "modified"))
        assert(checkout.changes.some((row) => row.path === "extra-verification.txt" && row.status === "extra"))
        assert(
          checkout.changes.some((row) => row.path === "packages/kilo-vscode/package.json" && row.status === "missing"),
        )
        assert(checkout.directories.includes("empty-current"))
        await assert.rejects(writeFile(path.join(source.checkout, "held-mutation.txt"), "must refuse"))
        assert.equal(
          selfHeal.safeParse({ ...value, checkouts: [{ ...checkout, sources: ["forged-record"] }] }).success,
          false,
        )
        assert.equal(selfHeal.safeParse({ ...value, checkouts: [{ ...checkout, changes: [] }] }).success, false)
        assert.equal(
          selfHeal.safeParse({
            ...value,
            checkouts: [
              {
                ...checkout,
                files: checkout.files.map((file, index) =>
                  index ? file : { ...file, data: Buffer.from("forged").toString("base64") },
                ),
              },
            ],
          }).success,
          false,
        )
        assert(!JSON.stringify(value).includes(source.token))
        assert(!JSON.stringify(value).includes(source.owner))
        assert(value.records.some((item) => item.excluded.includes("repair-owner")))
        const item = value.records.find((item) => item.path.startsWith("item/"))!
        assert.equal(
          selfHeal.safeParse({ ...value, records: [{ ...item, path: "item/wrong-identity.json" }] }).success,
          false,
        )
        const text = JSON.stringify({ ...JSON.parse(item.text), unexpected: "must refuse" })
        assert.equal(
          selfHeal.safeParse({
            ...value,
            records: [{ ...item, text, digest: createHash("sha256").update(text).digest("hex") }],
          }).success,
          false,
        )
      }),
  )
  assert(value && expired)
  await assert.rejects(collectSelfHeal(expired, []), /expired/)
  const secret = path.join(source.checkout, ".env")
  await writeFile(secret, "PRIVATE_FIXTURE_ONLY=do-not-archive")
  await withImage(
    { roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "private-checkout-image") },
    (image) =>
      withWorking(image, { ...selected, roots }, async (working) => {
        await assert.rejects(
          collectSelfHeal(working, [{ data: source.data, storage: path.join(source.data, "storage") }]),
          /unsupported private or control material/,
        )
      }),
  )
  await rename(secret, path.join(root, "retained-private-checkout-refusal.txt"))
  const unknown = path.join(source.data, "storage", "raya", "self-heal", "unknown.json")
  await writeFile(unknown, JSON.stringify({ future: "must refuse without dropping" }))
  await withImage(
    { roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "unknown-image") },
    (image) =>
      withWorking(image, { ...selected, roots }, async (working) => {
        await assert.rejects(
          collectSelfHeal(working, [{ data: source.data, storage: path.join(source.data, "storage") }]),
          /Unknown self-heal history entry/,
        )
      }),
  )
  await rename(unknown, path.join(root, "retained-unknown-history.json"))
  const workspace = path.join(root, "mapped-workspace")
  await mkdir(workspace)
  const first = await restore(
    await seal({ ...original, selfHeal: value }, password),
    password,
    path.join(root, "destination"),
    { [original.workspaces[0]]: workspace },
  )
  const archive = JSON.parse(await readFile(path.join(first.path, "restore-self-heal.json"), "utf8"))
  assert.deepEqual(archive, value)
  assert.equal(
    await Bun.file(path.join(first.path, "storage", "raya", "self-heal", "item", source.id + ".json")).exists(),
    false,
  )
  for (const file of value.files)
    assert.deepEqual(
      await readFile(path.join(first.path, "restore-self-heal-files", file.digest)),
      Buffer.from(file.data, "base64"),
    )
  for (const row of value.checkouts ?? []) {
    const id = createHash("sha256")
      .update(row.original + "\0" + row.digest)
      .digest("hex")
    for (const file of row.files)
      assert.deepEqual(
        await readFile(path.join(first.path, "restore-self-heal-checkouts", id, "tree", ...file.path.split("/"))),
        Buffer.from(file.data, "base64"),
      )
  }
  const next = await select(
    { database: path.join(first.path, "raya.db"), data: first.path, storage: path.join(first.path, "storage") },
    policy,
  )
  let second: Awaited<ReturnType<typeof collectSelfHeal>> | undefined
  await withImage(
    { roots: next.roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "second-image") },
    (image) =>
      withWorking(image, next, async (working) => {
        second = await collectSelfHeal(working, [{ data: first.path, storage: path.join(first.path, "storage") }])
      }),
  )
  assert(second)
  assert.equal(second.records.length, 0)
  assert.deepEqual(second.history, [{ records: value.records, files: value.files, checkouts: value.checkouts }])
  const current = new Database(path.join(first.path, "raya.db"), { readonly: true })
  const sql = tables.map((table) => ({
    table,
    columns: current
      .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
      .all()
      .map((column) => column.name),
    rows: current.query(`SELECT * FROM "${table}"`).values(),
  }))
  current.close()
  const json = [
    { path: "raya/agent.json", value: await readFile(path.join(first.path, "storage", "raya", "agent.json"), "utf8") },
  ]
  const restored = payload.parse({ ...original, sql, json, selfHeal: second, workspaces: [workspace] })
  const again = await restore(await seal(restored, password), password, path.join(root, "destination-two"), {
    [workspace]: workspace,
  })
  const db = new Database(path.join(again.path, "raya.db"), { readonly: true })
  assert.deepEqual(db.query("SELECT count(*) AS n FROM session_input").get(), { n: 0 })
  assert.deepEqual(db.query("SELECT count(*) AS n FROM raya_routine_occurrence").get(), { n: 0 })
  db.close()
  assert.equal(
    JSON.parse(await readFile(path.join(again.path, "storage", "raya", "restore-hold.json"), "utf8")).state,
    "held",
  )
  assert.equal(JSON.parse(await readFile(path.join(again.path, "restore-self-heal.json"), "utf8")).history.length, 1)
  for (const row of value.checkouts ?? []) {
    const id = createHash("sha256")
      .update(row.original + "\0" + row.digest)
      .digest("hex")
    for (const file of row.files)
      assert.deepEqual(
        await readFile(path.join(again.path, "restore-self-heal-checkouts", id, "tree", ...file.path.split("/"))),
        Buffer.from(file.data, "base64"),
      )
  }
  const runtime = ManagedRuntime.make(
    Storage.layerFromDir(path.join(again.path, "storage")).pipe(
      Layer.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node]))),
    ),
  )
  await runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      assert.deepEqual(yield* RayaSelfHeal.make(storage).list(), [])
    }),
  )
  await runtime.dispose()
  const agents = JSON.parse(await readFile(path.join(again.path, "storage", "raya", "agent.json"), "utf8"))
  assert.deepEqual(
    agents.map((agent: { enabled: boolean }) => agent.enabled),
    agents.map(() => false),
  )
  console.log("PROFILE_SELF_HEAL_TWO_HOPS_OK")
  await finish([])
}
