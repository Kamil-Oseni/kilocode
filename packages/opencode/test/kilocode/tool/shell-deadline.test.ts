import { expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { SessionID, MessageID } from "@/session/schema"
import { ShellTool } from "@/tool/shell"
import { Truncate } from "@/tool/truncate"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

it.live(
  "real quiet children and diagnostic text do not end shell commands before their deadline",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      yield* fs.writeFileString(
        path.join(root, "deadline.mjs"),
        [
          'if (process.argv[2] === "diagnostic") console.log("error TS: expected fixture text, not a termination signal")',
          'setTimeout(() => console.log("child-finished"), 35_000)',
        ].join("\n"),
      )
      const prior = process.env.KILO_COMMAND_TIMEOUT_MAX_MS
      process.env.KILO_COMMAND_TIMEOUT_MAX_MS = "60000"
      yield* provideInstance(root)(
        Effect.gen(function* () {
          const tool = yield* ShellTool
          const shell = yield* tool.init()
          const started = Date.now()
          const results = yield* Effect.forEach(
            ["quiet", "diagnostic"],
            (mode) =>
              shell.execute(
                {
                  command: `bun deadline.mjs ${mode}`,
                  workdir: root,
                  timeout: 50_000,
                  description: "Observe a real child deadline",
                },
                {
                  sessionID: SessionID.make("ses_deadline"),
                  messageID: MessageID.make("msg_deadline"),
                  callID: mode,
                  agent: "code",
                  abort: AbortSignal.any([]),
                  messages: [],
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                },
              ),
            { concurrency: 2 },
          )
          expect(Date.now() - started).toBeGreaterThanOrEqual(35_000)
          for (const result of results) {
            expect(result.metadata.exit).toBe(0)
            expect(result.output).toContain("child-finished")
            expect(result.output).not.toContain("exceeding timeout")
          }
          expect(results[1].output).toContain("error TS: expected fixture text")
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prior === undefined) {
              delete process.env.KILO_COMMAND_TIMEOUT_MAX_MS
              return
            }
            process.env.KILO_COMMAND_TIMEOUT_MAX_MS = prior
          }),
        ),
      )
    }),
  70_000,
)

it.live(
  "explicit cancellation still terminates a running quiet child",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      yield* fs.writeFileString(
        path.join(root, "abort.mjs"),
        'console.log("abort-ready"); setTimeout(() => console.log("unexpected-finish"), 30000)',
      )
      yield* provideInstance(root)(
        Effect.gen(function* () {
          const tool = yield* ShellTool
          const shell = yield* tool.init()
          const controller = new AbortController()
          const result = yield* shell.execute(
            { command: "bun abort.mjs", workdir: root, timeout: 10_000, description: "Cancel a real child" },
            {
              sessionID: SessionID.make("ses_abort"),
              messageID: MessageID.make("msg_abort"),
              callID: "abort",
              agent: "code",
              abort: controller.signal,
              messages: [],
              ask: () => Effect.void,
              metadata: (input) =>
                Effect.sync(() => {
                  if (typeof input.metadata?.output === "string" && input.metadata.output.includes("abort-ready"))
                    controller.abort()
                }),
            },
          )
          expect(result.metadata.exit).toBeNull()
          expect(result.output).toContain("User aborted the command")
          expect(result.output).not.toContain("exceeding timeout")
          expect(result.output).not.toContain("unexpected-finish")
        }),
      )
    }),
  20_000,
)
