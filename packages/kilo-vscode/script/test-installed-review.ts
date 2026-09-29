// raya_change - EN-04 installed snapshot lost-response/restart acceptance
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { watch } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { basename, join, resolve, sep } from "node:path"
import { fingerprint } from "../src/edit-review/revision"

type Job = { file: string; old: string; next: string } | { patch: string }
type Backend = { url: string; child: Bun.Subprocess; stderr: Promise<string>; stdout: Promise<string> }
type Diff = Parameters<typeof fingerprint>[0]
const retired: Array<{ pid: number; exit: number; streamsJoined: boolean }> = []
const operations: Array<Record<string, unknown>> = []
const advertised: string[][] = []
const checkpoints: string[] = []

async function hash(file: string) {
  const digest = createHash("sha256")
  for await (const chunk of Bun.file(file).stream()) digest.update(chunk)
  return digest.digest("hex")
}

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
                  name: "patch" in job ? "apply_patch" : "edit",
                  arguments: JSON.stringify(
                    "patch" in job
                      ? { patchText: job.patch }
                      : { filePath: job.file, oldString: job.old, newString: job.next },
                  ),
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
      const payload = body as { tools?: Array<{ function?: { name?: string } }> }
      advertised.push((payload.tools ?? []).flatMap((item) => (item.function?.name ? [item.function.name] : [])))
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
            ...(process.env.RAYA_REVIEW_MODE === "revisions" ? { family: "gpt" } : {}),
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

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const item = await reader.read()
    if (item.done) return Buffer.concat(chunks).toString("utf8")
    size += item.value.byteLength
    if (size > 2_000_000) throw new Error("Installed review child output exceeded its bounded diagnostic limit")
    chunks.push(item.value)
  }
}

async function run(
  exe: string,
  root: string,
  env: Record<string, string | undefined>,
  job: Job,
  queue: Job[],
  session?: string,
) {
  queue.push(job)
  const child = Bun.spawn(
    [
      exe,
      "run",
      "--dir",
      root,
      "--agent",
      "code",
      "--model",
      "test/test-model",
      "--format",
      "json",
      ...(session ? ["--session", session] : []),
      "Change file.txt",
    ],
    { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const streams = [drain(child.stdout.getReader()), drain(child.stderr.getReader())]
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000)
  try {
    const [stdout, stderr, code] = await Promise.all([streams[0]!, streams[1]!, child.exited])
    assert.equal(code, 0, stderr)
    const id = String(stdout).match(/"sessionID":"([^"]+)"/)?.[1]
    assert.ok(id, "The installed CLI did not return a session ID")
    const events = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string
            part?: {
              id?: string
              callID?: string
              messageID?: string
              tool?: string
              state?: { status?: string; error?: string }
            }
          },
      )
    const tools = events
      .filter((event) => event.type === "tool_use")
      .map((event) => event.part)
      .filter((part) => !!part)
    const intended = "patch" in job ? "apply_patch" : "edit"
    operations.push(
      ...tools.map((part) => ({
        session: id,
        tool: part.tool,
        part: part.id,
        call: part.callID,
        message: part.messageID,
        status: part.state?.status,
        ...(part.state?.error ? { error: part.state.error.slice(0, 1000) } : {}),
      })),
    )
    assert.ok(
      tools.some((part) => part.tool === intended && part.state?.status === "completed"),
      `The requested ${intended} tool did not complete: ${JSON.stringify(operations.at(-1))}`,
    )
    if (session) assert.equal(id, session, "The continued operation changed session identity")
    return id
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    const joined = await Promise.allSettled([...streams, child.exited])
    retired.push({
      pid: child.pid,
      exit: await child.exited,
      streamsJoined: joined.slice(0, 2).every((item) => item.status === "fulfilled"),
    })
  }
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
  const stderr = drain(child.stderr.getReader())
  void stderr.catch(() => {
    console.warn("Installed review backend exceeded its stderr bound; stopping the owned child")
    child.kill("SIGKILL")
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const limit = Date.now() + 20_000
  let output = ""
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
  try {
    while (Date.now() < limit) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`Installed backend exited before ready: ${await stderr}`)
      output += decoder.decode(chunk.value)
      if (output.length > 2_000_000) throw new Error("Installed backend readiness output exceeded its limit")
      const url = output.match(/listening on (http:\/\/[^\s]+)/)?.[1]
      if (url) {
        const stdout = drain(reader)
        void stdout.catch(() => {
          console.warn("Installed review backend exceeded its stdout bound; stopping the owned child")
          child.kill("SIGKILL")
        })
        return { url, child, stderr, stdout } satisfies Backend
      }
    }
    throw new Error("Installed backend did not become ready before its deadline")
  } catch (error) {
    child.kill("SIGKILL")
    await Promise.allSettled([child.exited, stderr, drain(reader)])
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function headers(password: string, root: string, json = false) {
  return {
    Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`,
    "x-kilo-directory": root,
    ...(json ? { "content-type": "application/json" } : {}),
  }
}

async function request(
  server: Backend,
  password: string,
  root: string,
  path: string,
  body?: unknown,
  timeout = 20_000,
) {
  return fetch(`${server.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(password, root, body !== undefined),
    signal: AbortSignal.timeout(timeout),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch((error: unknown) => {
    throw new Error(`Installed review request ${path} failed: ${error instanceof Error ? error.name : String(error)}`, {
      cause: error,
    })
  })
}

async function diffs(server: Backend, password: string, root: string, session: string) {
  const response = await request(server, password, root, `/session/${session}/diff`)
  assert.equal(response.status, 200)
  return (await response.json()) as Diff[]
}

async function stop(server: Backend, hard = false) {
  if (server.child.exitCode === null) server.child.kill(hard ? "SIGKILL" : "SIGTERM")
  const timer = setTimeout(() => {
    if (server.child.exitCode === null) server.child.kill("SIGKILL")
  }, 10_000)
  try {
    const exit = await server.child.exited
    const joined = await Promise.allSettled([server.stderr, server.stdout])
    retired.push({ pid: server.child.pid, exit, streamsJoined: joined.every((item) => item.status === "fulfilled") })
    for (const item of joined) if (item.status === "rejected") throw item.reason
  } finally {
    clearTimeout(timer)
  }
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
    console.warn(`Installed review cleanup is still locked; retaining ${target} without detached cleanup`, error)
  })
}

/** Actual installed backend evidence only; no editor, ghost buffer or desktop is exercised. */
async function revisions(
  exe: string,
  temp: string,
  env: Record<string, string | undefined>,
  queue: Job[],
  password: string,
) {
  const bytes = Buffer.from("original é 🤖 without trailing newline", "utf8")
  const source = await workspace(temp, "revisions", bytes.toString("utf8"))
  const patch = { patch: "*** Begin Patch\n*** Delete File: file.txt\n*** End Patch" }
  const session = await run(exe, source.root, env, patch, queue)
  let host: Backend | undefined
  const evidence: Array<Record<string, unknown>> = []
  const expected = (items: Diff[]) => Object.fromEntries(items.map((item) => [item.file, fingerprint(item)]))
  const proof = async (id: string) => {
    assert.ok(env.KILO_TEST_HOME)
    const data = await readFile(receipt(env.KILO_TEST_HOME, session, id), "utf8")
    assert.equal(JSON.parse(data).complete, true, "Installed review receipt is not terminal")
    return data
  }
  const restart = async () => {
    if (host) await stop(host)
    host = await backend(exe, source.root, { ...env, KILO_SERVER_PASSWORD: password })
    return host
  }
  const absent = async (file: string) => assert.equal(await Bun.file(file).exists(), false)
  const exact = async () => assert.deepEqual(await readFile(source.file), bytes)
  try {
    await absent(source.file)
    const first = await diffs(await restart(), password, source.root, session)
    assert.equal(first.length, 1)
    assert.equal(first[0]!.file, "file.txt")
    assert.equal(first[0]!.status, "deleted")
    assert.ok(first[0]!.generation, "Deletion has no persisted patch generation")
    const detail = await request(host!, password, source.root, `/session/${session}/diff?full=true&file=file.txt`)
    assert.equal(detail.status, 200)
    const content = (await detail.json()) as Diff[]
    assert.equal(content[0]?.before, bytes.toString("utf8"), "Raw deleted-file detail changed original text")
    const body = { files: ["file.txt"], expected: expected(first), requestID: "installed-deletion-first" }
    const saved = fingerprint(first[0]!)
    assert.equal(fingerprint((await diffs(await restart(), password, source.root, session))[0]!), saved)
    const undo = await request(host!, password, source.root, `/session/${session}/discard_changes`, body)
    assert.equal(undo.status, 200, await undo.text())
    const original = await proof(body.requestID)
    await exact()
    assert.deepEqual(await diffs(host!, password, source.root, session), [])
    evidence.push({
      step: "deletion-undo-after-restart",
      generation: first[0]!.generation,
      sha256: createHash("sha256")
        .update(await readFile(source.file))
        .digest("hex"),
    })

    await stop(host!)
    host = undefined
    await run(exe, source.root, env, patch, queue, session)
    await absent(source.file)
    const second = await diffs(await restart(), password, source.root, session)
    assert.equal(second.length, 1)
    assert.notEqual(second[0]!.generation, first[0]!.generation)
    assert.equal(second[0]!.patch, first[0]!.patch, "Repeated deletion must exercise identical content")
    assert.notEqual(fingerprint(second[0]!), saved)
    const stale = await request(host!, password, source.root, `/session/${session}/discard_changes`, {
      ...body,
      requestID: "installed-deletion-stale",
    })
    assert.equal(stale.status, 409, await stale.text())
    await absent(source.file)
    const replay = await request(host!, password, source.root, `/session/${session}/discard_changes`, body)
    assert.equal(replay.status, 200, await replay.text())
    assert.equal(await proof(body.requestID), original)
    await absent(source.file)
    const fresh = { files: ["file.txt"], expected: expected(second), requestID: "installed-deletion-fresh" }
    await restart()
    const restored = await request(host!, password, source.root, `/session/${session}/discard_changes`, fresh)
    assert.equal(restored.status, 200, await restored.text())
    const retained = await proof(fresh.requestID)
    await exact()
    const receipt = await request(await restart(), password, source.root, `/session/${session}/discard_changes`, fresh)
    assert.equal(receipt.status, 200, await receipt.text())
    assert.equal(await proof(fresh.requestID), retained)
    await exact()
    evidence.push({
      step: "fresh-generation-stale-refusal-idempotent-restart",
      generation: second[0]!.generation,
      revision: fingerprint(second[0]!),
      receiptSha256: createHash("sha256").update(retained).digest("hex"),
    })

    await stop(host!)
    host = undefined
    await run(
      exe,
      source.root,
      env,
      {
        patch:
          "*** Begin Patch\n*** Update File: file.txt\n*** Move to: renamed.txt\n@@\n-original é 🤖 without trailing newline\n+renamed é 🤖\n*** End Patch",
      },
      queue,
      session,
    )
    await absent(source.file)
    const renamed = join(source.root, "renamed.txt")
    const changed = await readFile(renamed)
    const moved = await diffs(await restart(), password, source.root, session)
    assert.deepEqual(moved.map((item) => [item.file, item.status]).sort(), [
      ["file.txt", "deleted"],
      ["renamed.txt", "added"],
    ])
    assert.ok(moved.every((item) => !!item.generation))
    const move = {
      files: moved.map((item) => item.file),
      expected: expected(moved),
      requestID: "installed-rename-undo",
    }
    await restart()
    const back = await request(host!, password, source.root, `/session/${session}/discard_changes`, move)
    assert.equal(back.status, 200, await back.text())
    const movedReceipt = await proof(move.requestID)
    await exact()
    await absent(renamed)
    assert.deepEqual(await diffs(host!, password, source.root, session), [])
    const retry = await request(await restart(), password, source.root, `/session/${session}/discard_changes`, move)
    assert.equal(retry.status, 200, await retry.text())
    assert.equal(await proof(move.requestID), movedReceipt)
    await exact()
    await absent(renamed)
    evidence.push({
      step: "rename-undo-exact-bytes-restart",
      scope: move.files,
      renamedSha256: createHash("sha256").update(changed).digest("hex"),
      receiptSha256: createHash("sha256").update(movedReceipt).digest("hex"),
    })
    return evidence
  } finally {
    if (host) await stop(host, true)
  }
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
    if (process.env.RAYA_REVIEW_MODE === "revisions") {
      const evidence = await revisions(exe, temp, env, fake.queue, password).catch(async (error: unknown) => {
        if (process.env.RAYA_REVIEW_REPORT)
          await writeFile(
            process.env.RAYA_REVIEW_REPORT,
            JSON.stringify(
              {
                version: 1,
                mode: "revisions",
                extension: manifest.version,
                cliSha256: await hash(exe),
                passed: false,
                backendOnly: true,
                editorAccepted: false,
                error: error instanceof Error ? error.message : String(error),
                retired,
                operations,
                advertised,
              },
              null,
              2,
            ),
          )
        throw error
      })
      const report = {
        version: 1,
        mode: "revisions",
        extension: manifest.version,
        cliSha256: await hash(exe),
        passed: true,
        backendOnly: true,
        editorAccepted: false,
        evidence,
        retired,
        operations,
        advertised,
      }
      if (process.env.RAYA_REVIEW_REPORT)
        await writeFile(process.env.RAYA_REVIEW_REPORT, JSON.stringify(report, null, 2))
      console.log(JSON.stringify(report))
      return
    }
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

    checkpoints.push("keep-lost-response-restart")

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

    checkpoints.push("undo-lost-response-restart-preserves-manual")
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
    const owner = host
    let watcher: ReturnType<typeof watch> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = new Promise<void>((resolve, reject) => {
      watcher = watch(interrupted.file, () => {
        watcher?.close()
        if (owner.child.exitCode === null) owner.child.kill("SIGKILL")
        resolve()
      })
      timer = setTimeout(() => reject(new Error("Interrupted Undo never changed its file")), 20_000)
    })
    const pending = request(
      host,
      password,
      interrupted.root,
      `/session/${interruptedSession}/discard_changes`,
      interruptedBody,
    ).catch((error) => error)
    try {
      await changed
    } finally {
      watcher?.close()
      clearTimeout(timer)
    }
    await stop(owner, true)
    active = undefined
    await pending
    const interruptedReceipt = receipt(home, interruptedSession, interruptedID)
    await wait(async () => Bun.file(interruptedReceipt).exists(), "Interrupted Undo did not retain its receipt")
    assert.equal(JSON.parse(await readFile(interruptedReceipt, "utf8")).complete, false)
    await writeFile(interrupted.file, `manual after interruption\n${padding}`)
    host = await backend(exe, interrupted.root, serveEnv)
    active = host
    const uncertain = await readFile(interruptedReceipt)
    const started = performance.now()
    // EffectFlock retains an abandoned heartbeat for 60s; allow lease expiry plus retry/startup margin.
    const refused = await request(
      host,
      password,
      interrupted.root,
      `/session/${interruptedSession}/discard_changes`,
      interruptedBody,
      90_000,
    )
    const recoveryRequestMs = performance.now() - started
    assert.equal(refused.status, 409)
    const conflict = (await refused.json()) as { _tag?: string; message?: string }
    assert.equal(conflict._tag, "ReviewConflict")
    assert.match(conflict.message ?? "", /previous review outcome is uncertain/i)
    assert.equal(await readFile(interrupted.file, "utf8"), `manual after interruption\n${padding}`)
    assert.equal(JSON.parse(await readFile(interruptedReceipt, "utf8")).complete, false)
    assert.deepEqual(await readFile(interruptedReceipt), uncertain)
    await stop(host)
    active = undefined

    const report = {
      version: 1,
      mode: "acknowledgement",
      extension: manifest.version,
      cliSha256: await hash(exe),
      passed: true,
      backendOnly: true,
      editorAccepted: false,
      evidence: [...checkpoints, "hard-interruption-unknown-refusal"],
      recoveryRequestMs,
      retired,
      operations,
      advertised,
    }
    if (process.env.RAYA_REVIEW_REPORT) await writeFile(process.env.RAYA_REVIEW_REPORT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } catch (error: unknown) {
    if (active) {
      await stop(active, true)
      active = undefined
    }
    if (process.env.RAYA_REVIEW_REPORT && process.env.RAYA_REVIEW_MODE !== "revisions")
      await writeFile(
        process.env.RAYA_REVIEW_REPORT,
        JSON.stringify(
          {
            version: 1,
            mode: "acknowledgement",
            extension: manifest.version,
            cliSha256: await hash(exe),
            passed: false,
            backendOnly: true,
            editorAccepted: false,
            error: error instanceof Error ? error.message : String(error),
            checkpoints,
            operations,
            advertised,
            retired,
          },
          null,
          2,
        ),
      )
    throw error
  } finally {
    if (active)
      await stop(active, true).catch((error) => console.warn("Failed to stop the installed review backend", error))
    fake.server.stop(true)
    await clean(temp)
  }
}

await main()
