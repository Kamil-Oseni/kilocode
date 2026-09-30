import { afterAll, afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { readFile, symlink } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Global } from "@opencode-ai/core/global"
import { HttpRouter } from "effect/unstable/http"
import { Entry } from "@/kilocode/server/httpapi/groups/composer-drafts"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

const entry = Schema.decodeUnknownSync(Schema.Struct({ entry: Entry }))
const loaded = Schema.decodeUnknownSync(Schema.Struct({ entry: Schema.NullOr(Entry) }))
const listed = Schema.decodeUnknownSync(Schema.Struct({ entries: Schema.Array(Entry) }))
const promoted = Schema.decodeUnknownSync(Schema.Struct({ source: Entry, target: Entry }))
const session = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, projectID: Schema.String }))
const content = {
  text: "  Draft\n你好 🎻  ",
  comments: [],
  images: [
    { id: "text", filename: "notes.txt", mime: "text/plain", dataUrl: "data:text/plain;base64,YWJjCg==" },
    { id: "pdf", filename: "score.pdf", mime: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERi0xLjcK" },
    {
      id: "binary",
      filename: "sample.bin",
      mime: "application/octet-stream",
      dataUrl: "data:application/octet-stream;base64,AAEC/w==",
    },
  ],
  scroll: 14.5,
  model: { providerID: "local", modelID: "main-9b" },
  agent: "build",
  variant: "medium",
  selection: { start: 2, end: 7 },
}
// Keep the real in-memory SQL connection paired with its retired private JSON profile.
// Instance disposal below tests workspace restarts; disk/process restarts have separate coverage.
const handler = HttpRouter.toWebHandler(HttpApiServer.routes, { disableLogger: true })
afterAll(() => handler.dispose())

async function json(response: Response) {
  const body: unknown = await response.json()
  const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined
  expect({ status: response.status, code }).toEqual({ status: 200, code: undefined })
  return body
}

function app() {
  const post = (directory: string, route: string, body: string) =>
    handler.handler(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-kilo-directory": directory },
        body,
      }),
      HttpApiServer.context,
    )
  return {
    request: (directory: string, route: string, body: unknown) => post(directory, route, JSON.stringify(body)),
    raw: post,
  }
}

test("HTTP draft commits reload rich state and pending discovery after instance restart with exact replay", async () => {
  await using tmp = await tmpdir({ git: true })
  await using links = await tmpdir()
  const server = app()
  const created = session(await json(await server.request(tmp.path, "/session", {})))
  const identity = {
    key: crypto.randomUUID(),
    box: "prompt:default",
    workspace: tmp.path,
    projectID: created.projectID,
    pendingID: crypto.randomUUID(),
  }
  const body = { identity, content, mutation: crypto.randomUUID() }
  const first = await server.request(tmp.path, "/kilocode/composer-drafts/save", body)
  expect(first.status).toBe(200)
  const saved = entry(await json(first)).entry
  expect(saved.content).toEqual(content)
  const alias = path.join(links.path, "workspace")
  await symlink(tmp.path, alias, process.platform === "win32" ? "junction" : "dir")
  expect(
    entry(
      await json(
        await server.request(tmp.path, "/kilocode/composer-drafts/save", {
          ...body,
          identity: { ...identity, workspace: alias },
        }),
      ),
    ).entry,
  ).toEqual(saved)
  await disposeAllInstances()
  expect(entry(await json(await server.request(tmp.path, "/kilocode/composer-drafts/save", body))).entry).toEqual(saved)
  expect(
    loaded(await json(await server.request(tmp.path, "/kilocode/composer-drafts/load", { identity }))).entry,
  ).toEqual(saved)
  const page = listed(
    await json(
      await server.request(tmp.path, "/kilocode/composer-drafts/list", {
        scope: { workspace: tmp.path, projectID: created.projectID, box: identity.box },
      }),
    ),
  )
  expect(
    page.entries.some(
      (value) => value.identity.pendingID === identity.pendingID && value.token.revision === saved.token.revision,
    ),
  ).toBe(true)
  const target = {
    key: crypto.randomUUID(),
    box: identity.box,
    workspace: tmp.path,
    projectID: created.projectID,
    sessionID: created.id,
  }
  const move = { from: identity, to: target, source: saved.token, mutation: crypto.randomUUID() }
  const moved = promoted(await json(await server.request(tmp.path, "/kilocode/composer-drafts/promote", move)))
  expect(moved.source.content).toBeNull()
  expect(moved.target.content).toEqual(content)
  expect(promoted(await json(await server.request(tmp.path, "/kilocode/composer-drafts/promote", move)))).toEqual(moved)
  const clear = { identity: target, expected: moved.target.token, mutation: crypto.randomUUID() }
  const cleared = entry(await json(await server.request(tmp.path, "/kilocode/composer-drafts/clear", clear))).entry
  expect(cleared.content).toBeNull()
  expect(entry(await json(await server.request(tmp.path, "/kilocode/composer-drafts/clear", clear))).entry).toEqual(
    cleared,
  )
}, 60_000)

test("HTTP scope prevents cross-workspace, project, session and box discovery", async () => {
  await using first = await tmpdir({ git: true })
  await using second = await tmpdir({ git: true })
  const server = app()
  const own = session(await json(await server.request(first.path, "/session", {})))
  const foreign = session(await json(await server.request(second.path, "/session", {})))
  const identity = {
    key: crypto.randomUUID(),
    box: "prompt:default",
    workspace: first.path,
    projectID: own.projectID,
    pendingID: crypto.randomUUID(),
  }
  expect(
    (
      await server.request(first.path, "/kilocode/composer-drafts/save", {
        identity,
        content,
        mutation: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200)
  for (const route of ["load", "save", "clear"]) {
    const response = await server.request(second.path, `/kilocode/composer-drafts/${route}`, {
      identity,
      ...(route === "save" ? { content, mutation: crypto.randomUUID() } : {}),
      ...(route === "clear"
        ? { expected: { generation: crypto.randomUUID(), revision: 1 }, mutation: crypto.randomUUID() }
        : {}),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(content.text)
  }
  expect(
    (
      await server.request(first.path, "/kilocode/composer-drafts/load", {
        identity: { ...identity, projectID: foreign.projectID },
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await server.request(first.path, "/kilocode/composer-drafts/load", {
        identity: { ...identity, pendingID: undefined, sessionID: foreign.id },
      })
    ).status,
  ).toBe(400)
  expect(
    listed(
      await json(
        await server.request(first.path, "/kilocode/composer-drafts/list", {
          scope: { workspace: first.path, box: "other-pane" },
        }),
      ),
    ).entries,
  ).toEqual([])
  expect(
    listed(
      await json(
        await server.request(second.path, "/kilocode/composer-drafts/list", {
          scope: { workspace: second.path, box: identity.box },
        }),
      ),
    ).entries,
  ).toEqual([])
}, 60_000)

test("HTTP CAS admits one concurrent revision and stale acceptance clear cannot erase newer typing", async () => {
  await using tmp = await tmpdir({ git: true })
  const server = app()
  const identity = {
    key: crypto.randomUUID(),
    box: "prompt:default",
    workspace: tmp.path,
    pendingID: crypto.randomUUID(),
  }
  const seed = entry(
    await json(
      await server.request(tmp.path, "/kilocode/composer-drafts/save", {
        identity,
        content,
        mutation: crypto.randomUUID(),
      }),
    ),
  ).entry
  const responses = await Promise.all(
    ["first", "second"].map((text) =>
      server.request(tmp.path, "/kilocode/composer-drafts/save", {
        identity,
        content: { ...content, text, selection: undefined },
        expected: seed.token,
        mutation: crypto.randomUUID(),
      }),
    ),
  )
  expect(responses.map((value) => value.status).sort()).toEqual([200, 400])
  const before = loaded(
    await json(await server.request(tmp.path, "/kilocode/composer-drafts/load", { identity })),
  ).entry
  const stale = await server.request(tmp.path, "/kilocode/composer-drafts/clear", {
    identity,
    expected: seed.token,
    mutation: crypto.randomUUID(),
  })
  expect(stale.status).toBe(400)
  expect(await stale.json()).toMatchObject({ code: "conflict" })
  expect(
    loaded(await json(await server.request(tmp.path, "/kilocode/composer-drafts/load", { identity }))).entry,
  ).toEqual(before)
}, 60_000)

test("HTTP promotion racing a destination edit preserves the source when its target CAS loses", async () => {
  await using tmp = await tmpdir({ git: true })
  const server = app()
  const created = session(await json(await server.request(tmp.path, "/session", {})))
  const identity = {
    key: crypto.randomUUID(),
    box: "prompt:default",
    workspace: tmp.path,
    pendingID: crypto.randomUUID(),
  }
  const target = { ...identity, key: crypto.randomUUID(), pendingID: undefined, sessionID: created.id }
  const source = entry(
    await json(
      await server.request(tmp.path, "/kilocode/composer-drafts/save", {
        identity,
        content,
        mutation: "pending",
      }),
    ),
  ).entry
  const destination = entry(
    await json(
      await server.request(tmp.path, "/kilocode/composer-drafts/save", {
        identity: target,
        content: { ...content, text: "Destination draft" },
        mutation: "destination",
      }),
    ),
  ).entry
  const [move, edit] = await Promise.all([
    server.request(tmp.path, "/kilocode/composer-drafts/promote", {
      from: identity,
      to: target,
      source: source.token,
      target: destination.token,
      mutation: "move",
    }),
    server.request(tmp.path, "/kilocode/composer-drafts/save", {
      identity: target,
      expected: destination.token,
      content: { ...content, text: "New destination typing" },
      mutation: "edit",
    }),
  ])
  expect([move.status, edit.status].sort()).toEqual([200, 400])
  const pending = loaded(
    await json(await server.request(tmp.path, "/kilocode/composer-drafts/load", { identity })),
  ).entry
  const current = loaded(
    await json(await server.request(tmp.path, "/kilocode/composer-drafts/load", { identity: target })),
  ).entry
  if (move.status === 400) {
    expect(await move.json()).toMatchObject({ code: "conflict" })
    expect(pending).toEqual(source)
    expect(current?.content?.text).toBe("New destination typing")
    return
  }
  expect(await edit.json()).toMatchObject({ code: "conflict" })
  expect(pending?.content).toBeNull()
  expect(current?.content).toEqual(content)
}, 60_000)

test("malformed rich draft validation excludes actual values from HTTP errors and captured logs", async () => {
  await using tmp = await tmpdir({ git: true })
  const server = app()
  const secret = `draft-secret-${crypto.randomUUID()}`
  const identity = {
    key: crypto.randomUUID(),
    box: "prompt:default",
    workspace: tmp.path,
    pendingID: crypto.randomUUID(),
  }
  const malformed = await server.raw(
    tmp.path,
    "/kilocode/composer-drafts/save",
    JSON.stringify({ identity, content: { ...content, text: secret }, mutation: crypto.randomUUID() }).slice(0, -1),
  )
  expect(malformed.status).toBe(400)
  const rejected = await malformed.text()
  expect(rejected).not.toContain(secret)
  expect(JSON.parse(rejected)).toEqual({
    name: "BadRequest",
    data: { message: "Malformed JSON request body", kind: "Body" },
  })
  for (const invalid of [
    { ...content, text: { secret } },
    { ...content, comments: [{ origin: secret }] },
    { ...content, images: [{ ...content.images[0], mime: secret }] },
    { ...content, selection: { start: 5, end: 2 }, text: secret },
    { ...content, unexpected: secret },
  ]) {
    const response = await server.request(tmp.path, "/kilocode/composer-drafts/save", {
      identity,
      content: invalid,
      mutation: crypto.randomUUID(),
    })
    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).not.toContain(secret)
    expect(body).toContain('"code":"invalid"')
  }
  expect(
    listed(
      await json(
        await server.request(tmp.path, "/kilocode/composer-drafts/list", {
          scope: { workspace: tmp.path, box: identity.box },
        }),
      ),
    ).entries,
  ).toEqual([])
  const file = path.join(Global.Path.log, "opencode.log")
  expect(path.resolve(file).startsWith(path.resolve(os.tmpdir(), `opencode-test-data-${process.pid}`) + path.sep)).toBe(
    true,
  )
  const logs = await readFile(file, "utf8")
  expect(logs).toContain("composer draft schema rejection")
  expect(logs).not.toContain(secret)
}, 60_000)
