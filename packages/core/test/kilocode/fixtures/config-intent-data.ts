import assert from "node:assert/strict"
import { chmod, mkdir, link, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { ConfigIntent } from "../../../src/kilocode/config-intent"
export async function prepare(root: string, mode: string) {
  const global = path.join(root, "config", "kilo")
  const workspace = path.join(root, "workspace")
  await Promise.all([
    mkdir(global, { recursive: true }),
    mkdir(workspace),
    mkdir(path.join(root, "state", "kilo"), { recursive: true }),
    mkdir(path.join(root, "data", "kilo"), { recursive: true }),
  ])
  const first = path.join(global, "kilo.json")
  const last = path.join(workspace, "kilo.jsonc")
  const schema = mode.startsWith("v1-schema") ? {} : { $schema: "https://app.kilo.ai/config.json" }
  await writeFile(
    first,
    JSON.stringify({
      ...schema,
      model: "provider/global",
      ...(mode === "v1-schema-refused" ? { permission: "deny" } : {}),
    }),
  )
  const document =
    "// café 日本語 😀\n" +
    JSON.stringify({
      ...schema,
      model: "provider/project",
      ...(mode === "v2-unknown" ? { unknown_field: "SYNTHETIC_SECRET_SENTINEL" } : {}),
    })
  if (mode !== "v2-alias") await writeFile(last, document)
  if (mode === "v2-alias") {
    const target = path.join(root, "actual.jsonc")
    await writeFile(target, document)
    await link(target, last)
  }
  await writeFile(path.join(root, "explicit.json"), JSON.stringify({ ...schema, model: "provider/explicit" }))
  if (mode === "v1-schema-refused") await chmod(first, 0o400)

  return { global, workspace, first, last, schema }
}
export async function verify(root: string, mode: string, cfg: Awaited<ReturnType<typeof prepare>>) {
  const { workspace, first, last, schema } = cfg
  const policy = { version: 1 as const, directories: [root], files: [] }
  if (mode === "v1-schema-refused") {
    assert(!(await readFile(first, "utf8")).includes('"$schema"'))
    await assert.rejects(ConfigIntent.observe(policy), /uncertain/)
    return
  }
  if (mode === "v2-unknown" || mode === "v2-alias" || mode === "v1-virtual") {
    await assert.rejects(ConfigIntent.observe(policy), mode === "v2-unknown" ? /unsupported safe fields/ : /uncertain/)
    return
  }
  const evidence = await ConfigIntent.observe(policy)
  const graph = evidence.find((item) => item.parser === mode.slice(0, 2) && item.documents.length > 0)
  assert(graph)
  assert.deepEqual(
    graph.documents.map((item) => item.path),
    mode.startsWith("v2") ? [first, last] : [first, path.join(root, "explicit.json"), last],
  )
  assert.equal(graph.documents.at(-1)?.safe.model, "provider/project")
  assert(graph.documents.every((item) => item.digest.length === 64))
  if (mode === "v1-schema") {
    for (const file of [first, path.join(root, "explicit.json"), last]) {
      const text = await readFile(file, "utf8")
      assert(text.includes('"$schema"'))
      const document = graph.documents.find((document) => document.path === file)
      assert(document && document.bytes === Buffer.byteLength(text))
    }
  }
  assert(Object.isFrozen(graph.documents[0].safe))
  if (mode === "v2-two") {
    assert.equal(evidence.length, 2)
    assert.notEqual(evidence[0].graph, evidence[1].graph)
    assert.notEqual(evidence[0].roots.data, evidence[1].roots.data)
    assert.equal(evidence[1].documents[0].safe.model, "provider/second")
  }
  await assert.rejects(ConfigIntent.observe({ version: 1, directories: [workspace], files: [] }), /policy/)
  const alias = path.join(root, "late-alias.jsonc")
  await link(last, alias)
  await assert.rejects(ConfigIntent.observe(policy), /changed after parsing/)
  await unlink(alias)
  await writeFile(last, JSON.stringify({ ...schema, model: "provider/changed" }))
  await assert.rejects(ConfigIntent.observe(policy), /changed after parsing/)
}
