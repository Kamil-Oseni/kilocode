import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"
import { isDeepStrictEqual } from "node:util"

async function method() {
  const source = await readFile(path.resolve(import.meta.dir, "../../src/second-brain/host.ts"), "utf8")
  const tree = ts.createSourceFile("host.ts", source, ts.ScriptTarget.Latest, true)
  const owner = tree.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "BrainHost")
  if (!owner || !ts.isClassDeclaration(owner)) throw new Error("Actual BrainHost required")
  const value = owner.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(tree) === "confirmCapture",
  )
  if (!value || !ts.isMethodDeclaration(value) || !value.body) throw new Error("Actual capture confirmation required")
  const compiled = ts.transpileModule(`async function run(result, turn) ${value.body.getText(tree)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function(
    "vscode",
    "admission",
    "descriptor",
    "currentPolicy",
    "freshHistory",
    "isDeepStrictEqual",
    compiled + ";return run",
  )
}

async function fixture(stage?: "sync" | "selection" | "confirmation" | "start") {
  const original = { capture: "original", policySHA: "a".repeat(64) }
  const policy = "b".repeat(64)
  const calls: string[] = []
  const state = { changed: false }
  const successor = { ...original }
  // Picker/resource/service responses are controlled boundaries. The production
  // host method executes unchanged; this is routing coverage, not native qualification.
  const run = (await method())(
    { workspace: { isTrusted: true }, window: { showWarningMessage: async () => "Index recovered save" } },
    async () => calls.push("admission"),
    () => ({ python: {} }),
    (value: typeof original) => {
      expect(value.policySHA).toBe(original.policySHA)
      return policy
    },
    async (value: typeof original) => {
      calls.push("fresh")
      if (state.changed && (stage !== "start" || value === original))
        throw new Error("Original capture revision changed")
    },
    isDeepStrictEqual,
  )
  const host = {
    context: { extensionPath: "controlled-source-only" },
    closing: false,
    settings: {
      load: async () => ({ managed: {} }),
      reviewCapture: async () => (stage === "start" ? successor : original),
    },
    control: {
      sync: async (
        confirm: (value: { digest: string; text: string }) => Promise<boolean>,
        body: (expected: string, signal: AbortSignal, close: () => Promise<void>) => Promise<void>,
      ) => {
        calls.push("review")
        expect(await confirm({ digest: policy, text: "Controlled current policy" })).toBe(true)
        await body(policy, new AbortController().signal, async () => undefined)
      },
    },
    service: {
      sync: async (expected: string) => {
        expect(expected).toBe(policy)
        calls.push("sync")
        if (stage === "sync" || stage === "start") state.changed = true
      },
      captureSelection: async (_signal: AbortSignal, expected: string) => {
        expect(expected).toBe(policy)
        calls.push("selection")
        if (stage === "selection") state.changed = true
        return { digest: policy }
      },
      captureCurrent: () => true,
      configure: async (body: () => Promise<void>) => body(),
    },
    intake: {
      confirmRecovery: async (value: typeof original, binding: { digest: string }, check: () => void) => {
        expect(value).toBe(stage === "start" ? successor : original)
        expect(value.policySHA).toBe("a".repeat(64))
        expect(binding.digest).toBe(policy)
        check()
        calls.push("confirmation")
        if (stage === "confirmation") state.changed = true
      },
    },
  }
  return { run: () => run.call(host, original, {}), calls }
}

test("actual recovered-capture host indexes current private policy and preserves original historical policy", async () => {
  const value = await fixture()
  expect(await value.run()).toBe(true)
  expect(value.calls.filter((item) => ["sync", "selection", "confirmation"].includes(item))).toEqual([
    "sync",
    "selection",
    "confirmation",
  ])
})

test("actual recovered-capture host refuses revision drift after each asynchronous effect boundary", async () => {
  for (const stage of ["sync", "selection", "confirmation"] as const) {
    const value = await fixture(stage)
    await expect(value.run()).rejects.toThrow("Original capture revision changed")
    if (stage === "sync") expect(value.calls).not.toContain("selection")
    if (stage !== "confirmation") expect(value.calls).not.toContain("confirmation")
  }
})

test("actual recovered-capture host replaces its stale review only after qualified self-start re-review", async () => {
  const value = await fixture("start")
  expect(await value.run()).toBe(true)
  expect(value.calls.filter((item) => ["sync", "selection", "confirmation"].includes(item))).toEqual([
    "sync",
    "selection",
    "confirmation",
  ])
})
