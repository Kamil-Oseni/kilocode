import { expect } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Agent } from "@/agent/agent"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import * as Truncate from "@/tool/truncate"
import { ReadTool } from "@/tool/read"
import { RayaChief } from "@/kilocode/chief"
import { inspectionFile } from "@/kilocode/task/request"
import * as ReadArtifact from "@/kilocode/goal/read-artifact"
import { InstanceState } from "@/effect/instance-state"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      Storage.node,
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)

it.instance(
  "reads an explicit file directly with current-owner and permission fences, without children",
  () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const sessions = yield* Session.Service
      const instance = yield* InstanceState.context
      const file = path.join(instance.directory, "report.md")
      const other = path.join(instance.directory, "other.md")
      yield* fs.writeFileString(file, "Three drafts. Outreach was not sent.")
      yield* fs.writeFileString(other, "Unrelated confidential material.")
      const request = `Read ${file} and summarize the report. This is read-only: do not start workers, edit files, send anything, or publish.`
      const metadata = { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "route" }
      const session = yield* sessions.create({ metadata })
      const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("fixture") }
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "user",
        agent: "auto",
        model,
        time: { created: Date.now() },
      })
      const source = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: user.id,
        sessionID: session.id,
        type: "text",
        text: request,
      })
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        parentID: user.id,
        sessionID: session.id,
        role: "assistant",
        mode: "auto",
        agent: "auto",
        cost: 0,
        path: { cwd: instance.directory, root: instance.directory },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        providerID: model.providerID,
        modelID: model.modelID,
        time: { created: Date.now() },
      })
      const tools = Object.fromEntries(
        ["read", "task", "write", "get_goal", "second_brain_recall", "chief_route"].map((id) => [id, { id }]),
      )
      expect(Object.keys(RayaChief.tools(tools, metadata))).toEqual(["read"])
      expect(inspectionFile(request)).toBeDefined()
      expect(inspectionFile(`Read "${file}". This is read-only; do not start workers.`)).toBe(inspectionFile(request))
      for (const text of [
        `Read ${file} and ${other}. Read-only, no workers.`,
        `Read relative.md. Read-only, no workers.`,
        `Read ${file} and summarize. Example: "read-only, no workers".`,
        `\`\`\`\n${request}\n\`\`\``,
        `> ${request}`,
      ])
        expect(inspectionFile(text)).toBeUndefined()
      const reader = yield* ReadTool.pipe(Effect.flatMap((info) => info.init()))
      const permissions: string[] = []
      const ctx = {
        sessionID: session.id,
        messageID: assistant.id,
        callID: "direct-file-read",
        agent: "auto",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        extra: { includeInstructions: false },
        ask: (input: { permission: string }) =>
          Effect.sync(() => {
            permissions.push(input.permission)
          }),
      }
      const wrong = yield* Effect.exit(reader.execute({ filePath: other }, ctx))
      expect(Exit.isFailure(wrong)).toBe(true)
      expect(permissions).toEqual([])
      const denied = yield* Effect.exit(
        reader.execute({ filePath: file }, { ...ctx, ask: () => Effect.die(new Error("Read permission denied")) }),
      )
      expect(Exit.isFailure(denied)).toBe(true)
      if (Exit.isFailure(denied)) expect(String(Cause.squash(denied.cause))).toContain("Read permission denied")
      expect(RayaChief.observed(yield* sessions.messages({ sessionID: session.id }), session, user.id)).toBe(false)
      const start = Date.now()
      const read = yield* reader.execute({ filePath: file }, ctx)
      expect(read.output).toContain("Outreach was not sent")
      expect(read.output).toContain('<system-reminder source="raya-direct-read">')
      expect(read.output).toContain("it did not start workers")
      expect(read.output).toContain("If the owner asked only to read the file, reply with one short sentence")
      expect(read.output).toContain("qualified if partial or truncated")
      expect(read.output).toContain("Do not add dates, timestamps, lists, plan interpretations")
      expect(read.output).toContain("If the owner explicitly requested a summary, review or explanation")
      expect(read.output).toContain("A declared future output establishes neither its current existence nor its absence.")
      expect(read.output).toContain("Do not promise to execute the plan.")
      expect(read.output).toContain("</file-content-json>")
      expect(read.output.indexOf('<system-reminder source="raya-direct-read">')).toBeGreaterThan(
        read.output.indexOf("</file-content-json>"),
      )
      expect(read.metadata.display).toMatchObject({
        type: "file",
        text: "Three drafts. Outreach was not sent.",
        truncated: false,
      })
      const content = yield* ReadArtifact.whole({ ...read.metadata })
      expect(content?.text).toBe("Three drafts. Outreach was not sent.")
      expect(content?.bytes).toBe(Buffer.byteLength("Three drafts. Outreach was not sent.", "utf8"))
      expect(permissions).toContain("read")
      const receipt = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: session.id,
        type: "tool",
        tool: "read",
        callID: ctx.callID,
        state: {
          status: "completed",
          input: { filePath: file },
          title: read.title,
          output: read.output,
          metadata: read.metadata,
          time: { start, end: Date.now() },
        },
      })
      expect(RayaChief.observed(yield* sessions.messages({ sessionID: session.id }), session, user.id)).toBe(true)
      yield* sessions.updatePart({ ...receipt, tool: "get_goal" })
      expect(RayaChief.observed(yield* sessions.messages({ sessionID: session.id }), session, user.id)).toBe(false)
      yield* sessions.updatePart({ ...receipt, state: { ...receipt.state, input: { filePath: other } } })
      expect(RayaChief.observed(yield* sessions.messages({ sessionID: session.id }), session, user.id)).toBe(false)
      const edited = yield* Effect.exit(
        reader.execute(
          { filePath: file },
          {
            ...ctx,
            ask: () =>
              Effect.gen(function* () {
                yield* sessions.updatePart({ ...source, text: request + " Changed owner text." })
              }),
          },
        ),
      )
      expect(Exit.isFailure(edited)).toBe(true)
      yield* sessions.updatePart(source)
      const stale = yield* Effect.exit(
        reader.execute(
          { filePath: file },
          {
            ...ctx,
            ask: () =>
              Effect.gen(function* () {
                const next = yield* sessions.updateMessage({
                  ...user,
                  id: MessageID.ascending(),
                  time: { created: Date.now() },
                })
                yield* sessions.updatePart({
                  ...source,
                  id: PartID.ascending(),
                  messageID: next.id,
                  text: "Never mind, say hello.",
                })
                yield* sessions.setMetadata({
                  sessionID: session.id,
                  metadata: { [RayaChief.requestKey]: "Never mind, say hello." },
                })
              }),
          },
        ),
      )
      expect(Exit.isFailure(stale)).toBe(true)
      if (Exit.isFailure(stale))
        expect(String(Cause.squash(stale.cause))).toContain("original direct Read owner changed")
      const already = yield* Effect.exit(reader.execute({ filePath: file }, ctx))
      expect(Exit.isFailure(already)).toBe(true)
      expect(yield* sessions.children(session.id)).toEqual([])
      const ordinary = yield* reader.execute({ filePath: other }, { ...ctx, agent: "general" })
      expect(ordinary.output).toContain("Unrelated confidential material")
      expect(ordinary.output).not.toContain('<system-reminder source="raya-direct-read">')
    }),
  { config: { formatter: false, lsp: false, enabled_providers: [] } },
)
