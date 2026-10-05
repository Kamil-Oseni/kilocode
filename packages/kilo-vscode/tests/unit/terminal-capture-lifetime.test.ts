import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TerminalRouter } from "../../src/agent-manager/terminal-routing"
import { TerminalClosure } from "../../src/agent-manager/terminal-closure"
import { bindTask } from "../../src/agent-manager/run/task-native"
import { SessionTerminalManager, type TerminalHost } from "../../src/agent-manager/SessionTerminalManager"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("capture joins accepted HTTP work using its pinned client after ordinary SDK intake retires", async () => {
  const connected = deferred<void>()
  const entered = deferred<void>()
  const release = deferred<void>()
  const removed: string[] = []
  let creates = 0
  let retired = false
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method === "POST") {
        creates++
        entered.resolve()
        await release.promise
        return Response.json({ id: "held", title: "Terminal 1" })
      }
      if (request.method === "DELETE") {
        removed.push(new URL(request.url).pathname)
        return Response.json(true)
      }
      return Response.json(true)
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const router = new TerminalRouter({
    getClient: () => {
      if (retired) throw new Error("Ordinary SDK intake is retired")
      return client
    },
    getClientAsync: async () => {
      await connected.promise
      return client
    },
    getServerConfig: () => ({ baseUrl: server.url.toString(), password: "fixture" }),
    getRoot: () => os.tmpdir(),
    getWorktreePath: () => undefined,
    getProjectId: () => undefined,
    log: () => undefined,
    post: () => undefined,
    getTerminalFont: () => ({ fontFamily: "mono", fontSize: 12 }),
  })
  try {
    router.handle({ type: "agentManager.terminal.create", createId: "one", placement: "tab", worktreeId: null })
    retired = true
    router.fence(client)
    const closing = router.capture()
    let settled = false
    void closing.then(() => {
      settled = true
    })
    expect(() =>
      router.handle({ type: "agentManager.terminal.create", createId: "late", placement: "tab", worktreeId: null }),
    ).toThrow("retired")
    connected.resolve()
    await entered.promise
    expect(settled).toBe(false)
    release.resolve()
    await closing
    expect(creates).toBe(1)
    expect(removed).toEqual(["/pty/held"])
    await router.capture()
    expect(removed).toHaveLength(1)
  } finally {
    release.resolve()
    connected.resolve()
    await server.stop(true)
  }
})

test("failed removal of a panel-reset historical manager stays visible to capture", async () => {
  const created = deferred<void>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (request.method === "POST") {
        created.resolve()
        return Response.json({ id: "old", title: "Terminal 1" })
      }
      return Response.json({ error: "fixture refusal" }, { status: 500 })
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const published = deferred<void>()
  const router = new TerminalRouter({
    getClient: () => client,
    getClientAsync: async () => client,
    getServerConfig: () => ({ baseUrl: server.url.toString(), password: "fixture" }),
    getRoot: () => os.tmpdir(),
    getWorktreePath: () => undefined,
    getProjectId: () => undefined,
    log: () => undefined,
    post: () => published.resolve(),
    getTerminalFont: () => ({ fontFamily: "mono", fontSize: 12 }),
  })
  try {
    router.handle({ type: "agentManager.terminal.create", createId: "one", placement: "tab", worktreeId: null })
    await created.promise
    await published.promise
    await expect(router.dispose()).rejects.toThrow("cleanup failed")
    await expect(router.capture()).rejects.toThrow("retirement failed")
    await expect(router.capture()).rejects.toThrow("retirement failed")
  } finally {
    await server.stop(true)
  }
})

for (const code of [0, 7, 9])
  test.skipIf(process.platform !== "win32")(
    code === 9
      ? "native shell closure without a close event refuses and stays sticky"
      : `native shell exit ${code} joins its close event without claiming zero`,
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "raya-terminal-closure-"))
      await mkdir(path.join(root, "bin"))
      const helper = path.join(root, "bin", "raya-process-host.exe")
      await copyFile(path.resolve(import.meta.dir, "../../../core/native/kilocode/bin/raya-process-host.exe"), helper)
      await writeFile(
        path.join(root, "bin", "raya-process-host.json"),
        JSON.stringify({
          version: 1,
          exe: createHash("sha256")
            .update(await readFile(helper))
            .digest("hex"),
        }),
      )
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) => value !== undefined && !/^(RAYA|KILO|OPENCODE|OTEL)_|API_KEY|TOKEN|SECRET/.test(key),
        ),
      )
      Object.assign(env, {
        HOME: root,
        USERPROFILE: root,
        LOCALAPPDATA: path.join(root, "local"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        RAYA_DB: path.join(root, "unused.db"),
        KILO_DB: path.join(root, "unused.db"),
      })
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Console]::WriteLine('READY'); $null=[Console]::ReadLine(); exit ${code}`,
        ],
        { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      )
      const ended = new Promise<number | null>((resolve, reject) => {
        child.once("close", resolve)
        child.once("error", reject)
      })
      child.stderr.resume()
      await new Promise<void>((resolve) => {
        child.stdout.once("data", () => resolve())
      })
      const owner = new TerminalClosure(Promise.resolve(child.pid), (pid) => bindTask(pid, helper))
      let calls = 0
      try {
        const task = owner.close(() => {
          calls++
          child.stdin.write("release\n")
          child.stdin.end()
        })
        expect(await ended).toBe(code)
        let settled = false
        void task.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
        expect(settled).toBe(false)
        if (code === 9) {
          await expect(task).rejects.toThrow("shell closure was not confirmed")
          owner.closed()
          await expect(
            owner.close(() => {
              calls++
            }),
          ).rejects.toThrow("shell closure was not confirmed")
        } else {
          owner.closed()
          await task
          await owner.close(() => {
            calls++
          })
        }
        expect(calls).toBe(1)
        expect(() => process.kill(child.pid!, 0)).toThrow()
        await writeFile(
          path.join(root, "receipt.json"),
          JSON.stringify({
            code,
            calls,
            pid: child.pid,
            event: code !== 9,
            shellOnly: true,
            descendantsProven: false,
            portableCaptureAuthorized: false,
          }),
        )
      } finally {
        if (child.exitCode === null) {
          child.stdin.write("release\n")
          child.stdin.end()
        }
        await ended
      }
    },
    30000,
  )

test("close event and missing PID never fabricate native ownership", async () => {
  let calls = 0
  const owner = new TerminalClosure(Promise.resolve(undefined), async () => {
    throw new Error("not reached")
  })
  owner.closed()
  await expect(
    owner.close(() => {
      calls++
    }),
  ).rejects.toThrow("identity is unknown")
  await expect(
    owner.close(() => {
      calls++
    }),
  ).rejects.toThrow("identity is unknown")
  expect(calls).toBe(0)
})

test("capture retains both restart shells when the old remove fails", async () => {
  const published = deferred<void>()
  const restarted = deferred<void>()
  const removals: string[] = []
  let creates = 0
  let refused = false
  const messages: { type: string; message?: string }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      await request.text()
      if (request.method === "POST") return Response.json({ id: `shell-${++creates}`, title: "Terminal 1" })
      const id = new URL(request.url).pathname.split("/").at(-1)!
      removals.push(id)
      if (id === "shell-1" && !refused) {
        refused = true
        return Response.json({ error: "fixture refusal" }, { status: 500 })
      }
      return Response.json(true)
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const router = new TerminalRouter({
    getClient: () => client,
    getClientAsync: async () => client,
    getServerConfig: () => ({ baseUrl: server.url.toString(), password: "fixture" }),
    getRoot: () => os.tmpdir(),
    getWorktreePath: () => undefined,
    getProjectId: () => undefined,
    log: () => undefined,
    post: (message) => {
      messages.push(message)
      if (message.type === "agentManager.terminal.created") published.resolve()
      if (message.type === "agentManager.terminal.error") restarted.resolve()
    },
    getTerminalFont: () => ({ fontFamily: "mono", fontSize: 12 }),
  })
  try {
    router.handle({ type: "agentManager.terminal.create", createId: "one", placement: "tab", worktreeId: null })
    await published.promise
    expect(messages[0]?.type).toBe("agentManager.terminal.created")
    router.handle({ type: "agentManager.terminal.restart", terminalId: "one" })
    await restarted.promise
    await expect(router.capture()).rejects.toThrow("retirement failed")
    expect(removals.filter((id) => id === "shell-1")).toHaveLength(2)
    expect(removals.filter((id) => id === "shell-2")).toHaveLength(1)
  } finally {
    await server.stop(true)
  }
})

test("session capture fences synchronously and joins historical shell owners", async () => {
  const release = deferred<void>()
  const calls: number[] = []
  let count = 0
  let directory = "first"
  const host: TerminalHost = {
    createTerminal: () => {
      const id = ++count
      return {
        show: () => undefined,
        dispose: () => undefined,
        exitStatus: undefined,
        close: async () => {
          calls.push(id)
          await release.promise
        },
      }
    },
    activeTerminal: () => undefined,
    repoPath: () => directory,
    showWarning: () => undefined,
    setContext: () => undefined,
    onTerminalClosed: () => ({ dispose: () => undefined }),
    onActiveTerminalChanged: () => ({ dispose: () => undefined }),
    registerCommand: () => ({ dispose: () => undefined }),
    executeCommand: async () => undefined,
  }
  const manager = new SessionTerminalManager(() => undefined, host)
  manager.showLocalTerminal()
  directory = "second"
  manager.showLocalTerminal()
  // showLocalTerminal focuses the current terminal; changing CWD is checked by session creation.
  manager.showTerminal("session", undefined)
  const closing = manager.capture()
  expect(() => manager.showTerminal("late", undefined)).toThrow("retired")
  expect(calls).toEqual([1, 2])
  release.resolve()
  await closing
  await manager.capture()
  expect(calls).toEqual([1, 2])
})

test("capture joins an accepted real HTTP restart before removing both shells", async () => {
  const published = deferred<void>(),
    entered = deferred<void>(),
    release = deferred<void>()
  const removals: string[] = []
  let count = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method === "POST") {
        const id = `shell-${++count}`
        if (count === 2) {
          entered.resolve()
          await release.promise
        }
        return Response.json({ id, title: "Terminal 1" })
      }
      removals.push(new URL(request.url).pathname.split("/").at(-1)!)
      return Response.json(true)
    },
  })
  const client = createKiloClient({ baseUrl: server.url.toString() })
  const router = new TerminalRouter({
    getClient: () => client,
    getClientAsync: async () => client,
    getServerConfig: () => ({ baseUrl: server.url.toString(), password: "fixture" }),
    getRoot: () => os.tmpdir(),
    getWorktreePath: () => undefined,
    getProjectId: () => undefined,
    log: () => undefined,
    post: () => published.resolve(),
    getTerminalFont: () => ({ fontFamily: "mono", fontSize: 12 }),
  })
  try {
    router.handle({ type: "agentManager.terminal.create", createId: "one", placement: "tab", worktreeId: null })
    await published.promise
    router.handle({ type: "agentManager.terminal.restart", terminalId: "one" })
    await entered.promise
    const closing = router.capture()
    expect(removals).toEqual([])
    release.resolve()
    await closing
    expect(removals).toEqual(["shell-1", "shell-2"])
  } finally {
    release.resolve()
    await server.stop(true)
  }
})
