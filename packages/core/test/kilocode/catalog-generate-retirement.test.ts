import assert from "node:assert/strict"
import { test } from "bun:test"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"

test("actual CLI generate joins its admitted initial catalog refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-catalog-generate-"))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const output = Promise.withResolvers<void>()
  const state = { requests: 0, stdout: "", partial: 0, forced: false }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      state.requests++
      entered.resolve()
      await release.promise
      return Response.json({})
    },
  })
  const config = JSON.stringify({
    formatter: false,
    lsp: false,
    enabled_providers: [],
    experimental: { openTelemetry: false },
  })
  const child = Bun.spawn([process.execPath, "run", "--conditions=browser", "./src/index.ts", "generate"], {
    cwd: path.resolve(import.meta.dir, "../../../opencode"),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      KILO_TEST_HOME: root,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      RAYA_DB: path.join(root, "raya.db"),
      KILO_DB: path.join(root, "raya.db"),
      RAYA_CONFIG_CONTENT: config,
      KILO_CONFIG_CONTENT: config,
      RAYA_CONFIG: undefined,
      KILO_CONFIG: undefined,
      RAYA_CONFIG_DIR: undefined,
      KILO_CONFIG_DIR: undefined,
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      RAYA_NO_DAEMON: "1",
      KILO_NO_DAEMON: "1",
      RAYA_MODELS_URL: server.url.href.replace(/\/$/, ""),
      KILO_MODELS_URL: server.url.href.replace(/\/$/, ""),
      RAYA_MODELS_PATH: undefined,
      KILO_MODELS_PATH: undefined,
      RAYA_DISABLE_MODELS_FETCH: "0",
      KILO_DISABLE_MODELS_FETCH: "0",
      KILO_DISABLE_PROJECT_CONFIG: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_PURE: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const stdout = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout) {
      state.stdout += decoder.decode(chunk, { stream: true })
      if (state.stdout.trimEnd().endsWith("}")) {
        try {
          JSON.parse(state.stdout)
          output.resolve()
        } catch {
          state.partial++ // A chunk may end inside the OpenAPI document.
        }
      }
    }
  })()
  const stderr = new Response(child.stderr).text()
  const timer = setTimeout(() => {
    state.forced = true
    child.kill()
  }, 45_000)
  let failure: unknown
  try {
    await Promise.race([
      entered.promise,
      child.exited.then(() => {
        throw new Error("CLI exited before catalog transport entered")
      }),
    ])
    await Promise.race([
      output.promise,
      child.exited.then(() => {
        throw new Error("CLI exited before complete OpenAPI output")
      }),
    ])
    await Promise.race([child.exited, Bun.sleep(1_500)])
    assert.equal(child.exitCode, null, "accepted catalog transport must hold outer retirement")
    release.resolve()
    assert.equal(await child.exited, 0, await stderr)
    await stdout
    assert.equal(state.forced, false)
    assert.equal(child.signalCode, null)
    assert.ok(JSON.parse(state.stdout).paths)
    assert.equal(state.requests, 1)
    const cache = path.join(root, "cache", "kilo")
    const files = await readdir(cache)
    const catalog = files.find((file) => /^models-.*\.json$/.test(file))
    assert.ok(catalog)
    assert.deepEqual(JSON.parse(await readFile(path.join(cache, catalog), "utf8")), {})
    assert.equal(
      files.some((file) => file.endsWith(".tmp")),
      false,
    )
    assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" })
  } catch (err) {
    failure = err
    throw err
  } finally {
    release.resolve()
    clearTimeout(timer)
    if (child.exitCode === null) {
      state.forced = true
      child.kill()
    }
    await child.exited
    await stdout
    const errors = await stderr
    await Promise.all([
      Bun.write(path.join(root, "stdout.json"), state.stdout),
      Bun.write(path.join(root, "stderr.log"), errors),
      Bun.write(
        path.join(root, "receipt.json"),
        JSON.stringify({
          ok: failure === undefined,
          root,
          pid: child.pid,
          code: child.exitCode,
          signal: child.signalCode,
          requests: state.requests,
          forced: state.forced,
          failure: failure instanceof Error ? failure.stack : failure === undefined ? undefined : inspect(failure),
          portableCaptureAuthorized: false,
        }),
      ),
    ])
    await server.stop(true)
    console.log(JSON.stringify({ root, pid: child.pid, code: child.exitCode, forced: state.forced }))
  }
}, 50_000)
