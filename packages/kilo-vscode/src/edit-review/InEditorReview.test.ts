import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as vscode from "vscode"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { registerInEditorReview } from "./InEditorReview"
import { fingerprint } from "./revision"
import { remember } from "./attempts"
import * as path from "node:path"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function setup(workspaceState?: Parameters<typeof remember>[0]) {
  const state = {
    session: "session-a",
    patch: "@@ -1 +1 @@\n-old\n+first",
    connected: true,
    defer: false,
    reviewed: undefined as string | undefined,
    generation: undefined as string | undefined,
  }
  const reads: ((response: Response) => void)[] = []
  const requests: { path: string; body: unknown; resolve: (response: Response) => void }[] = []
  const events: unknown[] = []
  const commands = new Map<string, (...args: string[]) => Promise<void>>()
  let provider: vscode.CodeLensProvider | undefined
  const command = spyOn(vscode.commands, "registerCommand").mockImplementation((id, callback) => {
    commands.set(id, callback)
    return { dispose() {} }
  })
  const lenses = spyOn(vscode.languages, "registerCodeLensProvider").mockImplementation((_selector, value) => {
    provider = value
    return { dispose() {} }
  })
  const errors = spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
  cleanups.push(
    () => command.mockRestore(),
    () => lenses.mockRestore(),
    () => errors.mockRestore(),
  )
  const client = createKiloClient({
    baseUrl: "http://review.test",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input)
      if (request.method === "GET" && state.defer) return new Promise<Response>((resolve) => reads.push(resolve))
      if (request.method === "GET")
        return Response.json([
          {
            file: "file.ts",
            patch: state.patch,
            additions: 1,
            deletions: 1,
            reviewed: state.reviewed,
            generation: state.generation,
          },
        ])
      const body = await request.json()
      return new Promise<Response>((resolve) => requests.push({ path: new URL(request.url).pathname, body, resolve }))
    },
  })
  const subscriptions: vscode.Disposable[] = []
  const review = registerInEditorReview({ subscriptions, workspaceState } as vscode.ExtensionContext, {
    connection: { getClient: () => client, getConnectionState: () => (state.connected ? "connected" : "disconnected") },
    session: () => state.session,
    directory: () => process.cwd(),
    onFile: (event) => events.push(event),
  })
  cleanups.push(() => review.dispose())
  const document = { uri: vscode.Uri.file(path.resolve("file.ts")), lineCount: 10 } as vscode.TextDocument
  const read = async () => (await provider!.provideCodeLenses(document, {} as vscode.CancellationToken)) ?? []
  const run = async (action: "keep" | "undo") => {
    const list = await read()
    const lens = list.find((item) => item.command?.command === `raya.editReview.${action}File`)!
    return commands.get(lens.command!.command)!(...lens.command!.arguments!)
  }
  const wait = async (count = 1) => {
    for (let attempt = 0; requests.length < count && attempt < 100; attempt++) await Bun.sleep(1)
    expect(requests.length).toBe(count)
  }
  return { state, requests, reads, events, review, read, run, wait, errors, commands }
}

describe("in-editor review acknowledgements", () => {
  test("a later patch generation reopens identical content and invalidates old commands", async () => {
    const fixture = setup()
    fixture.state.generation = "first:patch"
    await fixture.review.refresh()
    const lens = (await fixture.read())[1].command!
    const operation = fixture.run("keep")
    await fixture.wait()
    fixture.requests[0].resolve(Response.json({ id: "session-a" }))
    await operation
    await fixture.review.refresh()
    expect(await fixture.read()).toHaveLength(0)
    fixture.state.generation = "later:patch"
    await fixture.review.refresh()
    expect(await fixture.read()).toHaveLength(3)
    await fixture.commands.get(lens.command)!(...lens.arguments!)
    expect(fixture.requests).toHaveLength(1)
  })

  test("disposing the editor before success preserves its pending identity", async () => {
    const values = new Map<string, unknown>()
    const state = {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => {
        values.set(key, value)
      },
    }
    const fixture = setup(state)
    await fixture.review.refresh()
    const operation = fixture.run("keep")
    await fixture.wait()
    const request = fixture.requests[0].body as { requestID: string }
    fixture.review.dispose()
    fixture.requests[0].resolve(Response.json({ id: "session-a" }))
    await operation
    expect(fixture.events).toEqual([])
    expect(Object.values(values.get("raya.reviewAttempts.v1") as Record<string, unknown>)).toMatchObject([
      { id: request.requestID },
    ])
  })

  test("recovered attempts reuse the backend ID and wait for authoritative review state", async () => {
    const values = new Map<string, unknown>()
    const state = {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => {
        values.set(key, value)
      },
    }
    const fixture = setup(state)
    await remember(state, {
      request: "before-restart",
      session: "session-a",
      directory: process.cwd(),
      action: "keep",
      files: ["file.ts"],
      expected: { "file.ts": fingerprint({ file: "file.ts", patch: fixture.state.patch }) },
    })
    await fixture.review.refresh()
    const operation = fixture.run("keep")
    await fixture.wait()
    expect(fixture.requests[0].body).toMatchObject({ requestID: "before-restart" })
    fixture.requests[0].resolve(Response.json({ id: "session-a" }))
    await operation
    await fixture.review.refresh()
    expect(fixture.events).toEqual([])
    expect(await fixture.read()).toHaveLength(3)
    fixture.state.reviewed = fingerprint({ file: "file.ts", patch: fixture.state.patch })
    await fixture.review.refresh()
    expect(await fixture.read()).toHaveLength(0)
  })

  test("hydrates persisted acceptance and reopens controls when the backend revokes it", async () => {
    const fixture = setup()
    fixture.state.reviewed = fingerprint({ file: "file.ts", patch: fixture.state.patch })
    await fixture.review.refresh()
    expect(await fixture.read()).toHaveLength(0)
    fixture.state.reviewed = ""
    await fixture.review.refresh()
    expect(await fixture.read()).toHaveLength(3)
  })

  for (const action of ["keep", "undo"] as const) {
    test(`${action} retains controls and sends no mutation for an unsaved editor buffer`, async () => {
      const fixture = setup()
      const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
      const document = { uri: vscode.Uri.file(path.resolve("file.ts")), isDirty: true } as vscode.TextDocument
      documents.push(document)
      cleanups.push(() => {
        documents.splice(documents.indexOf(document), 1)
      })
      await fixture.review.refresh()
      await fixture.run(action)
      expect(fixture.requests).toEqual([])
      expect(fixture.events).toEqual([])
      expect(await fixture.read()).toHaveLength(3)
      expect(fixture.errors).toHaveBeenCalledWith("Save or revert unsaved changes in file.ts before reviewing it.")
    })

    test(`${action} preserves review on HTTP failure and acknowledges only a successful retry`, async () => {
      const fixture = setup()
      await fixture.review.refresh()
      const revision = (await fixture.read())[1].command?.arguments?.[1]
      const operation = fixture.run(action)
      await fixture.wait()
      expect(fixture.requests[0].body).toMatchObject({ files: ["file.ts"], expected: { "file.ts": revision } })
      expect(fixture.events).toEqual([])
      expect((await fixture.read())[0].command?.title).toContain("Updating")
      fixture.requests[0].resolve(Response.json({ message: "unavailable" }, { status: 503 }))
      await operation
      await fixture.review.refresh()
      expect(fixture.events).toEqual([])
      expect(fixture.errors).toHaveBeenCalledTimes(1)
      expect(await fixture.read()).toHaveLength(3)
      const retry = fixture.run(action)
      await fixture.wait(2)
      expect(fixture.requests[1].body).toEqual(fixture.requests[0].body)
      fixture.requests[1].resolve(Response.json({ id: "session-a" }))
      await retry
      await fixture.review.refresh()
      expect(fixture.events).toEqual([
        {
          sessionID: "session-a",
          file: "file.ts",
          action,
          revision: fingerprint({ file: "file.ts", patch: fixture.state.patch }),
        },
      ])
      expect(await fixture.read()).toEqual([])
      fixture.state.patch = "@@ -1 +1 @@\n-old\n+second"
      await fixture.review.refresh()
      expect(await fixture.read()).toHaveLength(3)
    })
  }

  test("a pending old session action cannot dismiss a different session", async () => {
    const fixture = setup()
    await fixture.review.refresh()
    const operation = fixture.run("keep")
    await fixture.wait()
    fixture.state.session = "session-b"
    await fixture.review.refresh()
    fixture.requests[0].resolve(Response.json({ id: "session-a" }))
    await operation
    await fixture.review.refresh()
    expect(fixture.events).toEqual([])
    expect(await fixture.read()).toHaveLength(3)
  })

  test("stale lenses cannot act on replacement content and pending commands are deduplicated", async () => {
    const fixture = setup()
    await fixture.review.refresh()
    const lens = (await fixture.read())[1].command!
    fixture.state.patch = "@@ -1 +1 @@\n-old\n+replacement"
    await fixture.review.refresh()
    await fixture.commands.get(lens.command)!(...lens.arguments!)
    expect(fixture.requests).toHaveLength(0)
    const current = (await fixture.read())[1].command!
    const operation = fixture.commands.get(current.command)!(...current.arguments!)
    await fixture.wait()
    await fixture.commands.get(current.command)!(...current.arguments!)
    expect(fixture.requests).toHaveLength(1)
    fixture.requests[0].resolve(Response.json({ id: "session-a" }))
    await operation
  })

  test("out-of-order diff responses cannot replace the latest revision", async () => {
    const fixture = setup()
    await fixture.review.refresh()
    fixture.state.defer = true
    const older = fixture.review.refresh()
    const newer = fixture.review.refresh()
    for (let attempt = 0; fixture.reads.length < 2 && attempt < 100; attempt++) await Bun.sleep(1)
    expect(fixture.reads).toHaveLength(2)
    fixture.reads[1](
      Response.json([{ file: "file.ts", patch: "@@ -1 +1 @@\n-old\n+latest", additions: 1, deletions: 1 }]),
    )
    await newer
    const revision = (await fixture.read())[1].command?.arguments?.[1]
    fixture.reads[0](Response.json([]))
    await older
    expect(await fixture.read()).toHaveLength(3)
    expect((await fixture.read())[1].command?.arguments?.[1]).toBe(revision)
  })

  test("bulk acknowledgements accept only the revisions captured before the request", async () => {
    const fixture = setup()
    await fixture.review.refresh()
    const accept = fixture.review.capture("session-a")
    fixture.state.patch = "@@ -1 +1 @@\n-old\n+newer"
    await fixture.review.refresh()
    accept()
    expect(await fixture.read()).toHaveLength(3)
    fixture.review.capture("session-a")()
    expect(await fixture.read()).toHaveLength(0)
  })

  test("an empty success response does not dismiss review", async () => {
    const fixture = setup()
    await fixture.review.refresh()
    const operation = fixture.run("keep")
    await fixture.wait()
    fixture.requests[0].resolve(new Response(null, { status: 204 }))
    await operation
    await fixture.review.refresh()
    expect(fixture.events).toEqual([])
    expect(await fixture.read()).toHaveLength(3)
  })

  test("rename and deletion-only patches retain file-scoped review controls", async () => {
    const fixture = setup()
    fixture.state.patch = "diff --git a/old.ts b/file.ts\nrename from old.ts\nrename to file.ts"
    await fixture.review.refresh()
    expect((await fixture.read())[0].command?.title).toContain("Renamed file")
    expect((await fixture.read())[1].command?.title).toBe("$(check) Keep file")
    fixture.state.patch = "@@ -1,2 +0,0 @@\n-old\n-lines"
    await fixture.review.refresh()
    expect(await fixture.read()).toHaveLength(3)
    expect((await fixture.read())[0].command?.title).toContain("Deleted file")
    expect((await fixture.read())[2].command?.title).toBe("$(discard) Undo file")
  })
})
