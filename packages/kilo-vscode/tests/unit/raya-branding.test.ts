// raya_change - keep inherited product copy out of Raya's customer-facing boundaries
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { SETUP_SCRIPT_TEMPLATE, SETUP_SCRIPT_TEMPLATE_POWERSHELL } from "../../src/agent-manager/setup-script-template"
import { createKiloFallbackProvider } from "../../src/shared/provider-model"

const root = path.join(import.meta.dir, "../..")
const read = (file: string) => Bun.file(path.join(root, file)).text()

describe("Raya branding boundary", () => {
  test("uses Raya marketplace metadata and setting descriptions", async () => {
    const pkg = JSON.parse(await read("package.json")) as {
      name: string
      displayName: string
      description: string
      contributes?: { configuration?: unknown }
    }
    const visible = JSON.stringify({
      displayName: pkg.displayName,
      description: pkg.description,
      configuration: pkg.contributes?.configuration,
    })

    expect(pkg.name).toBe("raya")
    expect(pkg.displayName).toBe("Raya")
    expect(visible).not.toMatch(/\bKilo\b/)
  })

  test("publishes Raya descriptions without changing package identities", async () => {
    const files = [
      "../kilo-gateway/package.json",
      "../kilo-indexing/package.json",
      "../kilo-memory/package.json",
      "../kilo-sandbox/package.json",
      "../kilo-telemetry/package.json",
      "../plugin-atomic-chat/package.json",
    ]
    const packages = await Promise.all(
      files.map(async (file) => JSON.parse(await read(file)) as { name: string; description: string }),
    )

    expect(packages.every((pkg) => pkg.name.startsWith("@kilocode/"))).toBe(true)
    expect(packages.every((pkg) => pkg.description.includes("Raya"))).toBe(true)
    expect(packages.some((pkg) => /\bKilo(?: Code| CLI| Gateway)?\b/.test(pkg.description))).toBe(false)
  })

  test("identifies every model-facing system prompt as Raya", async () => {
    const dir = path.join(root, "../opencode/src")
    const files = [
      "session/prompt/default.txt",
      "session/prompt/anthropic.txt",
      "session/prompt/beast.txt",
      "session/prompt/codex.txt",
      "session/prompt/gemini.txt",
      "session/prompt/gpt.txt",
      "session/prompt/kilocode-gpt-5.5.txt",
      "session/prompt/kimi.txt",
      "session/prompt/ling.txt",
      "session/prompt/meta.txt",
      "kilocode/soul.txt",
      "kilocode/session/native-plan-prompt.txt",
      "kilocode/review/review.txt",
    ]
    const prompts = await Promise.all(files.map((file) => Bun.file(path.join(dir, file)).text()))

    expect(prompts.every((prompt) => prompt.includes("You are Raya"))).toBe(true)
    expect(prompts.some((prompt) => /You are Kilo(?: Code)?/.test(prompt))).toBe(false)
  })

  test("reads current settings and sanitizes inherited translations in every locale", async () => {
    const files = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root, absolute: true })]
    const sources = await Promise.all(files.map((file) => Bun.file(file).text()))
    const language = await read("webview-ui/src/context/language.tsx")

    expect(sources.some((source) => /getConfiguration\((?:["'`])kilo-code\.new/.test(source))).toBe(false)
    expect(language).toContain('replace(/\\bKilo Code\\b|\\bKilo\\b/g, "Raya")')
  })

  test("ships Raya-only marketplace documentation", async () => {
    expect(await read("README.md")).toMatch(/^<!-- raya_change[\s\S]*\n# Raya/m)
    expect(await read("CHANGELOG.md")).toContain("# Raya changelog")
  })

  test("uses Raya identity throughout Changes editor chrome", async () => {
    const sources = await Promise.all([
      read("src/DiffVirtualProvider.ts"),
      read("src/diff/DiffViewerProvider.ts"),
      read("webview-ui/diff-viewer/DiffEndMarker.tsx"),
      read("webview-ui/agent-manager/agent-manager.css"),
    ])
    const visible = sources.join("\n")

    expect(visible).not.toContain("kilo-light.svg")
    expect(visible).not.toContain("kilo-dark.svg")
    expect(visible).not.toContain("kiloman")
    expect(visible).toContain("eden-logo-light.svg")
  })

  test("uses Raya identity in host guidance, task chrome, diagnostics, and configured-reference prompts", async () => {
    const files = [
      "src/agent-manager/AgentManagerProvider.ts",
      "src/agent-manager/project/messages.ts",
      "src/agent-manager/run/task.ts",
      "src/speech-to-text/capture.ts",
      ["../opencode/src/ki", "locode/indexing.ts"].join(""),
      "../opencode/src/agent/agent.ts",
    ]
    const sources = await Promise.all(files.map(read))
    const visible = sources.join("\n")
    const legacy = ["Ki", "lo"].join("")

    expect(visible).toContain('createOutput("Raya Agent Manager")')
    expect(visible).toContain('"Raya",\n    proc')
    expect(visible).toContain("Raya Settings > Experimental")
    expect(visible).toContain("reinstall Raya")
    expect(visible).toContain("project in Raya Settings")
    expect(visible).toContain("Raya materializes this configured repository")
    expect(sources[0]).not.toContain(`createOutput("${legacy} Agent Manager")`)
    expect(sources[1]).not.toContain(`${legacy} Settings > Experimental`)
    expect(sources[2]).not.toContain(`"${legacy} Code",\n    proc`)
    expect(sources[3]).not.toContain(`reinstall ${legacy} Code`)
    expect(sources[4]).not.toContain(`project in ${legacy} Settings`)
    expect(sources[5]).not.toContain(`${legacy} materializes this configured repository`)
  })

  test("labels managed messaging as Raya Messenger without changing its routes", async () => {
    const pkg = await read("package.json")
    const commands = pkg.match(/"command": "raya(?:\.sidebarTitle)?\.kiloClawOpen",\s*"title": "Raya Messenger"/g) ?? []
    const provider = await read("src/kiloclaw/KiloClawProvider.ts")
    const main = [...new Bun.Glob("webview-ui/src/i18n/*.ts").scanSync({ cwd: root, absolute: true })]
    const messenger = [...new Bun.Glob("webview-ui/kiloclaw/i18n/*.ts").scanSync({ cwd: root, absolute: true })]
    const locales = await Promise.all([...main, ...messenger].map((file) => Bun.file(file).text()))

    expect(commands).toHaveLength(2)
    expect(provider).toContain('"raya.KiloClawPanel"')
    expect(provider).toContain('"Raya Messenger"')
    expect(provider).not.toContain('"KiloClaw"')
    expect(locales.some((source) => /:\s*"[^"]*KiloClaw/.test(source))).toBe(false)
    expect(locales.some((source) => source.includes("Raya Messenger"))).toBe(true)
  })

  test("projects the managed provider as Raya Gateway at rendered boundaries", async () => {
    const files = [
      "src/services/autocomplete/AutocompleteStatusBar.ts",
      "src/speech-to-text/catalog.ts",
      "webview-ui/src/components/profile/ProviderUsageCards.tsx",
      "webview-ui/src/components/settings/ProviderSelectDialog.tsx",
      "webview-ui/src/components/settings/ProvidersTab.tsx",
      "webview-ui/src/components/settings/provider-visibility.ts",
      "webview-ui/src/context/model-usage.ts",
      "webview-ui/src/context/provider-utils.ts",
    ]
    const sources = await Promise.all(files.map(read))
    const visible = sources.join("\n")

    expect(visible).not.toContain('"Kilo Gateway"')
    expect(visible).toContain("RAYA_GATEWAY_NAME")
    const model = await read("src/shared/provider-model.ts")
    expect(createKiloFallbackProvider().name).toBe("Raya Gateway")
    expect(model).toContain('KILO_PROVIDER_ID = "kilo"')
    expect(model).toContain("name: RAYA_GATEWAY_NAME")
    expect(model).not.toContain('name: "Kilo Gateway"')
  })

  test("labels managed indexing fields as provided by Raya", async () => {
    const source = await read("webview-ui/src/components/settings/IndexingTab.tsx")

    expect(source).toContain('"Provided by Raya"')
    expect(source).not.toContain(["Provided by Ki", "lo"].join(""))
    expect(source).toContain('selectedProvider() === "kilo"')
  })

  test("labels the profile subscription card as Raya Pass", async () => {
    const source = await read("webview-ui/src/components/profile/ProviderUsageCards.tsx")

    expect(source).toContain("Raya Pass")
    expect(source).not.toContain(["Ki", "lo Pass"].join(""))
  })

  test("stores current Raya product names in every app locale", async () => {
    const files = [...new Bun.Glob("webview-ui/src/i18n/*.ts").scanSync({ cwd: root, absolute: true })]
    const source = (await Promise.all(files.map((file) => Bun.file(file).text()))).join("\n")

    expect(source).toContain("Raya Gateway")
    expect(source).toContain("Raya Cloud")
    expect(source).toContain("Raya Pass")
    expect(source).not.toContain("Kilo Gateway")
    expect(source).not.toContain("Kilo Cloud")
    expect(source).not.toContain("Kilo Pass")
  })

  test("stores Raya identity in extension locale values without renaming compatibility keys", async () => {
    const patterns = [
      "webview-ui/src/i18n/*.ts",
      "webview-ui/agent-manager/i18n/*.ts",
      "webview-ui/kiloclaw/i18n/*.ts",
      "src/services/i18n/autocomplete/*.ts",
      "src/services/cli-backend/i18n/*.ts",
    ]
    const files = patterns.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root, absolute: true })])
    const sources = await Promise.all(files.map((file) => Bun.file(file).text()))
    const values = sources
      .flatMap((source) => source.split(/\r?\n/))
      .map((line) => (/^\s*"[^"]+"\s*:/.test(line) ? line.slice(line.indexOf(":") + 1) : line))
      .join("\n")

    expect(values).toContain("Raya")
    expect(values).not.toMatch(/\bKilo(?: Code)?\b/)
    expect(sources.some((source) => source.includes('"settings.aboutKiloCode.title"'))).toBe(true)
    expect(sources.some((source) => source.includes("kilo.jsonc"))).toBe(true)
  })

  test("presents Raya in webview providers, diagnostics, and visual fixtures", async () => {
    const indexing = await read("webview-ui/src/components/settings/IndexingTab.tsx")
    const diagnosticFiles = [
      "src/**/*.ts",
      "src/**/*.tsx",
      "webview-ui/src/**/*.ts",
      "webview-ui/src/**/*.tsx",
    ].flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root, absolute: true })])
    const diagnostics = await Promise.all(diagnosticFiles.map((file) => Bun.file(file).text()))
    const stories = await Promise.all(
      [
        "webview-ui/src/stories/StoryProviders.tsx",
        "webview-ui/src/stories/chat.stories.tsx",
        "webview-ui/src/stories/marketplace.stories.tsx",
        "webview-ui/src/stories/profile.stories.tsx",
        "webview-ui/src/stories/settings.stories.tsx",
        "webview-ui/src/stories/shared.stories.tsx",
        "webview-ui/src/stories/tool-call-lab.stories.tsx",
      ].map(read),
    )
    const logs = diagnostics.join("\n")
    const fixtures = stories.join("\n")

    expect(indexing).toContain('{ value: "kilo", label: "Raya" }')
    expect(indexing).not.toContain('{ value: "kilo", label: "Kilo" }')
    expect(logs).toContain("[Raya]")
    expect(logs).not.toContain("[Kilo New]")
    expect(logs).not.toContain("[Kilo]")
    expect(logs).toContain("[Raya] Provider:")
    expect(logs).not.toContain("[Raya] KiloProvider:")
    expect(logs).toContain("export class KiloProvider")
    expect(logs).toContain("Raya found ${describe(item)}")
    expect(logs).not.toContain("Kilo found ${describe(item)}")
    expect(logs).toContain("Raya sandbox mutation worker not found")
    expect(fixtures).toContain('name: "Raya Gateway"')
    expect(fixtures).toContain('providerName: "Raya"')
    expect(fixtures).not.toContain('name: "Kilo Gateway"')
    expect(fixtures).not.toContain('providerName: "Kilo"')
    expect(fixtures).toContain("Kilo-Org/kilocode")
  })

  test("uses Raya in remote status, memory, and MCP recovery copy", async () => {
    const remote = [...new Bun.Glob("src/services/cli-backend/i18n/*.ts").scanSync({ cwd: root, absolute: true })]
    const locales = [...new Bun.Glob("webview-ui/src/i18n/*.ts").scanSync({ cwd: root, absolute: true })]
    const sources = await Promise.all(remote.map((file) => Bun.file(file).text()))
    const memory = await Promise.all(locales.map((file) => Bun.file(file).text()))
    const status = await read("src/services/RemoteStatusService.ts")
    const oauth = await read("src/kilo-provider/mcp-oauth.ts")
    const host = await read("src/kilo-provider/memory.ts")
    const labeled = sources.filter((source) => source.includes('"remote.connected"'))

    expect(labeled).toHaveLength(21)
    expect(labeled.every((source) => source.includes("Raya Remote"))).toBe(true)
    expect(sources.some((source) => source.includes("Kilo Remote"))).toBe(false)
    expect(status).toContain('"$(radio-tower) Raya Remote"')
    expect(status).not.toContain('"$(radio-tower) Kilo Remote"')
    expect(memory.some((source) => source.includes("after you use Kilo"))).toBe(false)
    expect(memory.some((source) => source.includes("after you use Raya"))).toBe(true)
    expect(host).toContain("after you use Raya")
    expect(oauth).toContain("Check the Raya logs for the authentication URL")
    expect(oauth).not.toContain("Check the Kilo logs for the authentication URL")
  })

  test("brands generated worktree setup scripts as Raya", () => {
    const scripts = [SETUP_SCRIPT_TEMPLATE, SETUP_SCRIPT_TEMPLATE_POWERSHELL]

    for (const script of scripts) {
      expect(script).toContain("# Raya Worktree Setup Script")
      expect(script).toContain("# Raya already copies root-level .env and .env.* files")
      expect(script).not.toContain(["Ki", "lo"].join(""))
      expect(script).toContain("WORKTREE_PATH")
      expect(script).toContain("REPO_PATH")
    }
  })
})
