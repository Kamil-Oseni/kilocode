import assert from "node:assert/strict"
import path from "node:path"
import { copyFile, mkdir, readFile, realpath, writeFile, utimes } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { Effect, ManagedRuntime } from "effect"
import { z } from "zod"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { Truncate } from "../../../src/tool/truncate"
import { collectOutputs } from "../../../src/kilocode/migration/profile-outputs"
import { select } from "../../../src/kilocode/migration/profile-selection"
import { withWorking, assertWorking } from "../../../src/kilocode/migration/profile-image"
import { restore } from "../../../src/kilocode/migration/profile-restore"
import { seal, unseal, payload, tables } from "../../../src/kilocode/migration/profile-bundle"
import { finish } from "../../../src/kilocode/cli/finish"
import { inactive } from "../../../src/kilocode/migration/profile-safety"

const [root, mode] = process.argv.slice(2)
const password = "é".repeat(6)
const session = "ses_import_fixture"
const data =
  mode === "capture"
    ? z.string().parse((await Bun.file(path.join(root, "writer-results.json")).json()).data)
    : Global.Path.data
const extra = path.join(root, "injected-data")
if (mode === "setup") await import("./profile-import-bundle")
if (mode === "cleanup") {
  const first = ManagedRuntime.make(AppNodeBuilder.build(Truncate.node))
  await first.runPromise(
    Effect.gen(function* () {
      const service = yield* Truncate.Service
      yield* service.cleanup()
    }),
  )
  await first.dispose()
  const second = ManagedRuntime.make(AppNodeBuilder.build(ToolOutputStore.nodeWithoutConfig))
  await second.runPromise(
    Effect.gen(function* () {
      const service = yield* ToolOutputStore.Service
      yield* service.cleanup()
    }),
  )
  await second.dispose()
  console.log("PROFILE_OUTPUT_CLEANUP_OK")
  await finish([])
}
if (mode === "writers") {
  const text = "Café 日本語 😀 full output\n".repeat(5000)
  const first = ManagedRuntime.make(AppNodeBuilder.build(Truncate.node))
  const result = await first.runPromise(
    Effect.gen(function* () {
      const service = yield* Truncate.Service
      return { v1: yield* service.output(text), orphan: yield* service.write("Inert orphan café.") }
    }),
  )
  await first.dispose()
  assert(result.v1.truncated)
  const second = ManagedRuntime.make(
    AppNodeBuilder.build(ToolOutputStore.nodeWithoutConfig, [[Global.node, Global.layerWith({ data: extra })]]),
  )
  const v2 = await second.runPromise(
    Effect.gen(function* () {
      const service = yield* ToolOutputStore.Service
      return yield* service.bound({
        sessionID: SessionSchema.ID.make(session),
        toolCallID: "call_outputs_v2",
        output: { content: [{ type: "text", text }], structured: { preserve: "unchanged" } },
      })
    }),
  )
  await second.dispose()
  assert.equal(v2.outputPaths.length, 1)
  const aged = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await utimes(result.v1.outputPath, aged, aged)
  await utimes(v2.outputPaths[0], aged, aged)
  const missing = path.join(data, "tool-output", "tool_expired")
  const v1 = {
    type: "tool",
    callID: "call_outputs_v1",
    tool: "read",
    state: {
      status: "completed",
      input: {},
      output: result.v1.content,
      title: "Read",
      metadata: { truncated: true, outputPath: result.v1.outputPath, prose: result.v1.outputPath },
      time: { start: 1, end: 2 },
    },
  }
  const lost = {
    ...v1,
    callID: "call_expired",
    state: { ...v1.state, metadata: { truncated: true, outputPath: missing } },
  }
  const assistant = {
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [
      {
        type: "tool",
        id: "call_outputs_v2",
        name: "read",
        state: {
          status: "completed",
          input: {},
          content: v2.output.content,
          structured: v2.output.structured,
          outputPaths: v2.outputPaths,
        },
        time: { created: 1, completed: 2 },
      },
    ],
    time: { created: 1, completed: 2 },
  }
  const event = {
    timestamp: 2,
    sessionID: session,
    assistantMessageID: "msg_outputs_v2",
    callID: "call_outputs_v2",
    content: v2.output.content,
    structured: v2.output.structured,
    outputPaths: v2.outputPaths,
    provider: { executed: false },
  }
  const db = new Database(path.join(root, "producer", "source.db"))
  db.run("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)", [
    "prt_outputs_v1",
    "msg_import_fixture",
    session,
    1,
    1,
    JSON.stringify(v1),
  ])
  db.run("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)", [
    "prt_outputs_lost",
    "msg_import_fixture",
    session,
    1,
    1,
    JSON.stringify(lost),
  ])
  db.run("INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES (?,?,?,?,?,?,?)", [
    "msg_outputs_v2",
    session,
    "assistant",
    1,
    1,
    1,
    JSON.stringify(assistant),
  ])
  db.run("INSERT INTO event_sequence(aggregate_id,seq) VALUES (?,?)", [session, 1])
  db.run("INSERT INTO event(id,aggregate_id,seq,type,data) VALUES (?,?,?,?,?)", [
    "evt_outputs_v2",
    session,
    1,
    "session.next.tool.success",
    JSON.stringify(event),
  ])
  db.close()
  await mkdir(path.join(data, "storage"), { recursive: true })
  await writeFile(path.join(root, "expected-output.txt"), text)
  await writeFile(
    path.join(root, "writer-results.json"),
    JSON.stringify({ data, extra, result, v2, v1, assistant, event }),
  )
  console.log("PROFILE_OUTPUT_WRITERS_OK")
  await finish([])
}
if (mode === "capture") {
  const original = await unseal(await readFile(path.join(root, "profile.raya"), "utf8"), password)
  function sql(file: string) {
    const db = new Database(file, { readonly: true })
    try {
      return payload.shape.sql.parse(
        tables.map((table) => ({
          table,
          columns: db
            .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
            .all()
            .map((column) => column.name),
          rows: db.query(`SELECT * FROM "${table}"`).values(),
        })),
      )
    } finally {
      db.close()
    }
  }
  const policy = { version: 1 as const, directories: [root], files: [] }
  await mkdir(path.join(root, "private-native"))
  const helper = path.join(root, "private-native", "raya-process-host.exe")
  await copyFile(
    await realpath(path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe")),
    helper,
  )
  const digest = createHash("sha256")
    .update(await readFile(helper))
    .digest("hex")
  const selected = await select(
    { database: path.join(root, "producer", "source.db"), storage: path.join(data, "storage"), data },
    policy,
  )
  const roots = [...selected.roots, { kind: "json" as const, path: extra }]
  let token: Parameters<typeof collectOutputs>[0] | undefined
  let saved: Awaited<ReturnType<typeof collectOutputs>> | undefined
  let source: ReturnType<typeof sql> | undefined
  await withImage(
    { roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "image") },
    (image) =>
      withWorking(image, { ...selected, roots }, async (working) => {
        token = working
        source = sql(assertWorking(working).profile.database)
        saved = await collectOutputs(working, { data: [data, extra], sql: source })
        assert.equal(saved.files.length, 3)
        assert.equal(saved.files.filter((item) => item.classification === "orphan").length, 1)
        assert.equal(saved.bindings.length, 4)
        assert.equal(saved.bindings.filter((item) => item.state === "missing").length, 1)
        await assert.rejects(writeFile(path.join(data, "tool-output", "tool_foreign"), "refused"))
      }),
  )
  assert(saved && source && token)
  await assert.rejects(collectOutputs(token, { data: [data], sql: source }), /expired/)
  const workspace = path.join(root, "mapped-workspace")
  await mkdir(workspace)
  const restored = await restore(
    await seal({ ...original, sql: source, outputs: saved }, password),
    password,
    path.join(root, "destination"),
    { [original.workspaces[0]]: workspace },
  )
  const db = new Database(path.join(restored.path, "raya.db"), { readonly: true })
  const part = JSON.parse(db.query<{ data: string }, []>("SELECT data FROM part WHERE id='prt_outputs_v1'").get()!.data)
  const message = JSON.parse(
    db.query<{ data: string }, []>("SELECT data FROM session_message WHERE id='msg_outputs_v2'").get()!.data,
  )
  const event = JSON.parse(
    db.query<{ data: string }, []>("SELECT data FROM event WHERE id='evt_outputs_v2'").get()!.data,
  )
  const expected = await Bun.file(path.join(root, "writer-results.json")).json()
  assert.equal(part.state.output, expected.v1.state.output)
  assert.equal(part.state.metadata.prose, expected.v1.state.metadata.prose)
  assert.deepEqual(message.content[0].state.content, expected.assistant.content[0].state.content)
  assert.deepEqual(message.content[0].state.structured, expected.assistant.content[0].state.structured)
  assert.equal(message.content[0].state.outputPaths[0], event.outputPaths[0])
  for (const file of [part.state.metadata.outputPath, event.outputPaths[0]])
    assert.equal(await readFile(file, "utf8"), await readFile(path.join(root, "expected-output.txt"), "utf8"))
  const cleanup = Bun.spawn([process.execPath, "run", "--conditions=browser", import.meta.filename, root, "cleanup"], {
    cwd: workspace,
    env: { ...process.env, ...restored.env, LOCALAPPDATA: path.join(root, "cleanup-local") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const streams = [new Response(cleanup.stdout).text(), new Response(cleanup.stderr).text()]
  const timer = setTimeout(() => cleanup.kill(), 20_000)
  const [code, out, err] = await Promise.all([cleanup.exited, ...streams])
  clearTimeout(timer)
  await writeFile(path.join(root, "cleanup-stdout.log"), out)
  await writeFile(path.join(root, "cleanup-stderr.log"), err)
  await writeFile(path.join(root, "cleanup-process.json"), JSON.stringify({ pid: cleanup.pid, code }))
  assert.equal(code, 0)
  assert.throws(() => process.kill(cleanup.pid, 0))
  for (const file of [part.state.metadata.outputPath, event.outputPaths[0]])
    assert.equal(await readFile(file, "utf8"), await readFile(path.join(root, "expected-output.txt"), "utf8"))
  const orphan = saved.files.find((file) => file.classification === "orphan")!
  assert.equal(await readFile(path.join(restored.path, "restore-tool-outputs", orphan.name), "utf8"), orphan.text)
  assert.equal(await Bun.file(path.join(restored.path, "tool-output", orphan.name)).exists(), false)
  assert.equal(await Bun.file(path.join(restored.path, "tool-output", "tool_expired")).exists(), false)
  assert.deepEqual(db.query("SELECT count(*) AS n FROM session_input").get(), { n: 0 })
  assert.deepEqual(db.query("SELECT count(*) AS n FROM raya_routine_occurrence").get(), { n: 0 })
  db.close()
  const next = await select(
    {
      database: path.join(restored.path, "raya.db"),
      storage: path.join(restored.path, "storage"),
      data: restored.path,
    },
    policy,
  )
  let twice: Awaited<ReturnType<typeof collectOutputs>> | undefined
  let current: ReturnType<typeof sql> | undefined
  await withImage(
    { roots: next.roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "second-image") },
    (image) =>
      withWorking(image, next, async (working) => {
        current = sql(assertWorking(working).profile.database)
        twice = await collectOutputs(working, { data: [restored.path], sql: current })
      }),
  )
  assert(twice && current)
  assert.equal(twice.history.length, 1)
  assert.deepEqual(twice.history[0], { files: saved.files, bindings: saved.bindings })
  const second = path.join(root, "second-workspace")
  await mkdir(second)
  const lineage = inactive(original, Date.now(), new Map([[original.workspaces[0], workspace]]))
  const again = await restore(
    await seal({ ...lineage, sql: current, workspaces: [workspace], outputs: twice }, password),
    password,
    path.join(root, "second-destination"),
    { [workspace]: second },
  )
  for (const file of twice.files)
    assert.equal(await readFile(path.join(again.path, "tool-output", file.name), "utf8"), file.text)
  assert.equal(
    JSON.parse(await readFile(path.join(again.path, "storage/raya/restore-hold.json"), "utf8")).state,
    "held",
  )
  await writeFile(path.join(data, "tool-output", "unknown.bin"), "unsupported")
  function refused(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.name === "ZodError" || (err instanceof AggregateError && err.errors.some(refused)) || refused(err.cause))
    )
  }
  await assert.rejects(
    withImage(
      { roots, policy, helper: { executable: helper, digest }, registry: path.join(root, "negative-image") },
      (image) =>
        withWorking(image, { ...selected, roots }, (working) =>
          collectOutputs(working, { data: [data, extra], sql: source! }),
        ),
    ),
    refused,
  )
  console.log("PROFILE_OUTPUT_CAPTURE_RESTORE_OK")
  await finish([])
}
