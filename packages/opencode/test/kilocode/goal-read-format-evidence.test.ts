import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ReadTool } from "@/tool/read"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RayaGoal } from "@/kilocode/goal"
import { database, storage } from "./fixtures/effect-profile"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      Database.node,
      SessionProjector.node,
      Agent.node,
      Config.node,
      Provider.node,
      Question.node,
      Permission.node,
      Session.node,
      EventV2Bridge.node,
      Truncate.node,
      Instruction.node,
      LSP.node,
      Ripgrep.node,
      Storage.node,
      FSUtil.node,
      Git.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)
const cfg = {
  snapshot: false,
  plugin: [],
  mcp: {},
  enabled_providers: ["local"],
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: { baseURL: "http://127.0.0.1:11434/v1" },
      models: { fixture: { name: "fixture" } },
    },
  },
  agent: { generalist: { model: "local/fixture" } },
} satisfies Partial<Config.Info>

it.live(
  "physical saved goal evidence exposes bounded current LF and CRLF facts beyond the preview",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const sessions = yield* Session.Service
          const storage = yield* Storage.Service
          const chat = yield* sessions.create()
          const model = { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("fixture") }
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            role: "user",
            agent: "auto",
            model,
            time: { created: Date.now() },
          })
          const goals = RayaGoal.make({ storage, sessions })
          const goal = yield* goals.create(chat.id, "Inspect the actual file newline format", user.id)
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: chat.id,
            parentID: user.id,
            role: "assistant",
            agent: "auto",
            mode: "auto",
            cost: 0,
            path: { cwd: dir, root: dir },
            providerID: model.providerID,
            modelID: model.modelID,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          const reader = yield* (yield* ReadTool).init()
          const targets: string[] = []
          for (const ending of ["LF", "CRLF"]) {
            const file = path.join(dir, ending + ".txt")
            targets.push(file)
            yield* fs.writeFileString(file, "x".repeat(600) + (ending === "LF" ? "\n" : "\r\n"))
            const ctx = {
              sessionID: chat.id,
              messageID: assistant.id,
              callID: "format-" + ending,
              agent: "auto",
              abort: new AbortController().signal,
              messages: yield* sessions.messages({ sessionID: chat.id }),
              metadata: () => Effect.void,
              ask: () => Effect.void,
            }
            const start = Math.max(Date.now(), goal.createdAt)
            const result = yield* reader.execute({ filePath: file }, ctx)
            expect(result.output.indexOf("<file-format")).toBeGreaterThan(500)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: chat.id,
              messageID: assistant.id,
              type: "tool",
              tool: "read",
              callID: ctx.callID,
              state: {
                status: "completed",
                input: { filePath: file },
                output: result.output,
                title: result.title,
                metadata: result.metadata,
                time: { start, end: Date.now() },
              },
            })
          }
          const evidence = yield* goals.evidence(chat.id)
          expect(evidence.length).toBe(2)
          for (const ending of ["LF", "CRLF"]) {
            const item = evidence.find((row) => row.callID === "format-" + ending)
            expect(item?.output).not.toContain("<file-format")
            expect(item?.format).toMatchObject({
              version: 1,
              path: targets[ending === "LF" ? 0 : 1],
              encoding: "UTF-8",
              bom: false,
              endings: ending,
              newline: true,
              bytes: ending === "LF" ? 601 : 602,
            })
            expect(item?.artifact).toMatchObject({ sha256: item?.format?.sha256 })
            expect(item?.format).not.toHaveProperty("text")
            expect(item?.format).not.toHaveProperty("content")
          }
          yield* fs.writeFileString(targets[0], "changed")
          const stale = yield* goals.evidence(chat.id)
          expect(stale.length).toBe(2)
          expect(stale.find((row) => row.callID === "format-LF")?.format).toBeUndefined()
          expect(stale.find((row) => row.callID === "format-CRLF")?.format?.endings).toBe("CRLF")
        }),
      { config: cfg },
    ),
  30_000,
)
