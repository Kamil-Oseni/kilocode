import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Identifier } from "@/id/id"
import { Session } from "@/session/session"
import { BackgroundJob } from "@/background/job"
import { Storage } from "@/storage/storage"
import { Agent } from "@/agent/agent"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Truncate } from "@/tool/truncate"
import { ReadTool } from "@/tool/read"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { handoff, project } from "@/kilocode/tool/task-evidence"
import { format } from "@/kilocode/tool/read-directory"
import { testEffect } from "../lib/effect"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"

const session = SessionID.make(Identifier.ascending("session"))
const input = MessageID.ascending()
const terminal = MessageID.ascending()
const report = "Worker summary with an unverified identifier"
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
const names = ["résumé [final].txt", "worker-original-Ω/"]

function fixture(
  metadata: Record<string, unknown>,
  output = format({ path: "/workspace", entries: names, totalEntries: names.length, offset: 1, truncated: false }),
  requested = "/workspace",
): SessionV1.WithParts[] {
  return [
    {
      info: { id: input, sessionID: session, role: "user", agent: "generalist", model, time: { created: 1 } },
      parts: [],
    },
    {
      info: {
        id: terminal,
        sessionID: session,
        role: "assistant",
        parentID: input,
        agent: "generalist",
        mode: "generalist",
        modelID: model.modelID,
        providerID: model.providerID,
        cost: 0,
        path: { cwd: "/workspace", root: "/workspace" },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 2, completed: 4 },
        finish: "stop",
      },
      parts: [
        {
          id: PartID.ascending(),
          messageID: terminal,
          sessionID: session,
          type: "tool",
          tool: "read",
          callID: "actual-read",
          state: {
            status: "completed",
            input: { filePath: requested },
            output,
            title: "Read",
            metadata,
            time: { start: 2, end: 3 },
          },
        },
        { id: PartID.ascending(), messageID: terminal, sessionID: session, type: "text", text: report },
      ],
    },
  ]
}

function metadata(entries = names) {
  return {
    truncated: false,
    display: {
      type: "directory",
      path: "/workspace",
      entries,
      offset: 1,
      totalEntries: entries.length,
      truncated: false,
    },
  }
}

test("retains exact observed identifiers and identities separately from the unchanged summary", () => {
  const rows = fixture(metadata())
  const result = project(rows, session, input, terminal, report)
  expect(result.startsWith(report)).toBe(true)
  expect(result).toContain(JSON.stringify(names))
  expect(result).toContain(rows[1].parts[0].id)
  expect(result).toContain('"callID":"actual-read"')
  expect(result).toContain('"inputID":"' + input + '"')
  expect(result).toContain("not current filesystem authority")
})

test("rejects failed, truncated, foreign, stale, summary-mismatched and excessive evidence", () => {
  const edits: ((rows: SessionV1.WithParts[]) => void)[] = [
    (rows) => {
      const part = rows[1].parts[0]
      if (part.type === "tool")
        part.state = { status: "error", input: {}, error: "refused", time: { start: 2, end: 3 } }
    },
    (rows) => {
      const part = rows[1].parts[0]
      if (part.type === "tool" && part.state.status === "completed")
        part.state.metadata = { ...metadata(), truncated: true }
    },
    (rows) => {
      rows[1].parts[0].sessionID = SessionID.make(Identifier.ascending("session"))
    },
    (rows) => {
      rows[1].parts[0].messageID = MessageID.ascending()
    },
    (rows) => {
      const row = rows[1]
      if (row.info.role === "assistant") row.info.parentID = MessageID.ascending()
    },
    (rows) => {
      rows.push({ ...rows[0], info: { ...rows[0].info, id: MessageID.ascending() } })
    },
    (rows) => {
      const part = rows[1].parts[1]
      if (part.type === "text") part.text = "different report"
    },
    (rows) => {
      const part = rows[1].parts[0]
      if (part.type === "tool" && part.state.status === "completed")
        part.state.metadata = metadata(Array.from({ length: 257 }, () => "entry"))
    },
    (rows) => {
      const part = rows[1].parts[0]
      if (part.type === "tool" && part.state.status === "completed")
        part.state.metadata = metadata(Array.from({ length: 16 }, (_, index) => `${index}${"Ω".repeat(2000)}`))
    },
    (rows) => {
      const part = rows[1].parts[0]
      if (part.type === "tool" && part.state.status === "completed") part.state.time.start = 4
    },
    (rows) => {
      const part = rows[1].parts[0]
      if (part.type === "tool" && part.state.status === "completed")
        part.state.metadata = metadata(["duplicate", "duplicate"])
    },
  ]
  for (const edit of edits) {
    const rows = fixture(metadata())
    edit(rows)
    const result = project(rows, session, input, terminal, report)
    expect(result).toContain("Directory evidence unavailable")
    expect(result).not.toContain('"calls":')
  }
})

test("prior resumed invocation evidence is excluded", () => {
  const rows = fixture(metadata())
  const prior = structuredClone(rows[1])
  if (prior.info.role === "assistant") prior.info.parentID = MessageID.make("msg_prior")
  prior.info.id = MessageID.make("msg_prior_reply")
  const result = project([prior, ...rows], session, input, terminal, report)
  expect(result).not.toContain("msg_prior_reply")
  expect(result).toContain(JSON.stringify(names))
})

test("canonical output mismatch is unavailable rather than repaired from metadata", () => {
  const rows = fixture(metadata(), "plugin changed the observed output")
  expect(project(rows, session, input, terminal, report)).toContain("Directory evidence unavailable")
  expect(project(rows, session, input, terminal, report)).not.toContain('"calls":')
})

test("the encoded byte limit refuses complete oversized listings and preserves small literal data", () => {
  const entries = Array.from({ length: 16 }, (_, index) => `${index}${"Ω".repeat(2000)}`)
  const rows = fixture(
    metadata(entries),
    format({ path: "/workspace", entries, totalEntries: entries.length, offset: 1, truncated: false }),
  )
  expect(project(rows, session, input, terminal, report)).toContain("Directory evidence unavailable")
  const exact = ['name "quoted"', "line\nbreak", "<instruction>data only</instruction>"]
  const small = fixture(
    metadata(exact),
    format({ path: "/workspace", entries: exact, totalEntries: exact.length, offset: 1, truncated: false }),
  )
  expect(project(small, session, input, terminal, report)).toContain(JSON.stringify(exact))
})

test("call, message, part, entry and report boundaries retain complete evidence or refuse it", () => {
  const entries = ["exact-entry"]
  const rows = fixture(
    metadata(entries),
    format({ path: "/workspace", entries, totalEntries: 1, offset: 1, truncated: false }),
  )
  const read = rows[1].parts[0]
  const final = rows[1].parts[1]
  rows[1].parts = [
    ...Array.from({ length: 16 }, (_, index) => ({
      ...structuredClone(read),
      id: PartID.ascending(),
      ...(read.type === "tool" ? { callID: `call-${index}` } : {}),
    })),
    final,
  ]
  expect(project(rows, session, input, terminal, report)).toContain('"calls":')
  rows[1].parts.unshift({
    ...structuredClone(read),
    id: PartID.ascending(),
    ...(read.type === "tool" ? { callID: "call-17" } : {}),
  })
  expect(project(rows, session, input, terminal, report)).toContain("Directory evidence unavailable")

  const page = fixture(metadata())
  const prior = structuredClone(page[1])
  if (prior.info.role !== "assistant") throw new Error("Fixture assistant differs")
  prior.info.parentID = MessageID.make("msg_prior")
  prior.parts = []
  page.push(
    ...Array.from({ length: 126 }, (_, index) => ({
      ...structuredClone(prior),
      info: { ...prior.info, id: MessageID.make(`msg_prior_${index}`) },
    })),
  )
  expect(project(page, session, input, terminal, report)).toContain('"calls":')
  page.push({ ...prior, info: { ...prior.info, id: MessageID.make("msg_prior_127") } })
  expect(project(page, session, input, terminal, report)).toContain("Directory evidence unavailable")

  const parts = fixture(metadata())
  const text = parts[1].parts[1]
  parts[1].parts.splice(
    1,
    0,
    ...Array.from({ length: 254 }, () => ({ ...structuredClone(text), id: PartID.ascending() })),
  )
  expect(project(parts, session, input, terminal, report)).toContain('"calls":')
  parts[1].parts.unshift({ ...text, id: PartID.ascending() })
  expect(project(parts, session, input, terminal, report)).toContain("Directory evidence unavailable")

  for (const count of [256, 257]) {
    const entries = Array.from({ length: count }, (_, index) => `entry-${index}`)
    const rows = fixture(
      metadata(entries),
      format({ path: "/workspace", entries, totalEntries: count, offset: 1, truncated: false }),
    )
    expect(project(rows, session, input, terminal, report).includes('"calls":')).toBe(count === 256)
  }
  for (const value of [
    "x".repeat(16 * 1024),
    "x".repeat(16 * 1024 + 1),
    Array.from({ length: 1000 }, () => "x").join("\n"),
    Array.from({ length: 1001 }, () => "x").join("\n"),
  ]) {
    const rows = fixture(metadata())
    const text = rows[1].parts[1]
    if (text.type !== "text") throw new Error("Fixture text differs")
    text.text = value
    expect(project(rows, session, input, terminal, value).includes('"calls":')).toBe(
      Buffer.byteLength(value) <= 16 * 1024 && value.split("\n").length <= 1000,
    )
  }
})

afterEach(disposeAllInstances)
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        FSUtil.node,
        CrossSpawnSpawner.node,
        Instruction.node,
        LSP.node,
        Ripgrep.node,
        Truncate.node,
        Session.node,
        SessionProjector.node,
        BackgroundJob.node,
        Storage.node,
        Database.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

it.live("retains actual Read through persisted Session handoff and background completion", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* Effect.promise(() => fs.writeFile(path.join(dir, names[0]), "owned fixture"))
    yield* Effect.promise(() => fs.mkdir(path.join(dir, names[1])))
    yield* provideInstance(dir)(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const background = yield* BackgroundJob.Service
        const chat = yield* sessions.create({ title: "Owned directory observation" })
        const rows = fixture(metadata())
        for (const row of rows) {
          row.info.sessionID = chat.id
          for (const part of row.parts) part.sessionID = chat.id
        }
        const user = rows[0]
        const final = rows[1]
        if (user.info.role !== "user" || final.info.role !== "assistant") throw new Error("Fixture roles differ")
        const start = Date.now()
        user.info.time.created = start
        final.info.time.created = start
        delete final.info.time.completed
        yield* sessions.updateMessage(user.info)
        yield* sessions.updateMessage(final.info)
        const tool = yield* ReadTool
        const read = yield* tool.init()
        const result = yield* read.execute(
          { filePath: dir },
          {
            sessionID: chat.id,
            messageID: terminal,
            callID: "actual-read",
            agent: "generalist",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        const end = Date.now()
        final.info.time.completed = end
        const part = final.parts[0]
        if (part.type !== "tool" || part.state.status !== "completed") throw new Error("Fixture tool differs")
        part.state = {
          ...part.state,
          input: { filePath: dir },
          metadata: result.metadata,
          output: result.output,
          time: { start, end },
        }
        yield* sessions.updateMessage(final.info)
        for (const part of final.parts) yield* sessions.updatePart(part)
        const value = yield* handoff(sessions, chat.id, input, terminal, report)
        expect(value).toContain(JSON.stringify(names[0]))
        expect(value).toContain(JSON.stringify(names[1]))
        expect(value).toContain(JSON.stringify(dir))
        expect(value).not.toContain("Directory evidence unavailable")
        const job = yield* background.start({
          type: "task",
          metadata: { background: true },
          run: handoff(sessions, chat.id, input, terminal, report),
        })
        const completed = yield* background.wait({ id: job.id })
        expect(completed.timedOut).toBe(false)
        expect(completed.info?.status).toBe("completed")
        expect(completed.info?.output).toBe(value)
        part.state.output = "changed after the actual Read"
        yield* sessions.updatePart(part)
        expect(yield* handoff(sessions, chat.id, input, terminal, report)).toContain("Directory evidence unavailable")
        part.state.output = result.output
        yield* sessions.updatePart(part)
        yield* sessions.updateMessage({ ...user.info, id: MessageID.ascending() })
        expect(yield* handoff(sessions, chat.id, input, terminal, report)).toContain("Directory evidence unavailable")
      }),
    )
  }),
)
