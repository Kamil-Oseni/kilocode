import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { stopped } from "@/kilocode/task/owner"

const fixture = fileURLToPath(new URL("./fixtures/owner-birth.ts", import.meta.url))

test("distinguishes a live foreign process from a reused owner PID", async () => {
  if (process.platform !== "win32" && process.platform !== "linux") return
  const proc = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" })
  const reader = proc.stdout.getReader()
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  try {
    const output = await Promise.race([
      (async () => {
        const chunks: string[] = []
        while (!chunks.join("").includes("\nREADY\n")) {
          const part = await reader.read()
          if (part.done) throw new Error(await new Response(proc.stderr).text())
          chunks.push(new TextDecoder().decode(part.value))
        }
        return chunks.join("")
      })(),
      new Promise<never>((_, reject) => {
        timer.id = setTimeout(() => reject(new Error("owner birth fixture did not become ready")), 20_000)
      }),
    ])
    const identity = JSON.parse(output.split("\n")[0])
    expect(identity.pid).toBe(proc.pid)
    expect(identity.birth).toBeTruthy()
    expect(stopped(identity)).toBe(false)
    expect(stopped({ ...identity, birth: `${identity.birth}-older` })).toBe(true)
  } finally {
    if (timer.id) clearTimeout(timer.id)
    proc.kill("SIGKILL")
    await proc.exited
    reader.releaseLock()
  }
}, 30_000)
