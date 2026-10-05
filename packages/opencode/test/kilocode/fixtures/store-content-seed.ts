import assert from "node:assert/strict"
import path from "node:path"
import { createHash } from "node:crypto"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { mkdir, writeFile } from "node:fs/promises"
import { Effect, ManagedRuntime } from "effect"
import { Database as Core } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Truncate } from "../../../src/tool/truncate"
import { PlanArtifact } from "../../../src/kilocode/plan-artifact"
import { RayaRevertNote } from "../../../src/kilocode/session/revert-note"
import { DraftLegacy } from "../../../src/kilocode/session/composer-codec"
import { finish } from "../../../src/kilocode/cli/finish"

const [workspace, index] = process.argv.slice(2)
assert(workspace && index)
const data = Global.Path.data
await mkdir(path.join(data, "storage", "raya"), { recursive: true })
const runtime = ManagedRuntime.make(Core.layerFromPath(path.join(data, "raya.db")))
const output = ManagedRuntime.make(AppNodeBuilder.build(Truncate.node))
const text = `Graph ${index} output café 日本語 😀\n`.repeat(3000)
const result = await output.runPromise(
  Effect.gen(function* () {
    return yield* (yield* Truncate.Service).output(text)
  }),
)
await output.dispose()
assert(result.truncated && result.outputPath)
const sql = (value: string) => value.replaceAll("'", "''")
const part = {
  type: "tool",
  callID: "call_shared",
  tool: "read",
  state: {
    status: "completed",
    input: {},
    output: result.content,
    title: "Read",
    metadata: { truncated: true, outputPath: result.outputPath },
    time: { start: 1, end: 2 },
  },
}
await runtime.runPromise(
  Effect.gen(function* () {
    const db = (yield* Core.Service).db
    yield* db.run(
      `INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('project_shared','${sql(workspace)}',1,1,'[]')`,
    )
    yield* db.run(
      `INSERT INTO session(id,project_id,slug,directory,path,title,version,time_created,time_updated) VALUES ('ses_shared','project_shared','shared','${sql(workspace)}','','Graph ${index}','1',1,1)`,
    )
    yield* db.run(
      "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES ('msg_shared','ses_shared',1,1,'{}')",
    )
    yield* db.run(
      `INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES ('prt_shared','msg_shared','ses_shared',1,1,'${sql(JSON.stringify(part))}')`,
    )
  }),
)
await runtime.dispose()
await mkdir(path.join(data, "plans"))
const file = path.join(data, "plans", "same.md")
const markdown = `# Graph ${index} café 日本語 😀\n\n- [ ] Preserve distinct bytes\n`
await writeFile(file, markdown)
await Effect.runPromise(
  PlanArtifact.save(file, PlanArtifact.parse(markdown), createHash("sha256").update(markdown).digest("hex")).pipe(
    Effect.provide(LayerNode.compile(FSUtil.node)),
  ),
)
await RayaRevertNote.record("ses_shared", [path.join(workspace, `graph-${index}.txt`)])
const content = { text: `Graph ${index} draft café 日本語 😀`, comments: [], images: [], scroll: 0 }
const identity = {
  key: "session:ses_shared",
  box: "main",
  workspace,
  projectID: "project_shared",
  sessionID: "ses_shared",
}
const entries = [
  {
    identity,
    token: { generation: crypto.randomUUID(), revision: 1 },
    content,
    mutation: "fixture",
    digest: DraftLegacy.hash(content),
  },
]
await writeFile(
  path.join(data, "storage", ...DraftLegacy.key) + ".json",
  JSON.stringify(DraftLegacy.checked({ version: 1, entries })),
)
await writeFile(
  path.join(data, "seed-content.json"),
  JSON.stringify({ output: result.outputPath, text, markdown, draft: content.text }),
)
await finish([])
