import { hostname } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Git } from "@/git"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const fixture = fileURLToPath(new URL("./fixtures/chief-branches-restart.ts", import.meta.url))

function spawn(mode: string, dir: string, root: string, id: string, time: number, child: string) {
  return Bun.spawn([process.execPath, fixture, mode, dir, id, String(time), child], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      KILO_TEST_HOME: path.join(root, "home"),
      KILO_DB: ":memory:",
    },
  })
}

async function deadline<T>(work: Promise<T>, ms: number) {
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer.id = setTimeout(() => reject(new Error(`Chief branch fixture timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer.id) clearTimeout(timer.id)
  }
}

async function admit(dir: string, root: string, id: string, time: number, child: string) {
  const proc = spawn("admit", dir, root, id, time, child)
  const reader = proc.stdout.getReader()
  try {
    const output = await deadline(
      (async () => {
        const chunks: string[] = []
        while (!chunks.join("").includes("\nREADY\n")) {
          const part = await reader.read()
          if (part.done) throw new Error(await new Response(proc.stderr).text())
          chunks.push(new TextDecoder().decode(part.value))
        }
        return chunks.join("")
      })(),
      20_000,
    )
    const saved = output.split("\n").find((line) => line.startsWith("CHIEF_SAVED "))
    if (!saved) throw new Error(`Chief admission fixture did not report its record: ${output}`)
    return JSON.parse(saved.slice("CHIEF_SAVED ".length))
  } finally {
    proc.kill("SIGKILL")
    await proc.exited
    reader.releaseLock()
  }
}

async function reconcile(dir: string, root: string, id: string, time: number, child: string) {
  const proc = spawn("reconcile", dir, root, id, time, child)
  try {
    const [output, failure, code] = await deadline(
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      20_000,
    )
    if (code !== 0) throw new Error(failure)
    const saved = output.split("\n").find((line) => line.startsWith("CHIEF_RECOVERED "))
    if (!saved) throw new Error(`Chief reconciliation fixture did not report its record: ${output}`)
    return JSON.parse(saved.slice("CHIEF_RECOVERED ".length))
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL")
    await proc.exited
  }
}

it.live(
  "reconciles a real stopped admitting process without replaying its branch",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const dir = path.join(root, "storage")
      const id = `ses_chief_${crypto.randomUUID()}`
      const child = `ses_child_${crypto.randomUUID()}`
      const time = Date.now()
      const first = yield* Effect.promise(() => admit(dir, root, id, time, child))
      expect(first.admitted.owner).toEqual({ host: hostname(), pid: first.pid })
      expect(first.saved.branches[0]).toMatchObject({
        state: "admitted",
        callID: "task-1",
        sessionID: child,
        owner: first.admitted.owner,
      })

      const second = yield* Effect.promise(() => reconcile(dir, root, id, time, child))
      expect(second.before).toEqual(first.saved)
      expect(second.recovered.branches[0]).toMatchObject({
        state: "unknown",
        callID: "task-1",
        sessionID: child,
        owner: first.admitted.owner,
      })
      expect(second.recovered.branches[0].result).toContain("Do not replay automatically")
      expect(second.recovered.branches[1].state).toBe("planned")
      expect(second.again).toEqual(second.recovered)
      expect(second.replay).toBe(true)
    }),
  30_000,
)
