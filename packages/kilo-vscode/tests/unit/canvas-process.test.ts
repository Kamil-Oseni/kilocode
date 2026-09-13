import { afterAll, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stop } from "esbuild-wasm"
import { CanvasCompiler } from "../../src/services/canvas/canvas-compiler"

const worker = path.join(import.meta.dir, "../fixtures/canvas-process-worker.ts")

afterAll(stop)

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

async function wait(file: string) {
  const stop = Date.now() + 10_000
  while (Date.now() < stop) {
    if (await exists(file)) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${file}`)
}

function run(input: Record<string, string | number>) {
  const proc = spawn(process.execPath, [worker, JSON.stringify(input)], {
    cwd: path.join(import.meta.dir, "../.."),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  })
  return new Promise<{ code: number | null; error: string }>((resolve) => {
    const errors: Buffer[] = []
    proc.stderr.on("data", (data) => errors.push(Buffer.from(data)))
    proc.on("close", (code) => resolve({ code, error: Buffer.concat(errors).toString("utf8") }))
  })
}

async function seed(root: string, output: string, name: string) {
  const compiler = new CanvasCompiler(output)
  const build = await compiler.create(root, name, "export default function Report() { return <p>Base</p> }", {})
  await compiler.commit(build)
}

test("independent extension processes cannot overwrite the same Canvas candidate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-canvas-process-"))
  const output = path.join(root, "bundles")
  try {
    await seed(root, output, "shared")
    const go = path.join(root, "go")
    const first = {
      root,
      output,
      name: "shared",
      source: "export default function Report() { return <p>First</p> }",
      ready: path.join(root, "first-ready"),
      go,
      result: path.join(root, "first-result"),
    }
    const second = {
      ...first,
      source: "export default function Report() { return <p>Second</p> }",
      ready: path.join(root, "second-ready"),
      result: path.join(root, "second-result"),
    }
    const a = run(first)
    const b = run(second)
    await Promise.all([wait(first.ready), wait(second.ready)])
    await writeFile(go, "go")
    expect(await Promise.all([a, b])).toEqual([
      { code: 0, error: "" },
      { code: 0, error: "" },
    ])
    const results = await Promise.all(
      [first.result, second.result].map(async (file) => JSON.parse(await readFile(file, "utf8"))),
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { error: "Canvas candidate was superseded by another window before saving." },
    ])
    const restored = await new CanvasCompiler(output).restore(root, "shared")
    expect(restored?.revision).toBe(results.find((result) => result.ok)?.revision)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("independent extension processes can commit different Canvases concurrently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-canvas-parallel-"))
  const output = path.join(root, "bundles")
  try {
    await seed(root, output, "first")
    await seed(root, output, "second")
    const a = {
      root,
      output,
      name: "first",
      source: "export default function Report() { return <p>First next</p> }",
      ready: path.join(root, "first-ready"),
      go: path.join(root, "first-go"),
      result: path.join(root, "first-result"),
      entered: path.join(root, "first-entered"),
      hold: 1_000,
    }
    const b = {
      root,
      output,
      name: "second",
      source: "export default function Report() { return <p>Second next</p> }",
      ready: path.join(root, "second-ready"),
      go: path.join(root, "second-go"),
      result: path.join(root, "second-result"),
    }
    const first = run(a)
    const second = run(b)
    await Promise.all([wait(a.ready), wait(b.ready)])
    await writeFile(a.go, "go")
    await wait(a.entered)
    await writeFile(b.go, "go")
    const result = await second
    expect(result).toEqual({ code: 0, error: "" })
    expect(JSON.parse(await readFile(b.result, "utf8"))).toMatchObject({ ok: true })
    expect(await exists(a.result)).toBe(false)
    expect(await first).toEqual({ code: 0, error: "" })
    expect(JSON.parse(await readFile(a.result, "utf8"))).toMatchObject({ ok: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
