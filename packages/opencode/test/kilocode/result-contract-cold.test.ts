import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const pkg = path.resolve(import.meta.dir, "../..")
const fixture = path.join(pkg, "test/fixtures/result-contract-cold.ts")
const names = ["café 日本語.txt", "résumé.json", "🚀.md"]

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const hash = createHash("sha256")
  const state = { bytes: 0, tail: Buffer.alloc(0), eof: false }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        state.eof = true
        break
      }
      state.bytes += next.value.byteLength
      hash.update(next.value)
      state.tail = Buffer.concat([state.tail, next.value]).subarray(-65536)
    }
    return { ...state, tail: state.tail.toString("utf8"), sha256: hash.digest("hex") }
  } finally {
    reader.releaseLock()
  }
}

for (const scenario of ["terminal", "joined", "ack", "success", "restart"]) {
  test(`actual background ${scenario} boundary survives fresh Bun without notice replay`, async () => {
    const mode = scenario === "restart" ? "ack" : scenario
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-result-cold-"))
    const home = path.join(root, "home")
    const workspace = path.join(root, "workspace")
    await mkdir(path.join(workspace, "observed"), { recursive: true })
    for (const name of names) await writeFile(path.join(workspace, "observed", name), "Owned synthetic bytes", "utf8")
    await writeFile(
      path.join(workspace, "opencode.json"),
      JSON.stringify({ snapshot: false, plugin: [], mcp: {}, formatter: false, lsp: false }),
      "utf8",
    )
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (
        /^(RAYA|KILO|OPENCODE)_/i.test(key) ||
        /^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|XDG_.+|BUN_RUNTIME_TRANSPILER_CACHE_PATH)$/i.test(
          key,
        )
      )
        delete env[key]
    }
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: path.parse(home).root.slice(0, 2),
      HOMEPATH: home.slice(2),
      LOCALAPPDATA: path.join(home, "local"),
      APPDATA: path.join(home, "roaming"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "interpreter-cache"),
      KILO_MODELS_PATH: path.join(pkg, "test/tool/fixtures/models-api.json"),
      KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      KILO_DISABLE_DEFAULT_PLUGINS: "true",
      KILO_DISABLE_TELEMETRY: "true",
      KILO_DISABLE_AUTOUPDATE: "true",
      KILO_PURE: "true",
      KILO_DB: path.join(root, "durable.sqlite"),
      RAYA_DB: path.join(root, "durable.sqlite"),
    })
    const receipts: unknown[] = []
    const child = async (operation: string) => {
      const process = Bun.spawn([Bun.which("bun") ?? "bun", "--conditions=browser", fixture, root, operation, mode], {
        cwd: pkg,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = drain(process.stdout)
      const stderr = drain(process.stderr)
      const [code, out, err] = await Promise.all([process.exited, stdout, stderr])
      const receipt = { operation, pid: process.pid, code, signal: process.signalCode, stdout: out, stderr: err }
      receipts.push(receipt)
      await writeFile(path.join(root, "originals.json"), JSON.stringify(receipts), "utf8")
      expect(out.eof).toBe(true)
      expect(err.eof).toBe(true)
      expect(process.signalCode).toBeNull()
      expect(code).toBe(0)
    }
    try {
      await child("produce")
      const before = JSON.parse(await readFile(path.join(root, "producer.json"), "utf8"))
      expect(before.state.posts).toBeGreaterThanOrEqual(4)
      expect(before.phase).toBe(mode === "terminal" ? "terminal" : "joined")
      expect(before.state.commits).toBe(mode === "terminal" || mode === "joined" ? 0 : 1)
      if (scenario === "restart") {
        expect(before.state.posts).toBe(4)
        expect(before.state.fault).toBe(true)
        await child("continue")
        const first = JSON.parse(await readFile(path.join(root, "continued.json"), "utf8"))
        expect(first).toMatchObject({ finalGeneration: true, posts: 1, unchanged: true, replay: false })
        expect(new Set(first.text.split("\n"))).toEqual(new Set(names))
        expect(first.refs).toHaveLength(1)
        await child("continue")
        const second = JSON.parse(await readFile(path.join(root, "continued.json"), "utf8"))
        expect(second).toEqual({ ...first, posts: 0 })
        expect(JSON.parse(await readFile(path.join(root, "producer.json"), "utf8"))).toEqual(before)
        return
      }
      await child("inspect")
      const result = JSON.parse(await readFile(path.join(root, "cold.json"), "utf8"))
      expect(result.posts).toBe(0)
      if (mode === "terminal" || mode === "joined") {
        expect(result).toMatchObject({ accepted: false, debt: true, unchanged: true })
        expect(before.notice).toBeUndefined()
        return
      }
      expect(result).toMatchObject({
        accepted: true,
        cold: true,
        finalGeneration: false,
        receipt: true,
        copied: false,
        mutated: false,
        stale: false,
        duplicate: false,
        newer: false,
      })
      expect(new Set(result.entries)).toEqual(new Set(names))
      expect(result.refs).toHaveLength(1)
      await child("inspect")
      const repeated = JSON.parse(await readFile(path.join(root, "cold.json"), "utf8"))
      expect(repeated.refs).toEqual(result.refs)
      expect(repeated.posts).toBe(0)
      expect(JSON.parse(await readFile(path.join(root, "producer.json"), "utf8"))).toEqual(before)
    } catch (error) {
      await writeFile(
        path.join(root, "failure.json"),
        JSON.stringify({ mode, receipts, error: error instanceof Error ? error.name : "UnknownFailure" }),
        "utf8",
      )
      console.error("Owned cold result failure retained", root)
      throw error
    }
  }, 60_000)
}
