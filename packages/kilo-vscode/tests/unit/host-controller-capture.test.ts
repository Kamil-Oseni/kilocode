import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { HostCapture, hostPayload } from "../../src/kilo-provider/host-capture"
import { ScriptTerminalManager } from "../../src/agent-manager/ScriptTerminalManager"
import { RunController } from "../../src/agent-manager/run/controller"
import { ProjectContexts } from "../../src/agent-manager/project/contexts"
import { registerControllers } from "../../src/agent-manager/controller-capture"

function gate<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

for (const mode of ["run", "setup", "failure", "reserved"] as const)
  test(`registered controller capture joins actual ${mode} HTTP/native lifetime and state publication`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "raya-host-controller-"))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_")),
    )
    Object.assign(env, {
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      GIT_TERMINAL_PROMPT: "0",
    })
    const initial = spawn("git", ["-c", "core.hooksPath=", "init", "--quiet", "--template=", root], {
      env,
      windowsHide: true,
      stdio: "ignore",
    })
    assert.equal(
      await new Promise<number | null>((resolve, reject) => {
        initial.once("close", resolve)
        initial.once("error", reject)
      }),
      0,
    )
    await mkdir(path.join(root, ".kilo"), { recursive: true })
    await writeFile(path.join(root, ".kilo", "run-script.ps1"), "Write-Output 'native fixture transport'\n")
    const contexts = new ProjectContexts({
      workspaceRoot: () => root,
      enabled: () => false,
      registry: { list: () => [], get: () => undefined },
      deps: { log: () => undefined },
    })
    const state = contexts.pinned()!.stateManager()
    const host = new HostCapture()
    const entered = gate<void>()
    const publication = gate<void>()
    const created = gate<void>()
    const removed = gate<void>()
    const native = spawn("git", ["-c", "core.hooksPath=", "-C", root, "hash-object", "--stdin", "-w"], {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    native.stdout.on("data", (bytes: Buffer) => output.push(bytes))
    native.stderr.on("data", (bytes: Buffer) => errors.push(bytes))
    const exited = new Promise<number | null>((resolve, reject) => {
      native.once("close", resolve)
      native.once("error", reject)
    })
    const requests: string[] = []
    const info = {
      id: "native-pty",
      title: "Run",
      command: "git",
      args: ["hash-object", "--stdin", "-w"],
      cwd: root,
      status: "running",
      pid: native.pid!,
    }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const route = new URL(request.url).pathname
        requests.push(`${request.method} ${route}`)
        if (request.method === "POST" && route === "/api/pty") {
          entered.resolve()
          await created.promise
          return Response.json({ location: { directory: root }, data: info })
        }
        if (request.method === "GET" && route === "/api/pty/native-pty")
          return Response.json({ location: { directory: root }, data: info })
        if (request.method === "DELETE" && route === "/api/pty/native-pty") {
          native.stdin.end("joined actual controller cleanup café 日本語 😀\n")
          assert.equal(await exited, 0, Buffer.concat(errors).toString())
          state.addSession("native-cleanup-published", null)
          await state.flush()
          publication.resolve()
          await removed.promise
          if (mode === "failure") return Response.json({ code: "ACTUAL_HTTP_CLEANUP_REFUSED" }, { status: 500 })
          return new Response(null, { status: 204 })
        }
        return new Response(null, { status: 404 })
      },
    })
    const client = createKiloClient({ baseUrl: server.url.toString() })
    const snapshots: unknown[] = []
    const manager = new ScriptTerminalManager({
      getClient: () => client,
      getClientAsync: async () => {
        host.check()
        return client
      },
      buildWsUrl: () => "ws://127.0.0.1/unused",
      getTerminalFont: () => ({ family: "monospace", size: 14, lineHeight: 1 }),
      emit: (value) => snapshots.push(value),
      closed: () => undefined,
      log: () => undefined,
    })
    const run = new RunController({
      root: () => root,
      state: () => state,
      open: async () => undefined,
      env: async () => env as Record<string, string>,
      start: (config, done) => manager.start("run", config, done),
      reserve: () => {
        const reservation = manager.reserve()
        return { start: (config, done) => reservation.start("run", config, done), release: reservation.release }
      },
      post: () => undefined,
      error: (value) => {
        throw new Error(value)
      },
      log: () => undefined,
    })
    registerControllers(contexts, run, { manager, dispose: () => manager.dispose() }, host)
    const action =
      mode === "setup"
        ? manager.start(
            "setup",
            { worktreeId: "local", cwd: root, command: "git", args: [], env: env as Record<string, string> },
            () => undefined,
          )
        : run.run("local", "xterm")
    if (mode !== "reserved") await entered.promise
    const capture = host.capture(client, Date.now() + 10_000)
    if (mode === "reserved") await entered.promise
    const settled = { value: false }
    const observed = capture.then(
      () => {
        settled.value = true
      },
      () => {
        settled.value = true
      },
    )
    try {
      await expect(run.run("local", "xterm")).rejects.toThrow("retired")
      expect(() => manager.reserve()).toThrow("retired")
      await expect(
        manager.start("run", { worktreeId: "late", cwd: root, command: "git", args: [], env: {} }, () => undefined),
      ).rejects.toThrow("retired")
      await Bun.sleep(60)
      expect(settled.value).toBe(false)
      created.resolve()
      await action
      await publication.promise
      await Bun.sleep(60)
      expect(settled.value).toBe(false)
      removed.resolve()
      if (mode === "failure") await expect(capture).rejects.toThrow("host capture")
      if (mode !== "failure") expect(hostPayload(await capture).hosts[0].contexts).toHaveLength(1)
      await observed
      await expect(
        manager.start("run", { worktreeId: "late", cwd: root, command: "git", args: [], env: {} }, () => undefined),
      ).rejects.toThrow("retired")
      expect(requests.filter((value) => value.startsWith("POST"))).toHaveLength(1)
      expect(requests.some((value) => value.startsWith("DELETE"))).toBe(true)
      expect(() => process.kill(native.pid!, 0)).toThrow()
      expect(await exited).toBe(0)
      expect(Buffer.concat(output).toString().trim()).toMatch(/^[a-f0-9]{40}$/)
      expect(await readFile(path.join(root, ".kilo", "agent-manager.json"), "utf8")).toContain(
        "native-cleanup-published",
      )
      expect(snapshots.length).toBeGreaterThan(0)
      await expect(run.configure()).rejects.toThrow("retired")
    } finally {
      created.resolve()
      removed.resolve()
      if (!native.stdin.destroyed) native.stdin.end()
      await Promise.allSettled([action, capture, exited])
      await server.stop(true)
    }
  }, 20000)
