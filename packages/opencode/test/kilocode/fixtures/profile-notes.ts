import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { mkdir, readFile, realpath, writeFile, rm, copyFile } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Global } from "@opencode-ai/core/global"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { PlanArtifact } from "../../../src/kilocode/plan-artifact"
import { RayaRevertNote } from "../../../src/kilocode/session/revert-note"
import { Session } from "../../../src/session/session"
import { collectNotes, notes } from "../../../src/kilocode/migration/profile-notes"
import { select } from "../../../src/kilocode/migration/profile-selection"
import { withWorking } from "../../../src/kilocode/migration/profile-image"
import { restore } from "../../../src/kilocode/migration/profile-restore"
import { seal, unseal, payload } from "../../../src/kilocode/migration/profile-bundle"
import { inactive } from "../../../src/kilocode/migration/profile-safety"
import { remap } from "../../../src/kilocode/migration/profile-workspaces"
import { finish } from "../../../src/kilocode/cli/finish"
import { disposeTestRuntime, provideTestInstance } from "../../fixture/fixture"

const [root, mode] = process.argv.slice(2)
const id = "ses_import_fixture"
const workspace = path.join(root, "source-workspace")
if (mode === "setup") await import("./profile-import-bundle")
if (mode === "source") {
  const data = Global.Path.data
  await mkdir(path.join(data, "storage"), { recursive: true })
  using db = new Database(path.join(root, "producer", "source.db"), { readonly: true })
  const info = db.query<{ slug: string; time_created: number }, []>("SELECT slug,time_created FROM session").get()!
  await provideTestInstance({
    directory: workspace,
    fn: async (ctx) => {
      const file = Session.plan({ slug: info.slug, time: { created: info.time_created } }, ctx)
      assert.equal(path.dirname(file), path.join(data, "plans"))
      await mkdir(path.dirname(file), { recursive: true })
      const text = "# Café 日本語 😀\n\nPreserve exact plan and no startup execution.\n- [ ] Read actual bytes\n"
      await writeFile(file, text, { flag: "wx" })
      await Effect.runPromise(
        PlanArtifact.save(file, PlanArtifact.parse(text), createHash("sha256").update(text).digest("hex")).pipe(
          Effect.provide(LayerNode.compile(FSUtil.node)),
        ),
      )
      await writeFile(path.join(root, "expected-plan.txt"), text)
    },
  })
  await disposeTestRuntime()
  await mkdir(path.join(workspace, ".kilo", "plans"), { recursive: true })
  await writeFile(path.join(workspace, ".kilo", "plans", "review.md"), "Keep workspace plan inert café.")
  await RayaRevertNote.record(id, [path.join(workspace, "actual.txt"), "relative.txt"])
  await writeFile(path.join(root, "source.json"), JSON.stringify({ data, workspace }))
  console.log("PROFILE_NOTES_OK")
  await finish([])
}
if (mode === "read") {
  const source = await Bun.file(path.join(root, "source.json")).json()
  const baseline = await unseal(await readFile(path.join(root, "profile.raya"), "utf8"), "é".repeat(6))
  const legacy = new Database(path.join(root, "producer", "source.db"))
  legacy.run(
    "INSERT INTO session(id,project_id,slug,directory,path,title,version,time_created,time_updated) VALUES ('ses_notes_empty','global','legacy','','','Legacy empty directory','1',1,1)",
  )
  const original = payload.parse({
    ...baseline,
    sql: baseline.sql.map((table) =>
      table.table === "session" ? { ...table, rows: legacy.query("SELECT * FROM session").values() } : table,
    ),
  })
  legacy.close()
  const policy = { version: 1 as const, directories: [root], files: [] }
  const selected = await select(
    {
      database: path.join(root, "producer", "source.db"),
      storage: path.join(source.data, "storage"),
      data: source.data,
    },
    policy,
  )
  const roots = [...selected.roots, { kind: "json" as const, path: workspace }]
  const sourcehelper = await realpath(
    path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe"),
  )
  await mkdir(path.join(root, "private-native"))
  const helper = path.join(root, "private-native", "raya-process-host.exe")
  await copyFile(sourcehelper, helper)
  const digest = createHash("sha256")
    .update(await readFile(helper))
    .digest("hex")
  let saved: ReturnType<typeof notes.parse> | undefined
  let expired: Parameters<typeof collectNotes>[0] | undefined
  await withImage(
    { roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "image-registry") },
    (image) =>
      withWorking(image, { ...selected, roots }, async (token) => {
        expired = token
        const empty = await collectNotes(token, { data: [], workspaces: [], sql: original.sql })
        assert.deepEqual(empty, { version: 1, plans: [], reverts: [], history: [] })
        saved = await collectNotes(token, { data: [source.data], workspaces: [workspace], sql: original.sql })
        assert.equal(saved.plans.length, 2)
        assert.equal(saved.reverts.length, 1)
        await assert.rejects(writeFile(path.join(source.data, "plans", "foreign.md"), "forbidden"))
      }),
  )
  assert(saved && expired)
  await assert.rejects(collectNotes(expired, { data: [], workspaces: [], sql: original.sql }), /expired/)
  const destination = path.join(root, "mapped-workspace")
  await mkdir(destination)
  const restored = await restore(
    await seal({ ...original, notes: saved }, "é".repeat(6)),
    "é".repeat(6),
    path.join(root, "destination"),
    { [workspace]: destination },
  )
  await writeFile(path.join(root, "restored.json"), JSON.stringify(restored))
  const data = saved.plans.find((plan) => plan.scope === "data")!
  assert.equal(
    await readFile(path.join(restored.path, "plans", data.name), "utf8"),
    await readFile(path.join(root, "expected-plan.txt"), "utf8"),
  )
  assert.deepEqual(
    await PlanArtifact.load(path.join(restored.path, "plans", data.name)),
    JSON.parse(data.sidecar!.text),
  )
  assert.deepEqual(
    JSON.parse(await readFile(path.join(restored.path, "restore-notes.json"), "utf8")),
    JSON.parse(JSON.stringify(saved)),
  )
  assert.equal(await Bun.file(path.join(destination, ".kilo", "plans", "review.md")).exists(), false)
  assert.deepEqual(JSON.parse(await readFile(path.join(restored.path, "raya", "revert-note", id + ".json"), "utf8")), [
    path.join(destination, "actual.txt"),
    path.join(destination, "relative.txt"),
  ])
  const db = new Database(path.join(restored.path, "raya.db"), { readonly: true })
  assert.deepEqual(db.query("SELECT count(*) AS n FROM session_input").get(), { n: 0 })
  assert.deepEqual(db.query("SELECT count(*) AS n FROM raya_routine_occurrence").get(), { n: 0 })
  assert.deepEqual(db.query("SELECT directory FROM session WHERE id='ses_notes_empty'").get(), { directory: "" })
  db.close()
  assert.equal(
    JSON.parse(await readFile(path.join(restored.path, "storage/raya/restore-hold.json"), "utf8")).state,
    "held",
  )
  const mapping = new Map([[workspace, destination]])
  const current = payload.parse({
    ...inactive(original, Date.now(), mapping),
    workspaces: [destination],
    sql: remap(original.sql, mapping),
  })
  const next = await select(
    {
      database: path.join(restored.path, "raya.db"),
      storage: path.join(restored.path, "storage"),
      data: restored.path,
    },
    policy,
  )
  const nextroots = [...next.roots, { kind: "json" as const, path: destination }]
  let inherited: ReturnType<typeof notes.parse> | undefined
  await withImage(
    { roots: nextroots, policy, helper: { executable: helper, digest }, registry: path.join(root, "second-image") },
    (image) =>
      withWorking(image, { ...next, roots: nextroots }, async (token) => {
        inherited = await collectNotes(token, { data: [restored.path], workspaces: [destination], sql: current.sql })
      }),
  )
  assert(inherited)
  assert.equal(inherited.history.length, 1)
  assert.equal(inherited.history[0].plans.filter((plan) => plan.scope === "workspace").length, 1)
  const twice = path.join(root, "second-workspace")
  await mkdir(twice)
  const second = await restore(
    await seal({ ...current, notes: inherited }, "é".repeat(6)),
    "é".repeat(6),
    path.join(root, "second-destination"),
    { [destination]: twice },
  )
  assert.equal(await readFile(path.join(second.path, "plans", data.name), "utf8"), data.markdown.text)
  assert.deepEqual(JSON.parse(await readFile(path.join(second.path, "raya", "revert-note", id + ".json"), "utf8")), [
    path.join(twice, "actual.txt"),
    path.join(twice, "relative.txt"),
  ])
  assert.deepEqual(
    JSON.parse(await readFile(path.join(second.path, "restore-notes.json"), "utf8")).history,
    inherited.history,
  )
  await writeFile(path.join(source.data, "plans", "unknown.bin"), "unsupported")
  function refused(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.message === "Unknown plan entry" ||
        (err instanceof AggregateError && err.errors.some(refused)) ||
        refused(err.cause))
    )
  }
  await assert.rejects(
    withImage(
      { roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "negative-registry") },
      (image) =>
        withWorking(image, { ...selected, roots }, (token) =>
          collectNotes(token, { data: [source.data], workspaces: [workspace], sql: original.sql }),
        ),
    ),
    refused,
  )
  await rm(path.join(source.data, "plans", "unknown.bin"))
  console.log("PROFILE_NOTES_OK")
  await finish([])
}
if (mode === "reminder") {
  const restored = await Bun.file(path.join(root, "restored.json")).json()
  assert.equal(Global.Path.data, restored.path)
  RayaRevertNote.dropCache()
  const expected = [
    path.join(root, "mapped-workspace", "actual.txt"),
    path.join(root, "mapped-workspace", "relative.txt"),
  ]
  assert.deepEqual(await RayaRevertNote.take(id), expected)
  assert.equal(await RayaRevertNote.take(id), undefined)
  assert.equal(await Bun.file(path.join(restored.path, "raya/revert-note", id + ".json")).exists(), false)
  assert.equal(
    await Bun.file(
      path.join((await Bun.file(path.join(root, "source.json")).json()).data, "raya/revert-note", id + ".json"),
    ).exists(),
    true,
  )
  console.log("PROFILE_NOTES_OK")
  await finish([])
}
