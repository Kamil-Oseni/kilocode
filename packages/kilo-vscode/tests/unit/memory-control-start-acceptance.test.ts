import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import ts from "typescript"
import { acceptance } from "../../src/second-brain/control/acceptance"
import { command } from "../../src/second-brain/control/command"
import { check } from "../../src/second-brain/control/frames"
import { spawn } from "../../src/util/process"

async function method() {
  const source = await readFile(path.resolve(import.meta.dir, "../../src/second-brain/control/index.ts"), "utf8")
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true)
  const value = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "start")
  if (!value || !ts.isFunctionDeclaration(value) || !value.body) throw new Error("Actual control startup required")
  const compiled = ts.transpileModule(
    `async function run(root, input, extension, caller) ${value.body.getText(tree)}`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    },
  ).outputText
  return new Function(
    "parseCatalog",
    "directory",
    "packaged",
    "image",
    "check",
    "mkdtemp",
    "protect",
    "path",
    "os",
    "writeFile",
    "spawn",
    "acceptance",
    compiled + ";return run",
  )
}

test("actual control startup joins its held bootstrap helper after cancel and publishes no bootstrap or control process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-control-start-acceptance-"))
  const ready = path.join(root, "ready")
  const release = path.join(root, "release")
  const marker = path.join(root, "spawned")
  const controller = new AbortController()
  const state = { settled: false, spawns: 0 }
  const digest = "a".repeat(64)
  const dirs: string[] = []
  const children: Promise<void>[] = []
  // The production startup function executes unchanged. Source/catalog/image
  // admission is a controlled boundary here; protection runs a real owned held
  // helper. This qualifies startup cancellation routing, not an ACL or release.
  const run = (await method())(
    (value: unknown) => value,
    async (value: string) => value,
    async () => ({ helper: "unused-after-refusal", names: [], files: [] }),
    async () => ({ digest, raw: Buffer.from("synthetic-image"), tuple: "synthetic" }),
    check,
    async () => {
      const dir = await mkdtemp(path.join(root, "control-"))
      dirs.push(dir)
      return dir
    },
    async () =>
      command(
        process.execPath,
        [
          "-e",
          `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);process.stdout.write('original-protection-joined');},10)`,
        ],
        { cwd: root },
      ),
    path,
    os,
    writeFile,
    () => {
      state.spawns++
      const child = spawn(
        process.execPath,
        ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'effect')`],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      )
      child.stdout?.resume()
      child.stderr?.resume()
      children.push(new Promise((resolve) => child.once("close", () => resolve())))
      return child
    },
    acceptance,
  )
  const work: Promise<void> = run(
    root,
    {
      version: 2,
      source: root,
      python: process.execPath,
      bridge: path.join(root, "bridge.py"),
      python_sha256: digest,
      bridge_sha256: digest,
      source_sha256: {},
    },
    root,
    () => controller.signal.throwIfAborted(),
  )
  const result = work.then(
    () => {
      state.settled = true
      return undefined
    },
    (err: unknown) => {
      state.settled = true
      return err
    },
  )
  try {
    const deadline = performance.now() + 5000
    while (!(await Bun.file(ready).exists())) {
      if (performance.now() >= deadline) throw new Error("Original protection helper did not publish readiness")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const pid = Number(await readFile(ready, "utf8"))
    controller.abort(new Error("Original index acceptance cancelled"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(state.settled).toBe(false)
    expect(state.spawns).toBe(0)
    await writeFile(release, "original may join")
    expect(await result).toMatchObject({
      receipt: {
        pid,
        code: 0,
        originalJoined: true,
        readersJoined: true,
        stdoutEOF: true,
        stderrEOF: true,
        forced: false,
      },
    })
    expect(state.spawns).toBe(0)
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(dirs.length).toBe(1)
    expect(await readdir(dirs[0])).toEqual([])
  } finally {
    await writeFile(release, "original may join")
    await result
    await Promise.all(children)
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
