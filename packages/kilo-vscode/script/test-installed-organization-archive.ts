import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"

type Host = { url: string; child: Bun.Subprocess; stderr: Promise<string> }
type Worker = { id: string; enabled: boolean }
type Organization = { id: string; revision: number; archived: boolean }

async function installed() {
  const home = process.env.USERPROFILE
  if (!home) throw new Error("USERPROFILE is required to locate installed Raya")
  const root = join(home, ".vscode", "extensions")
  const names = (await readdir(root)).filter((name) => name.startsWith("eden.raya-"))
  const items = await Promise.all(names.map(async (name) => ({ name, time: (await stat(join(root, name))).mtimeMs })))
  const name = items.sort((a, b) => b.time - a.time)[0]?.name
  const dir = process.env.RAYA_INSTALLED_EXTENSION ?? (name ? join(root, name) : undefined)
  if (!dir) throw new Error("No installed Raya extension was found")
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version?: string }
  if (!manifest.version?.includes("snapshot+")) throw new Error("The installed extension is not a snapshot")
  return { exe: join(dir, "bin", "kilo.exe"), version: manifest.version, dir }
}

function fixture() {
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (!req.url.endsWith("/chat/completions")) return new Response("Not found", { status: 404 })
      const body = await req.text()
      if (body.includes("Generate a title for this conversation")) {
        return new Response(
          'data: {"choices":[{"delta":{"content":"Archive test"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      requests++
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}/v1`, count: () => requests }
}

function environment(home: string, url: string, password: string) {
  return {
    ...process.env,
    HOME: home,
    KILO_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    KILO_CONFIG_CONTENT: JSON.stringify({
      formatter: false,
      lsp: false,
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
    }),
    KILO_DISABLE_PROJECT_CONFIG: "1",
    KILO_PURE: "1",
    KILO_DISABLE_AUTOUPDATE: "1",
    KILO_DISABLE_AUTOCOMPACT: "1",
    KILO_DISABLE_MODELS_FETCH: "1",
    KILO_AUTH_CONTENT: "{}",
    KILO_SERVER_PASSWORD: password,
    RAYA_NO_DAEMON: "1",
    KILO_NO_DAEMON: "1",
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
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + 20_000
  let output = ""
  while (Date.now() < deadline) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`Installed backend exited before ready: ${await stderr}`)
    output += decoder.decode(chunk.value)
    const url = output.match(/listening on (http:\/\/[^\s]+)/)?.[1]
    if (url) return { url, child, stderr } satisfies Host
  }
  child.kill()
  throw new Error("Installed backend did not become ready")
}

async function call(host: Host, password: string, root: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${host.url}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`,
      "x-kilo-directory": root,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(35_000),
  })
  const value = await response.json()
  if (response.status !== 200) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`)
  return value
}

async function wait(check: () => Promise<boolean> | boolean, message: string, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}

async function stop(host: Host) {
  host.child.kill("SIGKILL")
  await host.child.exited
  await host.stderr
}

async function main() {
  if (process.platform !== "win32") throw new Error("Installed archive acceptance targets the Windows snapshot")
  const app = await installed()
  const temp = await mkdtemp(join(tmpdir(), "raya-archive-installed-"))
  const root = join(temp, "project")
  const home = join(temp, "home")
  await Promise.all([mkdir(root, { recursive: true }), mkdir(home, { recursive: true })])
  await writeFile(join(root, "README.md"), "Disposable archive acceptance workspace.\n")
  const fake = fixture()
  const password = randomBytes(32).toString("hex")
  const env = environment(home, fake.url, password)
  let host: Host | undefined
  try {
    host = await backend(app.exe, root, env)
    const headers = { access: "brief", tools: [], model: { providerID: "test", id: "test-model" } }
    const manual = (await call(host, password, root, "POST", "/kilocode/agent", {
      ...headers,
      name: "Active worker",
      objective: "Wait for the model fixture.",
      schedule: { kind: "manual" },
    })) as Worker
    const due = Date.now() + 8_000
    const scheduled = (await call(host, password, root, "POST", "/kilocode/agent", {
      ...headers,
      name: "Scheduled worker",
      objective: "Run at the scheduled time.",
      schedule: { kind: "once", at: due },
    })) as Worker
    const organization = (await call(host, password, root, "POST", "/kilocode/organization", {
      name: "Archive acceptance",
      members: [
        { agentID: manual.id, role: "Active" },
        { agentID: scheduled.id, role: "Scheduled" },
      ],
    })) as Organization
    await call(host, password, root, "POST", `/kilocode/agent/${manual.id}/run`)
    await wait(() => fake.count() > 0, "The manual worker did not reach the model fixture")
    const before = (await call(host, password, root, "GET", `/kilocode/agent/${manual.id}/runs`)) as Array<{
      status: string
    }>
    assert.equal(before[0]?.status, "running")
    const archived = (await call(host, password, root, "DELETE", `/kilocode/organization/${organization.id}`, {
      expectedRevision: organization.revision,
    })) as Organization
    assert.equal(archived.archived, true)
    const after = (await call(host, password, root, "GET", `/kilocode/agent/${manual.id}/runs`)) as Array<{
      status: string
    }>
    assert.equal(after[0]?.status, "error")
    const roster = (await call(host, password, root, "GET", "/kilocode/agent")) as Worker[]
    assert.equal(roster.find((item) => item.id === manual.id)?.enabled, false)
    assert.equal(roster.find((item) => item.id === scheduled.id)?.enabled, false)
    await stop(host)
    host = await backend(app.exe, root, env)
    assert.equal(
      ((await call(host, password, root, "GET", `/kilocode/organization/${organization.id}`)) as Organization).archived,
      true,
    )
    await Bun.sleep(Math.max(0, due + 65_000 - Date.now()))
    assert.deepEqual(await call(host, password, root, "GET", `/kilocode/agent/${scheduled.id}/runs`), [])
    const blocked = await fetch(`${host.url}/kilocode/agent/${scheduled.id}/run`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`,
        "x-kilo-directory": root,
      },
      signal: AbortSignal.timeout(20_000),
    })
    assert.equal(blocked.status, 400)
    assert.equal(fake.count(), 1)
    console.log(
      `Installed archive acceptance passed: ${app.version}, active run stopped, due schedule fenced after restart`,
    )
  } finally {
    if (host) await stop(host)
    fake.server.stop(true)
    const base = resolve(tmpdir()) + sep
    if (resolve(temp).startsWith(base)) await rm(temp, { recursive: true, force: true })
  }
}

await main()
