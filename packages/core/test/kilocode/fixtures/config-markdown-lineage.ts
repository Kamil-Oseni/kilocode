import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import path from "node:path"
import { ConfigIntent } from "../../../src/kilocode/config-intent"

const [root, mode] = process.argv.slice(2)
const roots = { data: path.join(root, "data"), config: path.join(root, "config"), state: path.join(root, "state") }
await Promise.all(Object.values(roots).map((dir) => mkdir(dir, { recursive: true })))
const file = path.join(roots.config, "agent.md")
const texts = ["A", "B", "C"].map(
  (value) => `---\ndescription: Private ${value}\nmode: subagent\n---\n${value} café 日本語 😀`,
)
await writeFile(file, texts[0])
async function load() {
  const graph = ConfigIntent.graph("v2", roots, roots.config)
  const read = await ConfigIntent.readMarkdown(graph, file, () => readFile(file, "utf8"))
  const object = {}
  ConfigIntent.bindMarkdown(read.token, object)
  ConfigIntent.acceptMarkdown(graph, object, "agent", "private-agent", true)
  return graph
}
const first = await load()
const second = await load()
assert.notEqual(first.id, second.id)
const { inspect, publish, publication } = await import("../../../src/kilocode/markdown-publication")
const sum = (text: string) => Bun.CryptoHasher.hash("sha256", text, "hex")
async function write(text: string, target = file) {
  const ticket = ConfigIntent.reserveMarkdown(target)
  try {
    const before = await ticket.prepare()
    const receipt = await publish(target, text, before)
    await ticket.complete(receipt)
    return receipt
  } catch (err) {
    ticket.fail(err)
    throw err
  }
}
if (mode === "accepted") {
  const receipt = await write(texts[1])
  assert.equal(publication(receipt).after.digest, sum(texts[1]))
  await write(texts[2])
  const third = await load()
  const fresh = path.join(roots.config, "unloaded.md")
  await write(texts[1], fresh)
  await ConfigIntent.retire()
  const graphs = ConfigIntent.snapshot()
  for (const id of [first.id, second.id]) {
    const graph = graphs.find((value) => value.graph === id)
    assert(graph)
    const current = graph.markdown[0]
    assert.equal(current.digest, sum(texts[2]))
    assert.equal(current.order, 0)
    assert.equal(current.kind, "agent")
    assert.equal(current.name, "private-agent")
    assert.deepEqual(
      current.history?.map((value) => value.digest),
      texts.slice(0, 2).map(sum),
    )
    assert(Object.isFrozen(current.history))
    assert.equal(current.history?.[0].order, 0)
    assert.equal(current.history?.[0].trusted, true)
  }
  const graph = graphs.find((value) => value.graph === third.id)
  assert(graph)
  assert.equal(graph.markdown[0].digest, sum(texts[2]))
  assert.equal(graph.markdown[0].history?.length ?? 0, 0)
}
if (mode === "concurrent") {
  const ticket = ConfigIntent.reserveMarkdown(file)
  assert.throws(() => ConfigIntent.reserveMarkdown(file))
  const before = await ticket.prepare()
  const receipt = await publish(file, texts[1], before)
  await ticket.complete(receipt)
  await assert.rejects(() => ticket.complete(receipt))
  await ConfigIntent.retire()
  assert.equal(ConfigIntent.snapshot()[0].markdown[0].digest, sum(texts[1]))
}
if (mode === "foreign") {
  const ticket = ConfigIntent.reserveMarkdown(file)
  await ticket.prepare()
  const other = path.join(roots.config, "other.md")
  await writeFile(other, texts[0])
  const receipt = await publish(other, texts[1], await inspect(other))
  await assert.rejects(() => ticket.complete(receipt))
  ticket.fail(new Error("Foreign publication refused"))
  await ConfigIntent.retire()
  assert.throws(() => ConfigIntent.snapshot())
  assert.equal(await readFile(file, "utf8"), texts[0])
}
if (mode === "external") {
  const ticket = ConfigIntent.reserveMarkdown(file)
  const before = await ticket.prepare()
  await writeFile(file, texts[2])
  await assert.rejects(() => publish(file, texts[1], before))
  ticket.fail(new Error("External predecessor refused"))
  await ConfigIntent.retire()
  assert.throws(() => ConfigIntent.snapshot())
  assert.equal(await readFile(file, "utf8"), texts[2])
}
if (mode === "io") {
  const dir = path.join(roots.config, "removed-parent")
  await mkdir(dir)
  const missing = path.join(dir, "agent.md")
  const ticket = ConfigIntent.reserveMarkdown(missing)
  const before = await ticket.prepare()
  await rename(dir, path.join(roots.config, "retained-parent"))
  const result = await publish(missing, texts[1], before).then(
    () => {
      throw new Error("Missing parent unexpectedly published")
    },
    (err) => err,
  )
  assert.equal(result.code, "ENOENT")
  ticket.fail(result)
  await ConfigIntent.retire()
  assert.throws(() => ConfigIntent.snapshot())
}
if (mode === "retire") {
  const ticket = ConfigIntent.reserveMarkdown(file)
  const before = await ticket.prepare()
  let settled = false
  const closing = ConfigIntent.retire().then(() => {
    settled = true
  })
  await Bun.sleep(25)
  assert.equal(settled, false)
  assert.throws(() => ConfigIntent.reserveMarkdown(file))
  const receipt = await publish(file, texts[1], before)
  await ticket.complete(receipt)
  await closing
  assert.equal(settled, true)
  assert.equal(ConfigIntent.snapshot()[0].markdown[0].digest, sum(texts[1]))
}
assert(
  [
    "accepted",
    "concurrent",
    "foreign",
    "external",
    "identity",
    "io",
    "retire",
    "predecessor",
    "unsupported",
    "oversized",
    "uncertain-identity",
    "interleaved",
    "postpublication",
    "history",
  ].includes(mode),
)
if (mode === "identity") {
  const ticket = ConfigIntent.reserveMarkdown(file)
  const before = await ticket.prepare()
  const replacement = path.join(roots.config, "replacement.md")
  await writeFile(replacement, texts[0])
  await rename(replacement, file)
  await assert.rejects(() => publish(file, texts[1], before))
  ticket.fail(new Error("Foreign same-byte physical replacement refused"))
  await ConfigIntent.retire()
  assert.throws(() => ConfigIntent.snapshot())
  assert.equal(await readFile(file, "utf8"), texts[0])
}
if (mode === "predecessor") {
  const ticket = ConfigIntent.reserveMarkdown(file)
  await ticket.prepare()
  const receipt = await publish(file, texts[1], await inspect(file))
  await assert.rejects(() => ticket.complete(receipt))
  ticket.fail(new Error("Foreign same-path predecessor refused"))
  await ConfigIntent.retire()
  assert.throws(() => ConfigIntent.snapshot())
}
if (mode === "unsupported" || mode === "oversized") {
  const text = mode === "unsupported" ? "---\ncustom_private_field: true\n---\nUnsupported B" : "B".repeat(1048577)
  await write(text)
  await write(texts[2])
  assert.equal(await readFile(file, "utf8"), texts[2])
  await ConfigIntent.retire()
  assert.throws(() => ConfigIntent.snapshot())
  await assert.rejects(() => ConfigIntent.observe({ version: 1, directories: [root], files: [] }))
}
if (mode === "uncertain-identity") {
  const text = "---\ncustom_private_field: true\n---\nUnsupported B"
  await write(text)
  const replacement = path.join(roots.config, "uncertain-replacement.md")
  await writeFile(replacement, text)
  await rename(replacement, file)
  await assert.rejects(() => write(texts[2]))
  assert.equal(await readFile(file, "utf8"), text)
  await ConfigIntent.retire()
  assert.throws(() => ConfigIntent.snapshot())
  await assert.rejects(() => ConfigIntent.observe({ version: 1, directories: [root], files: [] }))
}
if (mode === "interleaved") {
  const ticket = ConfigIntent.reserveMarkdown(file)
  const receipt = await publish(file, texts[1], await ticket.prepare())
  const third = await load()
  await ticket.complete(receipt)
  await ConfigIntent.retire()
  const graphs = ConfigIntent.snapshot()
  for (const id of [first.id, second.id]) {
    const graph = graphs.find((value) => value.graph === id)
    assert(graph)
    assert.equal(graph.markdown[0].digest, sum(texts[1]))
    assert.equal(graph.markdown[0].history?.[0].digest, sum(texts[0]))
  }
  const graph = graphs.find((value) => value.graph === third.id)
  assert(graph)
  assert.equal(graph.markdown[0].digest, sum(texts[1]))
  assert.equal(graph.markdown[0].history?.length ?? 0, 0)
}
if (mode === "postpublication") {
  const ticket = ConfigIntent.reserveMarkdown(file)
  const receipt = await publish(file, texts[1], await ticket.prepare())
  const replacement = path.join(roots.config, "postpublication-replacement.md")
  await writeFile(replacement, texts[1])
  await rename(replacement, file)
  await assert.rejects(() => ticket.complete(receipt))
  await ConfigIntent.retire()
  assert.throws(() => ConfigIntent.snapshot())
}
if (mode === "history") {
  for (let index = 1; index <= 65; index++) await write(`History ${index} café 日本語 😀`)
  await write(texts[2])
  assert.equal(await readFile(file, "utf8"), texts[2])
  await ConfigIntent.retire()
  assert.throws(() => ConfigIntent.snapshot())
  await assert.rejects(() => ConfigIntent.observe({ version: 1, directories: [root], files: [] }))
}
console.log("MARKDOWN_LINEAGE_PASS")
