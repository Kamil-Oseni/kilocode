// raya_change - EN-04 installed snapshot lost-response/restart acceptance
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { watch } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { fingerprint } from "../src/edit-review/revision"

type Job = { file: string; old: string; next: string }
type Backend = { url: string; child: Bun.Subprocess; stderr: Promise<string> }
type Diff = Parameters<typeof fingerprint>[0]

async function extensions() {
  const home = process.env.USERPROFILE
  if (!home) throw new Error("USERPROFILE is required to locate the installed Raya snapshot")
  const root = join(home, ".vscode", "extensions")
  const names = (await readdir(root)).filter((name) => name.startsWith("eden.raya-"))
  const items = await Promise.all(names.map(async (name) => ({ name, time: (await stat(join(root, name))).mtimeMs })))
  return items.sort((a, b) => b.time - a.time).map((item) => join(root, item.name))
}

function chunks(input: Array<Record<string, unknown>>) {
  return input.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n"
}

function text(value: string) {
  return chunks([
    { id: "chatcmpl-text", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
    { id: "chatcmpl-text", object: "chat.completion.chunk", choices: [{ delta: { content: value } }] },
    {
      id: "chatcmpl-text",
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ])
}

function tool(job: Job) {
  return chunks([
    { id: "chatcmpl-tool", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
    {
      id: "chatcmpl-tool",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_edit",
                type: "function",
                function: {
                  name: "edit",
                  arguments: JSON.stringify({ filePath: job.file, oldString: job.old, newString: job.next }),
                },
              },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl-tool",
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ])
}

function model() {
  const queue: Job[] = []
  let active: Job | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json().catch((error) => ({ error: String(error) }))
      if (JSON.stringify(body).includes("Generate a title for this conversation"))
        return new Response(text("Installed review acceptance"), { headers: { "content-type": "text/event-stream" } })
      if (!active) {
        active = queue.shift()
        if (!active) throw new Error("The installed CLI made an unexpected model request")
        return new Response(tool(active), { headers: { "content-type": "text/event-stream" } })
      }
      active = undefined
      return new Response(text("Review fixture complete."), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { server, queue, url: `http://127.0.0.1:${server.port}/v1` }
}

function environment(home: string, url: string, password?: string) {
  const config = {
    formatter: false,
    lsp: false,
    permission: { edit: "allow", external_directory: "allow" },
    provider: {
      test: {
        name: "Test",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": {
            id: "test-model",
            name: "Test Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "test-key", baseURL: url },
      },
    },
  }
  return {
    ...process.env,
    KILO_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    KILO_CONFIG_CONTENT: JSON.stringify(config),
    KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_PURE: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_DISABLE_AUTOCOMPACT: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_AUTH_CONTENT: "{}",
    RAYA_NO_DAEMON: "1",
    KILO_NO_DAEMON: "1",
    ...(password ? { KILO_SERVER_PASSWORD: password } : {}),
  }
}

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (result.exitCode) throw new Error(result.stderr.toString())
}

async function workspace(base: string, name: string, content: string) {
  const root = join(base, name)
  await mkdir(root, { recursive: true })
  const file = join(root, "file.txt")
  await writeFile(file, content)
  git(root, ["init"])
  git(root, ["config", "user.email", "raya@test.invalid"])
  git(root, ["config", "user.name", "Raya Test"])
  git(root, ["add", "file.txt"])
  git(root, ["commit", "-m", "baseline"])
  return { root, file }
}

async function run(exe: string, root: string, env: Record<string, string | undefined>, job: Job, queue: Job[]) {
  queue.push(job)
  const child = Bun.spawn(
    [exe, "run", "--dir", root, "--agent", "code", "--model", "test/test-model", "--format", "json", "Change file.txt"],
    { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  const code = await child.exited
  assert.equal(code, 0, stderr)
  const session = stdout.match(/"sessionID":"([^"]+)"/)?.[1]
  assert.ok(session, "The installed CLI did not return a session ID")
  return session
}

async function backend(exe: string, root: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([exe, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const limit = Date.now() + 20_000
  let output = ""
  while (Date.now() < limit) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`Installed backend exited before ready: ${await stderr}`)
    output += decoder.decode(chunk.value)
    const url = output.match(/listening on (http:\/\/[^\s]+)/)?.[1]
    if (url) return { url, child, stderr } satisfies Backend
  }
  child.kill()
  throw new Error(`Installed backend did not become ready: ${await stderr}`)
}

function headers(password: string, root: string, json = false) {
  return {
    Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`,
    "x-kilo-directory": root,
    ...(json ? { "content-type": "application/json" } : {}),
  }
}

async function request(server: Backend, password: string, root: string, path: string, body?: unknown) {
  return fetch(`${server.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(password, root, body !== undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function diffs(server: Backend, password: string, root: string, session: string) {
  const response = await request(server, password, root, `/session/${session}/diff`)
  assert.equal(response.status, 200)
  return (await response.json()) as Diff[]
}

async function stop(server: Backend, hard = false) {
  server.child.kill(hard ? "SIGKILL" : "SIGTERM")
  await server.child.exited
  await server.stderr
}

async function wait(check: () => boolean | Promise<boolean>, message: string, timeout = 20_000) {
  const limit = Date.now() + timeout
  while (Date.now() < limit) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error(message)
}

async function drop(server: Backend, password: string, root: string, path: string, body: unknown) {
  const url = new URL(server.url)
  const data = JSON.stringify(body)
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Installed review request did not produce a response: ${path}`))
    }, 20_000)
    socket.once("error", reject)
    socket.once("data", () => socket.destroy())
    socket.once("connect", () => {
      socket.write(
        [
          `POST ${path} HTTP/1.1`,
          `Host: ${url.host}`,
          `Authorization: Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`,
          `x-kilo-directory: ${root}`,
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(data)}`,
          "Connection: close",
          "",
          data,
        ].join("\r\n"),
      )
    })
    socket.once("close", () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

function receipt(home: string, session: string, request: string) {
  const name = createHash("sha256").update(request).digest("hex") + ".json"
  return join(home, ".local", "share", "kilo", "storage", "review_receipt", session, name)
}

async function clean(path: string) {
  const base = resolve(tmpdir())
  const target = resolve(path)
  if (!target.startsWith(`${base}${sep}`))
    throw new Error(`Refusing to remove review test path outside temp: ${target}`)
  await rm(target, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 }).catch((error) => {
    console.warn(`Installed review cleanup is still locked; deferring removal of ${target}`, error)
    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        "Start-Sleep -Seconds 5; Remove-Item -LiteralPath $env:RAYA_REVIEW_TEST_TEMP -Recurse -Force",
      ],
      {
        env: { ...process.env, RAYA_REVIEW_TEST_TEMP: target },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      },
    )
    child.unref()
  })
}

async function main() {
  if (process.platform !== "win32") throw new Error("Installed review acceptance currently targets the Windows package")
  const candidates = await extensions()
  const extension = process.env.RAYA_INSTALLED_EXTENSION ?? candidates[0]
  if (!extension) throw new Error("No installed eden.raya snapshot was found")
  const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8")) as { version?: string }
  if (!manifest.version?.includes("snapshot+"))
    throw new Error(`${basename(extension)} is not an installed snapshot build`)
  const exe = join(extension, "bin", "kilo.exe")
  const temp = await mkdtemp(join(tmpdir(), "raya-review-installed-"))
  const home = join(temp, "home")
  await mkdir(home, { recursive: true })
  const fake = model()
  const password = randomBytes(32).toString("hex")
  const env = environment(home, fake.url)
  const serveEnv = { ...env, KILO_SERVER_PASSWORD: password }
  let active: Backend | undefined

  try {
    const kept = await workspace(temp, "keep", "before\n")
    const keepSession = await run(exe, kept.root, env, { file: kept.file, old: "before", next: "after" }, fake.queue)
    assert.equal(await readFile(kept.file, "utf8"), "after\n")
    let host = await backend(exe, kept.root, serveEnv)
    active = host
    const keepDiff = await diffs(host, password, kept.root, keepSession)
    assert.equal(keepDiff.length, 1)
    const keepID = "installed-keep-lost-response"
    const keepBody = { files: ["file.txt"], expected: { "file.txt": fingerprint(keepDiff[0]) }, requestID: keepID }
    await drop(host, password, kept.root, `/session/${keepSession}/keep_changes`, keepBody)
    await wait(
      async () => (await diffs(host, password, kept.root, keepSession))[0]?.reviewed !== "",
      "Keep was not committed after its response was dropped",
    )
    const keepReceipt = receipt(home, keepSession, keepID)
    await wait(async () => Bun.file(keepReceipt).exists(), "Keep receipt was not retained")
    const keptReceipt = await readFile(keepReceipt, "utf8")
    assert.equal(JSON.parse(keptReceipt).complete, true)
    await stop(host)
    active = undefined
    host = await backend(exe, kept.root, serveEnv)
    active = host
    const keepReplay = await request(host, password, kept.root, `/session/${keepSession}/keep_changes`, keepBody)
    assert.equal(keepReplay.status, 200)
    assert.equal(await readFile(keepReceipt, "utf8"), keptReceipt)
    assert.equal(await readFile(kept.file, "utf8"), "after\n")
    await stop(host)
    active = undefined

    const undone = await workspace(temp, "undo", "before\n")
    const undoSession = await run(
      exe,
      undone.root,
      env,
      { file: undone.file, old: "before", next: "after" },
      fake.queue,
    )
    assert.equal(await readFile(undone.file, "utf8"), "after\n")
    host = await backend(exe, undone.root, serveEnv)
    active = host
    const undoDiff = await diffs(host, password, undone.root, undoSession)
    assert.equal(undoDiff.length, 1)
    const undoID = "installed-undo-lost-response"
    const undoBody = { files: ["file.txt"], expected: { "file.txt": fingerprint(undoDiff[0]) }, requestID: undoID }
    await drop(host, password, undone.root, `/session/${undoSession}/discard_changes`, undoBody)
    await wait(
      async () => (await readFile(undone.file, "utf8")) === "before\n",
      "Undo did not finish after its response was dropped",
    )
    const undoReceipt = receipt(home, undoSession, undoID)
    await wait(async () => Bun.file(undoReceipt).exists(), "Undo receipt was not retained")
    const savedUndo = await readFile(undoReceipt, "utf8")
    assert.equal(JSON.parse(savedUndo).complete, true)
    await stop(host)
    active = undefined
    await writeFile(undone.file, "manual after dropped response\n")
    host = await backend(exe, undone.root, serveEnv)
    active = host
    const undoReplay = await request(host, password, undone.root, `/session/${undoSession}/discard_changes`, undoBody)
    assert.equal(undoReplay.status, 200)
    assert.equal(await readFile(undone.file, "utf8"), "manual after dropped response\n")
    assert.equal(await readFile(undoReceipt, "utf8"), savedUndo)
    await stop(host)
    active = undefined

    const padding = `${"x".repeat(120)}\n`.repeat(1024)
    const interrupted = await workspace(temp, "interrupted", `before\n${padding}`)
    const interruptedSession = await run(
      exe,
      interrupted.root,
      env,
      { file: interrupted.file, old: "before", next: "after" },
      fake.queue,
    )
    assert.equal(await readFile(interrupted.file, "utf8"), `after\n${padding}`)
    host = await backend(exe, interrupted.root, serveEnv)
    active = host
    const interruptedDiff = await diffs(host, password, interrupted.root, interruptedSession)
    assert.equal(interruptedDiff.length, 1)
    const interruptedID = "installed-undo-interrupted"
    const interruptedBody = {
      files: ["file.txt"],
      expected: { "file.txt": fingerprint(interruptedDiff[0]) },
      requestID: interruptedID,
    }
    const changed = new Promise<void>((resolve) => {
      const watcher = watch(interrupted.file, () => {
        watcher.close()
        host.child.kill("SIGKILL")
        resolve()
      })
    })
    const pending = request(
      host,
      password,
      interrupted.root,
      `/session/${interruptedSession}/discard_changes`,
      interruptedBody,
    ).catch((error) => error)
    await Promise.race([
      changed,
      Bun.sleep(20_000).then(() => Promise.reject(new Error("Interrupted Undo never changed its file"))),
    ])
    await host.child.exited
    active = undefined
    await pending
    const interruptedReceipt = receipt(home, interruptedSession, interruptedID)
    await wait(async () => Bun.file(interruptedReceipt).exists(), "Interrupted Undo did not retain its receipt")
    assert.equal(JSON.parse(await readFile(interruptedReceipt, "utf8")).complete, false)
    await writeFile(interrupted.file, `manual after interruption\n${padding}`)
    host = await backend(exe, interrupted.root, serveEnv)
    active = host
    const refused = await request(
      host,
      password,
      interrupted.root,
      `/session/${interruptedSession}/discard_changes`,
      interruptedBody,
    )
    assert.equal(refused.status, 409)
    const conflict = (await refused.json()) as { _tag?: string; message?: string }
    assert.equal(conflict._tag, "ReviewConflict")
    assert.match(conflict.message ?? "", /previous review outcome is uncertain/i)
    assert.equal(await readFile(interrupted.file, "utf8"), `manual after interruption\n${padding}`)
    assert.equal(JSON.parse(await readFile(interruptedReceipt, "utf8")).complete, false)
    await stop(host)
    active = undefined

    console.log(`Installed review acceptance passed: ${basename(extension)}`)
  } finally {
    if (active)
      await stop(active, true).catch((error) => console.warn("Failed to stop the installed review backend", error))
    fake.server.stop(true)
    await clean(temp)
  }
}

await main()
