import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"

async function method(name = "indexCapture", params = "maximum = 600000") {
  const source = await readFile(path.resolve(import.meta.dir, "../../src/second-brain/host.ts"), "utf8")
  const tree = ts.createSourceFile("host.ts", source, ts.ScriptTarget.Latest, true)
  const owner = tree.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "BrainHost")
  if (!owner || !ts.isClassDeclaration(owner)) throw new Error("Actual BrainHost required")
  const value = owner.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(tree) === name)
  if (!value || !ts.isMethodDeclaration(value) || !value.body) throw new Error("Actual recovered-index owner required")
  const prefix = value.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? "async " : ""
  const compiled = ts.transpileModule(`${prefix}function run(${params}) ${value.body.getText(tree)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function("vscode", "disposeHistory", compiled + ";return run")
}

type Scope = {
  signal: AbortSignal
  check: () => void
  wait: <T>(body: () => PromiseLike<T>) => Promise<T>
}

async function fixture(body: (scope: Scope) => Promise<void>) {
  const messages: string[] = []
  const listeners = new Set<() => void>()
  const state = { disposed: 0, entered: 0, presentations: 0, cancelled: false }
  // Only the notification/native-work boundaries are controlled. The actual host
  // activity method owns real timers and the exact pending Promise; no native
  // helper, index, model, or original retirement qualification is claimed here.
  const run = (await method())({
    workspace: { isTrusted: true },
    ProgressLocation: { Notification: 15 },
    window: {
      withProgress: async (
        _options: unknown,
        callback: (
          progress: { report: (value: { message: string }) => void },
          cancellation: {
            isCancellationRequested: boolean
            onCancellationRequested: (callback: () => void) => { dispose: () => void }
          },
        ) => Promise<void>,
      ) => {
        state.presentations++
        return callback(
          { report: (value) => messages.push(value.message) },
          {
            isCancellationRequested: state.cancelled,
            onCancellationRequested: (callback) => {
              listeners.add(callback)
              return {
                dispose: () => {
                  state.disposed++
                  listeners.delete(callback)
                },
              }
            },
          },
        )
      },
    },
  })
  const host = {
    closing: false,
    indexing: undefined as { controller: AbortController; job: Promise<void> } | undefined,
    indexSave: async (scope: Scope) => {
      state.entered++
      await body(scope)
    },
  }
  return {
    start: (maximum?: number): Promise<void> => run.call(host, maximum),
    cancel: () => {
      state.cancelled = true
      for (const callback of listeners) callback()
    },
    host,
    messages,
    listeners,
    state,
  }
}

function deferred() {
  const value = Promise.withResolvers<void>()
  return { promise: value.promise, release: () => value.resolve() }
}

test("actual recovered-index activity deduplicates and retains cancellation until its original await joins", async () => {
  const entered = deferred()
  const original = deferred()
  const effects: string[] = []
  const value = await fixture(async (scope) => {
    entered.release()
    await original.promise
    scope.check()
    effects.push("publication")
  })
  const first = value.start()
  const outcome = first.then(
    () => "success",
    (err: unknown) => err,
  )
  expect(value.start()).toBe(first)
  await entered.promise
  value.cancel()
  expect(value.host.indexing).toBeDefined()
  expect(value.messages.at(-1)).toContain("waiting for original work and readers to join")
  expect(value.state.disposed).toBe(0)
  expect(effects).toEqual([])
  original.release()
  expect(await outcome).toBeInstanceOf(Error)
  expect(value.host.indexing).toBeUndefined()
  expect(value.state.entered).toBe(1)
  expect(value.state.presentations).toBe(1)
  expect(value.state.disposed).toBe(1)
  expect(value.listeners.size).toBe(0)
  expect(effects).toEqual([])
})

test("actual active-work timer fences acceptance but does not race return before original completion", async () => {
  const entered = deferred()
  const original = deferred()
  const value = await fixture(async (scope) => {
    entered.release()
    await original.promise
    scope.check()
  })
  const result = value.start(20)
  const state = { settled: false }
  const outcome = result.then(
    () => {
      state.settled = true
      return undefined
    },
    (err: unknown) => {
      state.settled = true
      return err
    },
  )
  await entered.promise
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(state.settled).toBe(false)
  expect(value.host.indexing).toBeDefined()
  expect(value.messages.at(-1)).toContain("Acceptance cancelled")
  original.release()
  expect(await outcome).toBeInstanceOf(Error)
  expect(value.listeners.size).toBe(0)
  expect(value.state.disposed).toBe(1)
  const count = value.messages.length
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(value.messages.length).toBe(count)
})

test("actual native approval wait is excluded from active-work acceptance time", async () => {
  const value = await fixture(async (scope) => {
    await scope.wait(() => new Promise((resolve) => setTimeout(resolve, 60)))
    scope.check()
  })
  await expect(value.start(30)).resolves.toBeUndefined()
  expect(value.messages.some((message) => message.includes("Acceptance cancelled"))).toBe(false)
  expect(value.state.disposed).toBe(1)
  expect(value.host.indexing).toBeUndefined()
})

test("actual indexSave excludes the final success notice dismissal from active work", async () => {
  const turn = { id: "original-save", root: "owned-root", messageID: "original-message" }
  const reviewed = {}
  const notice = deferred()
  const entered = deferred()
  const state = { disposed: 0, confirmed: 0 }
  const save = (await method("indexSave", "scope"))(
    {
      window: {
        showQuickPick: async (choices: { turn: typeof turn }[]) => choices[0],
        showInformationMessage: async () => {
          entered.release()
          await notice.promise
        },
      },
    },
    (value: object) => {
      expect(value).toBe(reviewed)
      state.disposed++
    },
  )
  const host = {
    intake: { recoverable: () => [turn] },
    context: {
      extensionPath: "owned-extension",
      globalState: { get: () => ({ format: "raya.memory.committed-capture.recovery", version: 1, phase: "applied" }) },
    },
    settings: { reviewCapture: async () => reviewed },
    confirmCapture: async () => {
      state.confirmed++
      return true
    },
  }
  const value = await fixture((scope) => save.call(host, scope))
  const job = value.start(100)
  const outcome = job.then(
    () => undefined,
    (err: unknown) => err,
  )
  try {
    await entered.promise
    await new Promise((resolve) => setTimeout(resolve, 160))
    expect(value.messages.some((message) => message.includes("Acceptance cancelled"))).toBe(false)
    expect(value.host.indexing).toBeDefined()
  } finally {
    notice.release()
    await outcome
  }
  expect(await outcome).toBeUndefined()
  expect(state.confirmed).toBe(1)
  expect(state.disposed).toBe(1)
  expect(value.host.indexing).toBeUndefined()
})

test("actual extension retirement returns the original index job and waits for its held boundary", async () => {
  const entered = deferred()
  const original = deferred()
  const value = await fixture(async (scope) => {
    entered.release()
    await original.promise
    scope.check()
  })
  const job = value.start()
  const outcome = job.then(
    () => undefined,
    (err: unknown) => err,
  )
  await entered.promise
  const held = value.host.indexing
  if (!held) throw new Error("Original activity required")
  const retire = (await method("retireIndex", ""))({})
  expect(retire.call(value.host)).toBe(job)
  expect(held.controller.signal.aborted).toBe(true)
  expect(value.host.indexing).toBe(held)
  expect(value.state.disposed).toBe(0)
  original.release()
  expect(await outcome).toBeInstanceOf(Error)
  expect(value.host.indexing).toBeUndefined()
  expect(value.state.disposed).toBe(1)
})
