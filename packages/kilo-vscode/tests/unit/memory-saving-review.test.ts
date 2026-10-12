import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import ts from "typescript"

async function method() {
  const source = await readFile(path.resolve(import.meta.dir, "../../src/second-brain/host.ts"), "utf8")
  const tree = ts.createSourceFile("host.ts", source, ts.ScriptTarget.Latest, true)
  const owner = tree.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "BrainHost")
  if (!owner || !ts.isClassDeclaration(owner)) throw new Error("Actual BrainHost required")
  const member = owner.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(tree) === "captureState",
  )
  if (!member || !ts.isMethodDeclaration(member) || !member.body)
    throw new Error("Actual saving-control method required")
  const code = ts.transpileModule(`async function run(row, project, signal, guard) ${member.body.getText(tree)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  return new Function("vscode", "isDeepStrictEqual", `${code};return run`) as (
    vscode: object,
    equal: typeof isDeepStrictEqual,
  ) => (this: object, row: object, project: string, signal: AbortSignal, guard: () => void) => Promise<unknown>
}

test("actual resume dismissal refuses changed scope or consent and reads the current original effect status", async () => {
  const factory = await method()
  for (const change of ["binding", "consent", "status"] as const) {
    const modal = Promise.withResolvers<string | undefined>()
    const shown = Promise.withResolvers<void>()
    const cfg = { enabled: false, root: "/notes", release: "a".repeat(64) }
    const state = { current: true, cfg, status: "paused" }
    // This executes the production method unchanged with a held native-modal boundary.
    // It verifies source behavior; it does not claim native installed acceptance.
    const run = factory(
      {
        window: {
          showWarningMessage: () => {
            shown.resolve()
            return modal.promise
          },
        },
      },
      isDeepStrictEqual,
    )
    const host = {
      closing: false,
      service: {
        captureSelection: async () => ({ index: "synced" }),
        captureCurrent: () => state.current,
        captureSnapshot: () => ({}),
      },
      intake: {
        saved: () => state.cfg,
        snapshot: () => ({ status: state.status }),
        enabled: () => state.cfg.enabled,
      },
      saveCapture: async () => {
        throw new Error("Dismissal must not publish consent")
      },
    }
    const job = run.call(
      host,
      { action: "captureState", mode: "resume" },
      "/project",
      new AbortController().signal,
      () => {},
    )
    await shown.promise
    if (change === "binding") state.current = false
    if (change === "consent") state.cfg = { ...cfg, enabled: true }
    if (change === "status") state.status = "uncertain"
    modal.resolve(undefined)
    if (change !== "status") await expect(job).rejects.toThrow("Original Memory preference changed during review")
    if (change === "status") expect(await job).toMatchObject({ enabled: false, capture: "uncertain", changed: false })
  }
})
