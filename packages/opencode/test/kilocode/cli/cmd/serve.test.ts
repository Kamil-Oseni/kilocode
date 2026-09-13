import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../..")
const entry = path.join(root, "src/index.ts")
const preload = Bun.resolveSync("@opentui/solid/preload", root)

test("prints the local IPv6 URL for wildcard binds", async () => {
  await using tmp = await tmpdir()
  const proc = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      `--preload=${preload}`,
      entry,
      "serve",
      "--hostname",
      "::",
      "--port",
      "0",
    ],
    {
      cwd: tmp.path,
      env: {
        ...process.env,
        HOME: tmp.path,
        XDG_CONFIG_HOME: path.join(tmp.path, ".config"),
        XDG_DATA_HOME: path.join(tmp.path, ".local/share"),
        XDG_STATE_HOME: path.join(tmp.path, ".local/state"),
        XDG_CACHE_HOME: path.join(tmp.path, ".cache"),
        KILO_TEST_HOME: tmp.path,
        KILO_CONFIG_CONTENT: "{}",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_PURE: "1",
        KILO_SERVER_PASSWORD: "test",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const errors = new Response(proc.stderr).text()
  const timeout = setTimeout(() => proc.kill(), 15_000)
  const output = await (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let text = ""

    while (!text.includes("  Local:")) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }

    reader.releaseLock()
    return text + decoder.decode()
  })().finally(async () => {
    clearTimeout(timeout)
    proc.kill()
    await proc.exited
  })
  const stderr = await errors

  expect(output, `stdout:\n${output}\nstderr:\n${stderr}`).toMatch(
    /kilo server listening on http:\/\/\[::\]:(\d+)\r?\n  Local:   http:\/\/\[::1\]:\1(?:\r?\n|$)/,
  )
}, 30_000)

test("hard parent exit stops only its authenticated managed server", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const parentA = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  const parentB = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  })
  const spawn = (dir: string, pid: number, password: string) =>
    Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        `--preload=${preload}`,
        entry,
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: path.join(dir, ".config"),
          XDG_DATA_HOME: path.join(dir, ".local/share"),
          XDG_STATE_HOME: path.join(dir, ".local/state"),
          XDG_CACHE_HOME: path.join(dir, ".cache"),
          KILO_TEST_HOME: dir,
          KILO_CONFIG_CONTENT: "{}",
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_DISABLE_AUTOUPDATE: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
          KILO_DISABLE_CHANNEL_DB: "true",
          KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
          KILO_PURE: "1",
          KILO_PARENT_PID: String(pid),
          KILO_SERVER_PASSWORD: password,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
  const serverA = spawn(first.path, parentA.pid, "window-a")
  const serverB = spawn(second.path, parentB.pid, "window-b")
  const stderrA = new Response(serverA.stderr).text()
  const stderrB = new Response(serverB.stderr).text()
  const ready = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let output = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`managed server exited before listening: ${output}`)
      output += decoder.decode(chunk.value, { stream: true })
      const match = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (!match) continue
      reader.releaseLock()
      return match[1]
    }
  }
  const ended = (proc: { exited: Promise<number> }, label: string) => {
    const timeout = Promise.withResolvers<never>()
    const timer = setTimeout(() => timeout.reject(new Error(`${label} did not exit`)), 10_000)
    return Promise.race([proc.exited, timeout.promise]).finally(() => clearTimeout(timer))
  }
  const auth = (password: string) => ({
    Authorization: `Basic ${Buffer.from(`kilo:${password}`).toString("base64")}`,
  })
  const stop = async () => {
    for (const proc of [serverA, serverB, parentA, parentB]) {
      if (proc.exitCode === null) proc.kill("SIGKILL")
    }
    await Promise.all([serverA.exited, serverB.exited, parentA.exited, parentB.exited])
  }

  try {
    const urlA = await ready(serverA.stdout)
    const urlB = await ready(serverB.stdout)
    expect((await fetch(`${urlA}/global/health`, { headers: auth("window-a") })).status).toBe(200)
    expect((await fetch(`${urlB}/global/health`, { headers: auth("window-b") })).status).toBe(200)
    expect((await fetch(`${urlB}/global/health`, { headers: auth("window-a") })).status).toBe(401)

    parentA.kill("SIGKILL")
    await parentA.exited
    await ended(serverA, "first managed server")
    expect((await fetch(`${urlB}/global/health`, { headers: auth("window-b") })).status).toBe(200)

    parentB.kill("SIGKILL")
    await parentB.exited
    await ended(serverB, "second managed server")
  } finally {
    await stop()
  }

  expect(await stderrA).not.toContain("server failed")
  expect(await stderrB).not.toContain("server failed")
}, 45_000)
