import assert from "node:assert/strict"
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { prepare } from "../../../../core/test/kilocode/fixtures/config-intent-data"
import { participantScopes } from "../../../src/kilocode/cli/profile-participants"
import { namespaceScopes } from "../../../src/kilocode/migration/profile-scope"
import { LineageIntent } from "@opencode-ai/core/kilocode/config-intent-schema"
import { ProfileRoots } from "@opencode-ai/core/kilocode/profile-roots"
import { withImage } from "@opencode-ai/core/kilocode/source-offline"
import { withWorking } from "../../../src/kilocode/migration/profile-image"
import { select } from "../../../src/kilocode/migration/profile-selection"
import { capture } from "../../../src/kilocode/migration/profile-config"

const [root, mode] = process.argv.slice(2)
assert.ok(root && (mode === "owned" || mode === "unowned"))
const cfg = await prepare(root, "v1")
await writeFile(
  cfg.first,
  JSON.stringify(
    {
      $schema: "https://app.kilo.ai/config.json",
      enabled_providers: [],
      permission: "deny",
      formatter: false,
      lsp: false,
    },
    null,
    2,
  ),
)
const before = await readFile(cfg.first, "utf8")
const executable = path.join(root, "raya-process-host.exe")
await copyFile(path.resolve(import.meta.dir, "../../../../core/native/kilocode/bin/raya-process-host.exe"), executable)
const digest = createHash("sha256")
  .update(await readFile(executable))
  .digest("hex")
const registry = await mkdtemp(`${root}-offline-`)
const { Server } = await import("../../../src/server/server")
const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
const { finish } = await import("../../../src/kilocode/cli/finish")
const app = Server.Default().app
const get = () =>
  app.request(`/config?directory=${encodeURIComponent(cfg.workspace)}`, {
    headers: { "x-kilo-directory": cfg.workspace },
  })
assert.equal((await get()).status, 200)
if (mode === "owned") {
  const response = await app.request("/global/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permission: { "*": "deny" } }),
  })
  assert.equal(response.status, 200)
  const current = await readFile(cfg.first, "utf8")
  assert.equal(Buffer.byteLength(current) - Buffer.byteLength(before), 15)
  assert.equal((await get()).status, 200)
} else {
  await writeFile(cfg.first, before.replace('"permission": "deny"', '"permission": "allow"'))
}
const publication = async () => {
  const value = participantScopes(true)
  const policy = { version: 1 as const, directories: [root], files: [] }
  const roots = ProfileRoots.snapshot()
  if (mode === "unowned") {
    await assert.rejects(namespaceScopes(value, roots, policy), /physical identity changed|bytes changed/)
    console.log("CONFIG_UNOWNED_REWRITE_REFUSED")
    return
  }
  const selected = await namespaceScopes(value, roots, policy)
  const graphs = selected.configs.filter((graph) => graph.documents.some((doc) => doc.path === cfg.first))
  assert.ok(graphs.length >= 2)
  const documents = graphs.flatMap((graph) =>
    LineageIntent.parse(graph).documents.filter((doc) => doc.path === cfg.first),
  )
  assert.ok(documents.some((doc) => doc.history?.some((old) => old.bytes === Buffer.byteLength(before))))
  const current = await readFile(cfg.first, "utf8")
  assert.ok(documents.every((doc) => doc.bytes === Buffer.byteLength(current)))
  assert.ok(documents.every((doc) => doc.excluded.some((field) => field.field === "permission")))
  assert.ok(value.version === 4)
  const data = value.globals[0].data
  const profile = {
    ...(await select({ database: process.env.KILO_DB!, data, storage: path.join(data, "storage") }, policy)),
    roots,
    globals: value.globals,
  }
  await withImage({ roots, policy, helper: { executable, digest }, registry }, (image) =>
    withWorking(image, profile, async (working) => {
      const evidence = await capture(working, selected.configs)
      assert.equal(evidence.version, 3)
      const held = evidence.graphs.flatMap((graph) =>
        LineageIntent.parse(graph).documents.filter((doc) => doc.path === cfg.first),
      )
      assert.ok(held.some((doc) => doc.history?.some((old) => old.bytes === Buffer.byteLength(before))))
      assert.ok(held.every((doc) => doc.bytes === Buffer.byteLength(current)))
      assert.equal(evidence.activation, "held")
      assert.equal(evidence.completeProfileCoverage, false)
    }),
  )
  console.log("CONFIG_OWNED_WRITE_CURRENT_AND_HISTORY_VERIFIED")
}
await finish(
  [
    async () => {
      if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
    },
  ],
  () =>
    publication().catch(async (err: unknown) => {
      await writeFile(
        `${root}/publication-failure.json`,
        JSON.stringify({
          type: err instanceof Error ? err.name : "unknown",
          message: err instanceof Error && /^(Configuration|Source)/.test(err.message) ? err.message : "assertion",
          frames: err instanceof Error ? err.stack?.split("\n").slice(1) : [],
        }),
      )
      throw err
    }),
)
