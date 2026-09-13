import { writeFileSync } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { CanvasCompiler } from "../../src/services/canvas/canvas-compiler"

const input = JSON.parse(process.argv[2]) as {
  root: string
  output: string
  name: string
  source: string
  ready: string
  go: string
  result: string
  entered?: string
  hold?: number
  crash?: string
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function wait(path: string) {
  while (!(await exists(path))) await Bun.sleep(20)
}

const compiler = new CanvasCompiler(input.output, undefined, (stage) => {
  if (stage === input.crash) process.exit(86)
})
try {
  const build = await compiler.create(input.root, input.name, input.source, { worker: input.source })
  await writeFile(input.ready, "ready")
  await wait(input.go)
  let held = false
  await compiler.commit(build, () => {
    if (held || !input.entered) return true
    held = true
    writeFileSync(input.entered, "entered")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.hold ?? 0)
    return true
  })
  await writeFile(input.result, JSON.stringify({ ok: true, revision: build.revision }))
} catch (error) {
  await writeFile(
    input.result,
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  )
}

// Ensure the result was flushed before the process exits.
await readFile(input.result)
