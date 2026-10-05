import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { ConfigIntent } from "@opencode-ai/core/kilocode/config-intent"
import { closeProcessProfile, sourceScopes } from "@opencode-ai/core/kilocode/process-profile"
import { ConfigCommand } from "../../../src/config/command"
import { ConfigAgent } from "../../../src/config/agent"
const root = process.argv[2]
assert(root && path.isAbsolute(root))
for (const dir of Object.values(Global.Path)) if (typeof dir === "string") await mkdir(dir, { recursive: true })
for (const kind of ["commands", "agents", "modes"]) await mkdir(path.join(root, kind), { recursive: true })
await writeFile(
  path.join(root, "commands/hello.md"),
  "---\ndescription: Review café\nmodel: synthetic/local\n---\nKeep café 日本語 😀 inert.\n",
)
await writeFile(
  path.join(root, "commands/private.md"),
  "---\ndescription: Literal review\n---\ntoken=SYNTHETIC_MARKDOWN_BODY_PRIVATE\n",
)
await writeFile(
  path.join(root, "agents/helper.md"),
  "---\ndescription: Helpful\npermission: allow\noptions:\n  apiKey: SYNTHETIC_MARKDOWN_OPTIONS_PRIVATE\n---\nLoaded {env:RAYA_MARKDOWN_PRIVATE}\n",
)
await writeFile(path.join(root, "modes/review.md"), "---\ncolor: accent\n---\nReview Unicode café 日本語 😀\n")
await writeFile(path.join(Global.Path.data, "unknown.md"), "unknown nonempty content remains unclassified")
const graph = ConfigIntent.graph("v1", Global.Path, root)
const commands = await ConfigIntent.track(graph, () => ConfigCommand.load(root, [], true, undefined, undefined, graph))
const agents = await ConfigIntent.track(graph, () => ConfigAgent.load(root, [], true, undefined, undefined, graph))
const modes = await ConfigIntent.track(graph, () => ConfigAgent.loadMode(root, [], true, undefined, undefined, graph))
assert.equal(commands.hello.template, "Keep café 日本語 😀 inert.")
assert(agents.helper.prompt?.includes("SYNTHETIC_MARKDOWN_EXPANDED_PRIVATE"))
assert.equal(modes.review.mode, "primary")
await ConfigIntent.track(graph, () => ConfigCommand.load(root, [], true, undefined, undefined, graph))
await ConfigIntent.retire()
await closeProcessProfile()
const scopes = sourceScopes()
assert.equal(scopes.version, 4)
assert("configs" in scopes && scopes.configStatus === "complete")
assert.equal(scopes.configs.flatMap((item) => ("markdown" in item ? item.markdown : [])).length, 6)
await writeFile(path.join(root, "scope-proof.json"), JSON.stringify(scopes))
console.log("LOADED_MARKDOWN_SCOPE_READY")
