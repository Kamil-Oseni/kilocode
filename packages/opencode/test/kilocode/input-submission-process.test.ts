import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withTimeout } from "../../src/util/timeout"

async function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes <= 8 * 1024 * 1024) chunks.push(item.value)
    }
    if (bytes > 8 * 1024 * 1024) throw new Error("Original input fixture output exceeded bound after EOF")
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    reader.releaseLock()
  }
}

for (const mode of ["complete", "partial", "unavailable", "missing", "unidentified"])
  test(`actual ${mode} submission performs one POST and resolves only a complete original saved receipt`, async () => {
    const root = await mkdtemp(join(tmpdir(), "raya-input-submission-"))
    const child = Bun.spawn(
      [process.execPath, "run", "--conditions=browser", "test/kilocode/fixtures/input-submission.ts", mode],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RAYA_INPUT_PROFILE: root,
          HOME: root,
          USERPROFILE: root,
          XDG_DATA_HOME: join(root, "data"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
          RAYA_DB: join(root, "history.sqlite"),
          KILO_DB: join(root, "history.sqlite"),
          RAYA_NO_DAEMON: "1",
          KILO_NO_DAEMON: "1",
          KILO_DISABLE_PROJECT_CONFIG: "1",
          KILO_DISABLE_MODELS_FETCH: "1",
          KILO_DISABLE_AUTOUPDATE: "1",
          KILO_AUTH_CONTENT: "{}",
          RAYA_AUTH_CONTENT: "{}",
          KILO_CONFIG_CONTENT: "",
          RAYA_CONFIG_CONTENT: "",
          KILO_CONFIG: "",
          RAYA_CONFIG: "",
          KILO_CONFIG_DIR: "",
          RAYA_CONFIG_DIR: "",
          KILO_SERVER_PASSWORD: "",
          RAYA_SERVER_PASSWORD: "",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const streams = [collect(child.stdout), collect(child.stderr)]
    const state = { forced: false }
    try {
      const [code, stdout, stderr] = await withTimeout(
        Promise.all([child.exited, ...streams]),
        60_000,
        `Original submission fixture ${root}`,
      )
      await Bun.write(join(root, "stdout.log"), stdout)
      await Bun.write(join(root, "stderr.log"), stderr)
      expect(code, `Original submission fixture failed ${root}: ${stderr}`).toBe(0)
      const receipt = await Bun.file(join(root, "submission.json")).json()
      expect(receipt.mode).toBe(mode)
      expect(receipt.realModelInference).toBe(false)
      expect(receipt.cleanup).toEqual([])
      expect(receipt.sources.before).toHaveLength(5)
      expect(receipt.sources.after).toEqual(receipt.sources.before)
      expect(receipt.ledger.filter((item: { method: string }) => item.method === "POST")).toHaveLength(1)
      expect(receipt.outcome.accepted).toBe(mode === "complete")
      expect(receipt.rows).toHaveLength(mode === "missing" ? 0 : 1)
      expect(receipt.after.content).toEqual(mode === "complete" ? null : receipt.content)
      expect(receipt.after.mutation).toBe(`${mode === "complete" ? "accepted" : "send"}:${receipt.message}`)
      expect(receipt.retirement.failed).toBe(mode === "partial")
    } finally {
      if (child.exitCode === null) {
        state.forced = true
        child.kill("SIGKILL")
      }
      const [code, stdout, stderr] = await withTimeout(
        Promise.all([child.exited, ...streams]),
        10_000,
        `Original submission fixture did not close ${root}`,
      )
      await Bun.write(join(root, "stdout.log"), stdout)
      await Bun.write(join(root, "stderr.log"), stderr)
      await Bun.write(
        join(root, "process.json"),
        JSON.stringify({ pid: child.pid, code, forced: state.forced, stdoutEOF: true, stderrEOF: true, joined: true }),
      )
      expect(state.forced).toBe(false)
    }
  }, 80_000)
