import assert from "node:assert/strict"
import { mkdir, writeFile, rename } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { ConfigIntent } from "@opencode-ai/core/kilocode/config-intent"
import { sourceScopes, closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { ConfigCommand } from "../../../src/config/command"
import { ConfigAgent } from "../../../src/config/agent"
import { ConfigMarkdown } from "../../../src/config/markdown"
const [root, mode] = process.argv.slice(2)
assert(root && path.isAbsolute(root))
for (const dir of Object.values(Global.Path)) if (typeof dir === "string") await mkdir(dir, { recursive: true })
for (const kind of ["commands", "agents", "modes"]) await mkdir(path.join(root, kind), { recursive: true })
const command = path.join(root, "commands", "hello.md")
await writeFile(
  command,
  "---\ndescription: Say hello: café\nmodel: synthetic/local\n---\nKeep this café 日本語 😀 instruction inert.\n",
)
await writeFile(
  path.join(root, "agents", "helper.md"),
  "---\ndescription: Helpful\npermission: allow\noptions:\n  apiKey: SYNTHETIC_MARKDOWN_PRIVATE\n---\nLoaded value {env:RAYA_MARKDOWN_PRIVATE}\n",
)
await writeFile(path.join(root, "modes", "review.md"), "---\ncolor: accent\n---\nReview Unicode café 日本語 😀\n")
const graph = ConfigIntent.graph("v1", Global.Path, root)
if (mode === "overflow") {
  for (let index = 0; index < 256; index++)
    await writeFile(path.join(root, "commands", `extra${index}.md`), "Review only")
  const result = await ConfigIntent.track(graph, () => ConfigCommand.load(root, [], true, undefined, undefined, graph))
  assert.equal(Object.keys(result).length, 257)
} else if (mode === "lifecycle") {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const task = ConfigIntent.track(graph, async () => {
    const md = await ConfigMarkdown.parse(command, { trusted: true, intent: graph })
    started.resolve()
    await release.promise
    ConfigIntent.acceptMarkdown(graph, md, "command", "hello", true)
  })
  await started.promise
  const closed = ConfigIntent.retire()
  await assert.rejects(
    ConfigIntent.track(graph, () => ConfigCommand.load(root)),
    /terminal/,
  )
  assert.throws(() => ConfigIntent.snapshot(), /incomplete/)
  release.resolve()
  await task
  await closed
  assert.equal(ConfigIntent.snapshot()[0].markdown.length, 1)
} else {
  const commands = await ConfigIntent.track(graph, () =>
    ConfigCommand.load(root, [], true, undefined, undefined, graph),
  )
  const agents = await ConfigIntent.track(graph, () => ConfigAgent.load(root, [], true, undefined, undefined, graph))
  const modes = await ConfigIntent.track(graph, () => ConfigAgent.loadMode(root, [], true, undefined, undefined, graph))
  assert.equal(commands.hello.template, "Keep this café 日本語 😀 instruction inert.")
  assert(agents.helper.prompt?.includes("SYNTHETIC_EXPANDED_PRIVATE"))
  assert.equal(modes.review.mode, "primary")
  const value = await ConfigIntent.observe({ version: 1, directories: [root], files: [] })
  assert.equal(value[0].markdown.length, 3)
  assert.deepEqual(
    value[0].markdown.map((item) => item.kind),
    ["command", "agent", "mode"],
  )
  assert(!JSON.stringify(value).includes("SYNTHETIC_EXPANDED_PRIVATE"))
  assert(!JSON.stringify(value).includes("SYNTHETIC_MARKDOWN_PRIVATE"))
  await rename(command, command + ".old")
  await writeFile(command, "same logical path, different native file")
  await assert.rejects(ConfigIntent.observe({ version: 1, directories: [root], files: [] }), /changed after parsing/)
}
await closeProcessProfile()
const scopes = sourceScopes()
assert.equal(scopes.version, 4)
assert.equal(scopes.configStatus, mode === "overflow" ? "overflow" : "complete")
if (mode === "overflow") assert.equal(scopes.configReason, "metadata-overflow")
console.log("MARKDOWN_INTENT_OK")
