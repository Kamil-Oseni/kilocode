import { expect, test } from "bun:test"
import { Effect } from "effect"
import { command, requested, manage } from "@/kilocode/second-brain/management"
import { digest, valid, result } from "@/kilocode/second-brain/management-source"
import type { ManageResult } from "@/kilocode/second-brain/management-protocol"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

function source(text: string) {
  const value = { sessionID: "ses_user", messageID: "msg_user", created_utc: "2026-10-12T01:30:00.000Z", text }
  return { ...value, source_sha256: digest(value) }
}

test("personal management derives exact original facts and a stable operation instead of replay authority", () => {
  const original = source("Remember that I prefer tea ☕.")
  const value = command(original, { action: "remember", text: "I prefer tea ☕" })
  expect(original.text.slice(value.fact!.start, value.fact!.end)).toBe("I prefer tea ☕")
  expect(command(original, { action: "remember" }).operation).toBe(value.operation)
  expect(() => command(original, { action: "correct", query: "drink preference", text: "coffee" })).toThrow()
  expect(() => command(original, { action: "remember", text: "I prefer coffee" })).toThrow("exact original")
  const corrected = command(source("Correct my drink preference to coffee."), {
    action: "correct",
    query: "drink preference",
    text: "coffee",
  })
  expect(corrected.mode).toBe("correct")
  expect(command(source("Forget my drink preference."), { action: "forget" }).query).toBe("drink preference")
  expect(requested("Change the lights to red.")).toBeUndefined()
  expect(requested("What do you remember about tea?")).toBeUndefined()
})

test("common explicit personal Memory wording preserves colon and multiline fact spans", () => {
  for (const text of [
    "Remember this: I prefer tea.",
    "Remember this:\nI prefer tea\nand calm evenings.",
    "Store this: I prefer tea.",
  ]) {
    const original = source(text)
    const value = command(original, { action: "remember" })
    expect(original.text.slice(value.fact!.start, value.fact!.end)).toBe(
      text
        .slice(text.indexOf(":") + 1)
        .trim()
        .replace(/\.$/, ""),
    )
  }
  expect(
    command(source("Update my drink preference to coffee."), {
      action: "correct",
      text: "coffee",
      query: "drink preference",
    }).mode,
  ).toBe("correct")
  expect(command(source("Change my saved memory about drinks to coffee."), { action: "correct" }).mode).toBe("correct")
  expect(requested("Update my code to use coffee.")).toBeUndefined()
  expect(requested("Change my lights to red.")).toBeUndefined()
  expect(requested("Change the device name to kitchen.")).toBeUndefined()
  expect(() => command(source("Do something about tea."), { action: "remember" })).toThrow(
    "new explicit personal Memory request",
  )
})

test("staged personal management requires exact retained nonces and separates publication from indexing", () => {
  const original = command(source("Remember that I prefer tea."), { action: "remember" })
  const attempt = "b43ff5f0-6049-4009-905a-7649022ee5b7"
  const choice = "c43ff5f0-6049-4009-905a-7649022ee5b7"
  expect(valid({ ...original, stage: "review" })).toBe(false)
  expect(valid({ ...original, stage: "inspect", attempt })).toBe(false)
  expect(valid({ ...original, stage: "cancel", attempt, choice })).toBe(false)
  expect(valid({ ...original, stage: "cancel", attempt })).toBe(true)
  const selected = { ...original, stage: "select" as const, attempt, choice }
  expect(valid(selected)).toBe(true)
  const receipt: ManageResult = {
    action: "manage",
    project: "/repo",
    operation: original.operation,
    mode: original.mode,
    sessionID: original.source.sessionID,
    messageID: original.source.messageID,
    source_sha256: original.source.source_sha256,
    disposition: "pending",
    publication_confirmed: false,
    index_confirmed: false,
    changes: [],
    attempt,
    stage: "review",
    proposal: original.operation,
    question: {
      prompt: "Review?",
      options: [
        { id: choice, label: "Review" },
        { id: original.operation, label: "Cancel" },
      ],
    },
  }
  expect(result(selected, receipt)).toBe(true)
  expect(result(selected, { ...receipt, attempt: original.operation })).toBe(false)
  expect(
    result(selected, {
      ...receipt,
      question: { ...receipt.question!, options: [receipt.question!.options[0], receipt.question!.options[0]] },
    }),
  ).toBe(false)
  const published = {
    ...receipt,
    stage: undefined,
    question: undefined,
    disposition: "published" as const,
    publication_confirmed: true,
    changes: [{ relative: "People/Friend.md", note_sha256: "a".repeat(64) }],
  }
  expect(result(selected, published)).toBe(true)
  expect(result(selected, { ...published, index_confirmed: true })).toBe(false)
  expect(result(selected, { ...published, disposition: "indexed", index_confirmed: true })).toBe(true)
})

function fixture() {
  const sid = SessionID.make("ses_cards")
  const uid = MessageID.make("msg_original")
  const aid = MessageID.make("msg_tool")
  const part = {
    id: PartID.make("prt_original"),
    sessionID: sid,
    messageID: uid,
    type: "text" as const,
    text: "Remember that I prefer tea.",
  }
  const rows = [
    {
      info: {
        id: uid,
        sessionID: sid,
        role: "user" as const,
        time: { created: 100 },
        agent: "auto",
        model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("test") },
      },
      parts: [part],
    },
    {
      info: {
        id: aid,
        sessionID: sid,
        role: "assistant" as const,
        parentID: uid,
        time: { created: 101 },
        providerID: ProviderV2.ID.make("local"),
        modelID: ModelV2.ID.make("test"),
        mode: "auto",
        agent: "auto",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [],
    },
  ]
  const attempt = "b43ff5f0-6049-4009-905a-7649022ee5b7"
  const choice = "c43ff5f0-6049-4009-905a-7649022ee5b7"
  const calls: string[] = []
  const input: Parameters<typeof manage>[0] = {
    args: { action: "remember" },
    project: "/repo",
    ctx: {
      sessionID: sid,
      messageID: aid,
      agent: "auto",
      abort: new AbortController().signal,
      messages: rows,
      ask: () => Effect.void,
      metadata: () => Effect.void,
    },
    sessions: {
      get: () =>
        Effect.succeed({
          id: sid,
          slug: "cards",
          projectID: ProjectV2.ID.make("project"),
          directory: "/repo",
          title: "Cards",
          version: "test",
          time: { created: 100, updated: 100 },
        }),
      messages: () => Effect.succeed(rows),
    },
    question: {
      ask: () =>
        Effect.sync(() => {
          part.text = "Remember that I prefer coffee."
          return [["raya-option:" + choice]]
        }),
      reply: () => Effect.die("Unexpected reply"),
      reject: () => Effect.die("Unexpected reject"),
      list: () => Effect.succeed([]),
      dismissAll: () => Effect.void,
    },
    brain: {
      request: (input) =>
        Effect.sync(() => {
          if (input.command.action !== "manage") throw new Error("Management request required")
          const command = input.command
          calls.push(command.stage)
          return {
            action: "manage" as const,
            project: "/repo",
            operation: command.operation,
            mode: command.mode,
            sessionID: sid,
            messageID: uid,
            source_sha256: command.source.source_sha256,
            disposition: command.stage === "cancel" ? ("cancelled" as const) : ("pending" as const),
            publication_confirmed: false,
            index_confirmed: false,
            changes: [],
            attempt,
            ...(command.stage === "inspect"
              ? {
                  stage: "select" as const,
                  question: {
                    prompt: "Choose category",
                    options: [
                      { id: choice, label: "Preferences" },
                      { id: command.operation, label: "Cancel" },
                    ],
                  },
                }
              : {}),
          }
        }),
    },
  }
  return { input, calls, part }
}

test("personal management refuses a substituted tool context and routine-generated user before host dispatch", async () => {
  for (const scenario of ["context", "routine"]) {
    const original = fixture()
    const input = {
      ...original.input,
      ctx: { ...original.input.ctx, messages: structuredClone(original.input.ctx.messages) },
      sessions: {
        ...original.input.sessions,
        get: (id: SessionID) =>
          original.input.sessions
            .get(id)
            .pipe(
              Effect.map((session) =>
                scenario === "routine" ? { ...session, metadata: { rayaRoutine: { version: 1 } } } : session,
              ),
            ),
      },
    }
    if (scenario === "context") original.part.text = "Remember that I prefer coffee."
    const failure = await Effect.runPromise(manage(input)).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(String(failure)).toContain(scenario === "routine" ? "conversation changed" : "differs from this tool")
    expect(original.calls).toEqual([])
  }
})

test("an awaited conversation card rechecks stored original source before selecting and cancels without replay", async () => {
  const original = fixture()
  const failure = await Effect.runPromise(manage(original.input)).then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(String(failure)).toContain("Original user Memory source changed")
  expect(original.calls).toEqual(["inspect", "cancel"])
})
