import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as vscode from "vscode"
import { stop } from "esbuild-wasm"
import { CanvasCompiler, type CanvasBuild } from "../../src/services/canvas/canvas-compiler"
import { recover } from "../../src/services/canvas/canvas-recovery"

const dirs: string[] = []
afterAll(stop)
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "raya-recovery-"))
  dirs.push(root)
  const compiler = new CanvasCompiler(join(root, "bundles"))
  const first = await compiler.create(root, "report", "export default function Report() { return <p>Saved</p> }", {
    value: 1,
  })
  await compiler.commit(first)
  const build = await compiler.update(root, "report", {
    source: "export default function Broken( {",
    data: { value: 2 },
  })
  return { root, compiler, first, build }
}

test("keeping the previous version leaves the working artifact intact", async () => {
  const state = await fixture()
  const choice = spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Keep previous version" as never)
  let rendered = false
  try {
    await recover({
      ...state,
      previous: true,
      current: () => true,
      render: async (build) => {
        rendered = true
        return build
      },
    })
    expect(rendered).toBe(false)
    expect((await state.compiler.restore(state.root, "report"))?.revision).toBe(state.first.revision)
  } finally {
    choice.mockRestore()
  }
})

test("inspection opens the failed draft and retry uses its edited source and data", async () => {
  const state = await fixture()
  const choice = spyOn(vscode.window, "showWarningMessage")
    .mockResolvedValueOnce("Inspect draft" as never)
    .mockResolvedValueOnce("Retry" as never)
  const opened: string[] = []
  const command = spyOn(vscode.commands, "executeCommand").mockImplementation(async (_command, ...args) => {
    const uri = args[0] as vscode.Uri
    opened.push(uri.fsPath)
    const draft = JSON.parse(await readFile(uri.fsPath, "utf8"))
    expect(draft.data).toEqual({ value: 2 })
    await writeFile(
      uri.fsPath,
      JSON.stringify({ source: "export default function Fixed() { return <p>Fixed</p> }", data: { value: 3 } }),
    )
    return undefined as never
  })
  const rendered: CanvasBuild[] = []
  try {
    await recover({
      ...state,
      previous: true,
      current: () => true,
      render: async (build) => {
        rendered.push(build)
        await state.compiler.commit(build)
        return build
      },
    })
    expect(opened).toHaveLength(1)
    expect(rendered[0]?.status).toBe("ready")
    expect(rendered[0]?.revision).not.toBe(state.build.revision)
    expect((await state.compiler.restore(state.root, "report"))?.data).toEqual({ value: 3 })
  } finally {
    choice.mockRestore()
    command.mockRestore()
  }
})

test("a delayed retry choice cannot act after another request supersedes it", async () => {
  const state = await fixture()
  let current = true
  const choice = spyOn(vscode.window, "showWarningMessage").mockImplementation(async () => {
    current = false
    return "Retry" as never
  })
  let rendered = false
  try {
    await recover({
      ...state,
      previous: true,
      current: () => current,
      render: async (build) => {
        rendered = true
        return build
      },
    })
    expect(rendered).toBe(false)
    expect((await state.compiler.restore(state.root, "report"))?.revision).toBe(state.first.revision)
  } finally {
    choice.mockRestore()
  }
})

test("invalid draft JSON can be inspected and repaired after a rejected retry", async () => {
  const state = await fixture()
  const path = state.compiler.draftPath(state.build)
  await writeFile(path, "{invalid draft JSON")
  const choice = spyOn(vscode.window, "showWarningMessage")
    .mockResolvedValueOnce("Retry" as never)
    .mockResolvedValueOnce("Inspect draft" as never)
    .mockResolvedValueOnce("Retry" as never)
  const notice = spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
  const command = spyOn(vscode.commands, "executeCommand").mockImplementation(async (_command, ...args) => {
    expect((args[0] as vscode.Uri).fsPath).toBe(path)
    expect(await readFile(path, "utf8")).toBe("{invalid draft JSON")
    await writeFile(
      path,
      JSON.stringify({ source: "export default function Report() { return <p>Repaired</p> }", data: { value: 8 } }),
    )
    return undefined as never
  })
  try {
    await recover({
      ...state,
      previous: true,
      current: () => true,
      render: async (build) => {
        expect(build.status).toBe("ready")
        await state.compiler.commit(build)
        return build
      },
    })
    expect(notice).toHaveBeenCalledTimes(1)
    expect(notice.mock.calls[0]?.[0]).toContain("Cannot retry this canvas draft")
    expect((await state.compiler.restore(state.root, "report"))?.data).toEqual({ value: 8 })
  } finally {
    choice.mockRestore()
    notice.mockRestore()
    command.mockRestore()
  }
})

test("retry preserves unsaved draft edits and does not compile stale disk contents", async () => {
  const state = await fixture()
  const draft = await state.compiler.draft(state.build)
  const documents = vscode.workspace.textDocuments as vscode.TextDocument[]
  const document = { isDirty: true, uri: vscode.Uri.file(draft.path) } as vscode.TextDocument
  documents.push(document)
  const choice = spyOn(vscode.window, "showWarningMessage")
    .mockResolvedValueOnce("Retry" as never)
    .mockResolvedValueOnce("Keep previous version" as never)
  const notice = spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined)
  let rendered = false
  try {
    await recover({
      ...state,
      previous: true,
      current: () => true,
      render: async (build) => {
        rendered = true
        return build
      },
    })
    expect(rendered).toBe(false)
    expect(notice).toHaveBeenCalledWith("Save your canvas draft changes before retrying.")
    expect(document.isDirty).toBe(true)
    expect((await state.compiler.restore(state.root, "report"))?.revision).toBe(state.first.revision)
  } finally {
    documents.splice(documents.indexOf(document), 1)
    choice.mockRestore()
    notice.mockRestore()
  }
})
