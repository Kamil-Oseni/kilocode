import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Server } from "@/server/server"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { finish } from "@/kilocode/cli/finish"
import { DraftSchemas } from "@/kilocode/session/composer-codec"
import z from "zod"
import {
  ComposerDrafts,
  composerIdentity,
  composerOwner,
  type DraftBackend,
} from "../../../../kilo-vscode/src/kilo-provider/composer-drafts"
import type { ComposerDraftExtensionMessage } from "../../../../kilo-vscode/src/shared/composer-drafts-messages"

const directory = process.argv[2]
assert.ok(directory)
const expected = JSON.parse(await readFile(process.argv[3], "utf8"))
const edit = process.argv[4] === "edit"
const app = Server.Default().app
const headers = { "Content-Type": "application/json", "x-kilo-directory": directory }
// This is the extension's actual list request: exact directory and roots, without a path override.
const response = await app.request(`/session?directory=${encodeURIComponent(directory)}&roots=true`, { headers })
assert.equal(response.status, 200, await response.clone().text())
const sessions: unknown = await response.json()
assert.ok(Array.isArray(sessions))
assert.equal(sessions.length, 1)
assert.equal(sessions[0].id, "ses_f05b23418ffeEQa07t2IfPD0iw")
assert.equal(sessions[0].projectID, "6f8486f4b90d1fcdad44ea38ba2e2c60f4f89cb8")
const request = (operation: string, value: unknown, context = directory) =>
  app.request(`/kilocode/composer-drafts/${operation}?directory=${encodeURIComponent(context)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(value),
  })
const call = async (operation: string, value: unknown) => {
  const response = await request(operation, value)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
const entry = z.object({ entry: DraftSchemas.entry })
const backend: DraftBackend = {
  list: async (scope, cursor, limit) =>
    z
      .object({ entries: z.array(DraftSchemas.entry), cursor: z.string().optional() })
      .parse(await call("list", { scope, cursor, limit })),
  load: async (identity) => z.object({ entry: DraftSchemas.entry.nullable() }).parse(await call("load", { identity })),
  save: async (identity, expected, content, mutation) =>
    entry.parse(await call("save", { identity, expected, content, mutation })),
  clear: async (identity, expected, mutation) => entry.parse(await call("clear", { identity, expected, mutation })),
  promote: async (from, to, source, target, mutation) =>
    z
      .object({ source: DraftSchemas.entry, target: DraftSchemas.entry })
      .parse(await call("promote", { from, to, source, target, mutation })),
}
const project = z
  .object({ id: z.string() })
  .parse(
    await (await app.request(`/project/current?directory=${encodeURIComponent(directory)}`, { headers })).json(),
  ).id
const owner = composerOwner(directory, project)
const messages: ComposerDraftExtensionMessage[] = []
const host = new ComposerDrafts({
  backend: () => backend,
  generation: () => 1,
  owners: () => [{ box: "sidebar:new-task", owner }],
  post: (message) => messages.push(message),
  scope: (target) =>
    composerIdentity(target, {
      scopes: () => [{ box: "sidebar:new-task", directory }],
      current: () => true,
      ambiguous: () => false,
      project: async (workspace) =>
        z
          .object({ id: z.string() })
          .parse(
            await (
              await app.request(`/project/current?directory=${encodeURIComponent(workspace)}`, { headers })
            ).json(),
          ).id,
      session: async (id, workspace) =>
        z
          .object({ projectID: z.string(), directory: z.string() })
          .parse(
            await (await app.request(`/session/${id}?directory=${encodeURIComponent(workspace)}`, { headers })).json(),
          ),
    }),
  message: async (id, message, workspace) => {
    const entries = z
      .array(z.object({ info: z.object({ id: z.string(), role: z.string(), sessionID: z.string() }) }))
      .parse(
        await (
          await app.request(`/session/${id}/message?directory=${encodeURIComponent(workspace)}`, { headers })
        ).json(),
      )
    return entries.find((entry) => entry.info.id === message)?.info
  },
})
await host.handle({ type: "composerDraftPane", epoch: "actual-bridge", active: true })
await host.handle({
  type: "composerDraftList",
  box: "sidebar:new-task",
  owner,
  generation: 1,
  epoch: "actual-bridge",
  requestID: "catalog",
})
const catalogued = messages.at(-1)
assert.ok(catalogued?.type === "composerDraftResult" && !catalogued.error)
assert.equal(catalogued.entries?.length, 1)
const page = await request("list", {
  scope: { workspace: directory, projectID: "global", box: "sidebar:new-task" },
  limit: 100,
})
assert.equal(page.status, 200, await page.clone().text())
const catalog = await page.json()
assert.equal(catalog.entries.length, 1)
assert.equal(catalog.entries[0].identity.projectID, "global")
for (const name of ["pending", "session"]) {
  const prior = DraftSchemas.entry.parse(expected[name])
  const identity = {
    ...prior.identity,
    workspace: directory,
    projectID: name === "pending" ? "global" : prior.identity.projectID,
  }
  const response = await request("load", { identity })
  assert.equal(response.status, 200, await response.clone().text())
  const entry = DraftSchemas.entry.parse((await response.json()).entry)
  assert.equal(entry.content?.text, prior.content?.text + (edit ? "" : " edited"))
  assert.equal(entry.token.generation, prior.token.generation)
  assert.equal(entry.token.revision, prior.token.revision + (edit ? 0 : 1))
  await host.handle({
    type: "composerDraftLoad",
    identity,
    owner,
    generation: 1,
    epoch: "actual-bridge",
    requestID: `load-${name}`,
  })
  const hydrated = messages.at(-1)
  assert.ok(hydrated?.type === "composerDraftResult" && !hydrated.error)
  assert.deepEqual(hydrated.entry, entry)
  if (edit) {
    assert.ok(entry.content)
    const replay = await request("save", {
      identity,
      expected: entry.token,
      content: entry.content,
      mutation: prior.mutation,
    })
    assert.equal(replay.status, 400)
    await host.handle({
      type: "composerDraftSave",
      identity,
      expected: entry.token,
      content: { ...entry.content, text: entry.content.text + " edited" },
      mutation: `destination-${name}`,
      owner,
      generation: 1,
      epoch: "actual-bridge",
      requestID: `save-${name}`,
    })
    const saved = messages.at(-1)
    assert.ok(saved?.type === "composerDraftResult" && !saved.error)
    assert.equal(saved.entry?.token.revision, prior.token.revision + 1)
  }
  const wrong = await request("load", { identity: { ...identity, workspace: path.dirname(directory) } })
  assert.equal(wrong.status, 400)
}
const missing = await request("load", {
  identity: { ...expected.session.identity, workspace: directory, sessionID: "ses_f05b23418ffeEQa07t2IfPD0ix" },
})
assert.equal(missing.status, 400)
const wrong = await request("load", {
  identity: { ...expected.session.identity, workspace: directory, projectID: "global" },
})
assert.equal(wrong.status, 400)
host.dispose()
console.log("COMPOSER_HISTORY_HTTP_PASS")
await finish([
  async () => {
    if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
  },
])
