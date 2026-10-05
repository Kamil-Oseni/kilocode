import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, copyFile, mkdir, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { bindTask } from "../../src/agent-manager/run/task-native"
import { TaskLifetime, type TaskExit } from "../../src/agent-manager/run/task-lifetime"
import { observe } from "@opencode-ai/core/kilocode/source-observer"

async function fixture(code: number) {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-native-task-"))
  await mkdir(path.join(root, "bin"))
  const origin = path.resolve(import.meta.dir, "../../../core/native/kilocode/bin")
  const helper = path.join(root, "bin", "raya-process-host.exe")
  await copyFile(path.join(origin, "raya-process-host.exe"), helper)
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
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  child.stderr.resume()
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve())
    child.once("error", reject)
  })
  return { root, helper, child, closed }
}

for (const code of [0, 7])
  test.skipIf(process.platform !== "win32")(
    `actual exact native task exit${code} wins over undefined task end during stop`,
    async () => {
      const run = await fixture(code)
      const exits: TaskExit[] = []
      const lifetime = new TaskLifetime(
        (exit) => exits.push(exit),
        (pid) => bindTask(pid, run.helper),
      )
      lifetime.started(run.child.pid!)
      let stops = 0
      try {
        await lifetime.stop(() => {
          stops++
          lifetime.ended()
          lifetime.end()
          run.child.stdin.end("release\n")
        })
        expect(await run.closed).toBe(code)
        expect(exits).toEqual([{ exitCode: code }])
        await lifetime.stop(() => {
          stops++
        })
        expect(stops).toBe(1)
        expect(() => process.kill(run.child.pid!, 0)).toThrow()
        await writeFile(
          path.join(run.root, "receipt.json"),
          JSON.stringify({
            code,
            stops,
            exits,
            pid: run.child.pid,
            taskProcessOnly: true,
            completeProfileCoverage: false,
          }),
        )
      } finally {
        lifetime.dispose()
        if (run.child.exitCode === null) run.child.kill()
        await run.closed
      }
    },
    30000,
  )

test.skipIf(process.platform !== "win32")(
  "native task helper tampering refuses before terminate and stays sticky",
  async () => {
    const run = await fixture(0)
    const lifetime = new TaskLifetime(
      () => undefined,
      (pid) => bindTask(pid, run.helper),
    )
    await writeFile(
      path.join(path.dirname(run.helper), "raya-process-host.json"),
      JSON.stringify({ version: 1, exe: "0".repeat(64) }),
    )
    lifetime.started(run.child.pid!)
    let stops = 0
    try {
      await expect(
        lifetime.stop(() => {
          stops++
        }),
      ).rejects.toThrow("packaged helper")
      await expect(
        lifetime.stop(() => {
          stops++
        }),
      ).rejects.toThrow("packaged helper")
      expect(stops).toBe(0)
      expect(run.child.exitCode).toBe(null)
    } finally {
      run.child.stdin.end("release\n")
      await run.closed
      lifetime.dispose()
    }
  },
  30000,
)

test.skipIf(process.platform !== "win32")(
  "already exited task PID never becomes native closure from absence",
  async () => {
    const run = await fixture(0)
    run.child.stdin.end("release\n")
    await run.closed
    await expect(bindTask(run.child.pid!, run.helper)).rejects.toThrow()
    const exits: TaskExit[] = []
    const lifetime = new TaskLifetime(
      (exit) => exits.push(exit),
      (pid) => bindTask(pid, run.helper),
    )
    lifetime.started(run.child.pid!)
    await expect(lifetime.stop(() => undefined)).rejects.toThrow()
    expect(exits).toEqual([{ error: "Run task exit was not confirmed" }])
    lifetime.dispose()
  },
  30000,
)

test("confirmed task event completion stays compatible and unknown completion refuses", async () => {
  const good: TaskExit[] = [],
    bad: TaskExit[] = []
  const first = new TaskLifetime((exit) => good.push(exit))
  first.ended(3)
  await first.stop(() => {
    throw new Error("Must not stop completed task")
  })
  expect(good).toEqual([{ exitCode: 3 }])
  const second = new TaskLifetime((exit) => bad.push(exit))
  second.ended()
  await expect(second.stop(() => undefined)).rejects.toThrow("not confirmed")
  expect(bad).toEqual([{ error: "Run task exit was not confirmed" }])
})

test.skipIf(process.platform !== "win32")(
  "held native handle confirms forced task exit without inventing zero",
  async () => {
    const run = await fixture(0)
    const exits: TaskExit[] = []
    const lifetime = new TaskLifetime(
      (exit) => exits.push(exit),
      (pid) => bindTask(pid, run.helper),
    )
    lifetime.started(run.child.pid!)
    try {
      await lifetime.stop(() => {
        lifetime.ended()
        run.child.kill()
      })
      const code = await run.closed
      expect(code).not.toBe(0)
      expect(exits).toHaveLength(1)
      expect(exits[0]!.exitCode).toBeGreaterThan(0)
      expect(exits[0]!.error).toBeUndefined()
      expect(() => process.kill(run.child.pid!, 0)).toThrow()
    } finally {
      lifetime.dispose()
      if (run.child.exitCode === null) run.child.kill()
      await run.closed
    }
  },
  30000,
)

test.skipIf(process.platform !== "win32")(
  "bound task disappearing before stop refuses rather than accepting PID absence",
  async () => {
    const run = await fixture(0)
    const owner = await bindTask(run.child.pid!, run.helper)
    run.child.stdin.end("release\n")
    await run.closed
    let stopped = false
    await expect(
      owner.stop(() => {
        stopped = true
      }),
    ).rejects.toThrow()
    expect(stopped).toBe(false)
  },
)

test.skipIf(process.platform !== "win32")(
  "raw task termination failure closes observer and remains sticky",
  async () => {
    const run = await fixture(0)
    const exits: TaskExit[] = []
    const lifetime = new TaskLifetime(
      (exit) => exits.push(exit),
      (pid) => bindTask(pid, run.helper),
    )
    lifetime.started(run.child.pid!)
    let stops = 0
    try {
      await expect(
        lifetime.stop(() => {
          stops++
          throw new Error("Task termination failed")
        }),
      ).rejects.toThrow("Task termination failed")
      await expect(
        lifetime.stop(() => {
          stops++
        }),
      ).rejects.toThrow("Task termination failed")
      expect(stops).toBe(1)
      expect(exits).toEqual([{ error: "Run task exit was not confirmed" }])
      expect(run.child.exitCode).toBe(null)
    } finally {
      run.child.stdin.end("release\n")
      await run.closed
      lifetime.dispose()
    }
  },
  30000,
)

test.skipIf(process.platform !== "win32")(
  "actual kernel observer refuses a changed task birth before termination",
  async () => {
    const run = await fixture(0)
    const owner = await bindTask(run.child.pid!, run.helper)
    const watcher = observe({ ...owner.identity, birth: String(BigInt(owner.identity.birth) + 1n), timeout: 10000 })
    try {
      await expect(watcher.ready).rejects.toThrow()
      await expect(watcher.done).rejects.toThrow()
      expect(run.child.exitCode).toBe(null)
    } finally {
      await watcher.close()
      run.child.stdin.end("release\n")
      await run.closed
    }
  },
  30000,
)

test.skipIf(process.platform !== "win32")(
  "ten-second native stop deadline refuses and joins observer without killing unknown work",
  async () => {
    const run = await fixture(0)
    const exits: TaskExit[] = []
    const lifetime = new TaskLifetime(
      (exit) => exits.push(exit),
      (pid) => bindTask(pid, run.helper),
    )
    lifetime.started(run.child.pid!)
    let stops = 0
    const before = Date.now()
    try {
      await expect(
        lifetime.stop(() => {
          stops++
          lifetime.ended()
        }),
      ).rejects.toThrow()
      expect(Date.now() - before).toBeGreaterThanOrEqual(9900)
      expect(stops).toBe(1)
      expect(run.child.exitCode).toBe(null)
      expect(exits).toEqual([{ error: "Run task exit was not confirmed" }])
      await expect(
        lifetime.stop(() => {
          stops++
        }),
      ).rejects.toThrow()
      expect(stops).toBe(1)
    } finally {
      run.child.stdin.end("release\n")
      await run.closed
      lifetime.dispose()
    }
  },
  30000,
)
