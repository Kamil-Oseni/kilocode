import { expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID } from "@/session/schema"
import { TodoWriteTool } from "@/tool/todo"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Todo.node, Truncate.node, Agent.node])),
)

it.instance("todo tool persists concurrent work without advancing dependent tasks", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const todos = yield* Todo.Service
    const session = yield* sessions.create({})
    const tool = yield* (yield* TodoWriteTool).init()
    const list = [
      { content: "Inspect source", status: "in_progress", priority: "high" },
      { content: "Prepare independent test environment", status: "in_progress", priority: "medium" },
      { content: "Run checks after prerequisites finish", status: "pending", priority: "medium" },
    ]
    const ctx = {
      sessionID: session.id,
      messageID: MessageID.ascending(),
      agent: "code",
      abort: AbortSignal.any([]),
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }
    const first = yield* tool.execute({ todos: list }, ctx)
    expect(first.metadata.todos).toEqual(list)
    expect(JSON.parse(first.output)).toEqual(list)
    expect(yield* todos.get(session.id)).toEqual(list)
    const next = list.map((item, index) => (index === 0 ? { ...item, status: "completed" } : item))
    yield* tool.execute({ todos: next }, ctx)
    expect(yield* todos.get(session.id)).toEqual(next)
  }),
)
