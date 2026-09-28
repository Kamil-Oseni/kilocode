import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/voice-spoken-restart.ts", import.meta.url))

function spawn(mode: string, root: string) {
  return Bun.spawn([process.execPath, fixture, mode, root], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      KILO_TEST_HOME: path.join(root, "home"),
      KILO_DB: path.join(root, "voice.sqlite"),
      KILO_DISABLE_MODELS_FETCH: "true",
    },
  })
}

async function deadline<T>(work: Promise<T>) {
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer.id = setTimeout(() => reject(new Error("Spoken restart fixture exceeded its deadline")), 20000)
      }),
    ])
  } finally {
    if (timer.id) clearTimeout(timer.id)
  }
}

function report(output: string) {
  if (output.length > 65536) throw new Error("Spoken restart fixture exceeded its output bound")
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("SPOKEN_RESULT "))
  if (!line) throw new Error(`Spoken restart fixture returned no report: ${output}`)
  const value: unknown = JSON.parse(line.slice("SPOKEN_RESULT ".length))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Spoken restart report is invalid")
  return value as Record<string, unknown>
}

async function seed(root: string) {
  const child = spawn("seed", root)
  const reader = child.stdout.getReader()
  const failure = new Response(child.stderr).text()
  try {
    const output = await deadline(
      (async () => {
        let output = ""
        while (!output.includes("\nREADY\n")) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error(await failure)
          output += new TextDecoder().decode(chunk.value)
          if (output.length > 65536) throw new Error("Spoken seed exceeded its output bound")
        }
        return output
      })(),
    )
    return report(output)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    reader.releaseLock()
  }
}

async function run(mode: string, root: string) {
  const child = spawn(mode, root)
  try {
    const output = await deadline(
      Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
    )
    if (output[2] !== 0) throw new Error(output[1])
    return report(output[0])
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
}

async function remove(root: string) {
  const target = path.resolve(root)
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("raya-spoken-restart-"))
    throw new Error("Spoken fixture cleanup escaped the exact disposable root")
  await rm(target, { recursive: true, force: true })
}

test("committed spoken context survives an actual killed owner and recovers only through a fresh same-task binding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-spoken-restart-"))
  try {
    const first = await seed(root)
    expect(first.duplicate).toBe(true)
    expect(first.conflict).toBe(true)
    const second = await run("recover", root)
    expect(second.oldClosed).toBe(true)
    expect(second.oldWriteRefused).toBe(true)
    expect(second.newCapability).toBe(true)
    expect(second.scopeRefused).toBe(true)
    expect(second.ordered).toEqual(["I want quiet company.", "We can take this slowly."])
    expect(second.excluded).toBe(true)
    expect(second.work).toBe(0)
  } finally {
    await remove(root)
  }
}, 60000)

for (const mode of ["deleted", "expired", "legacy", "corrupt", "future"])
  test(`fresh-process spoken recovery handles ${mode} history without resurrection or replay`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "raya-spoken-restart-"))
    try {
      await seed(root)
      const result = await run(mode, root)
      expect(result.safe).toBe(true)
      expect(result.work).toBe(0)
    } finally {
      await remove(root)
    }
  }, 60000)
