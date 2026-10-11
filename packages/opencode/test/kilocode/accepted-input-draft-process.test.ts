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

for (const mode of ["fault", "partial", "marker", "resolved", "live", "reminder", "foreign", "tampered"])
  test(`actual ${mode} input requires complete physical payload before captured draft recovery consumes it`, async () => {
    const failed = mode === "fault" || mode === "partial" || mode === "marker"
    const retained = failed || mode === "foreign" || mode === "tampered"
    const root = await mkdtemp(join(tmpdir(), "raya-input-durability-"))
    const child = Bun.spawn(
      [process.execPath, "run", "--conditions=browser", "test/kilocode/fixtures/accepted-input-draft.ts", mode],
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
        `Original input fixture ${root}`,
      )
      await Bun.write(join(root, "stdout.log"), stdout)
      await Bun.write(join(root, "stderr.log"), stderr)
      expect(code, `Original fixture failed ${root}: ${stderr}`).toBe(0)
      const receipt = await Bun.file(join(root, "input-durability.json")).json()
      expect(receipt.user.info.role).toBe("user")
      expect(receipt.user.parts).toHaveLength(
        mode === "fault"
          ? 0
          : mode === "partial"
            ? 1
            : mode === "reminder" || mode === "tampered"
              ? 5
              : mode === "foreign"
                ? 6
                : 4,
      )
      if (mode === "reminder" || mode === "foreign" || mode === "tampered") {
        expect(receipt.reminder.type).toBe("text")
        expect(receipt.reminder.synthetic).toBe(true)
        expect(receipt.reminder.text).toContain("actual-reverted.txt")
        const part = receipt.user.parts.find((item: { id: string }) => item.id === receipt.reminder.id)
        expect(part.text).toBe(
          mode === "tampered" ? "Externally replaced actual returned reminder" : receipt.reminder.text,
        )
      }
      expect(receipt.retirement.failed).toBe(failed)
      expect(receipt.before.content).toEqual(receipt.content)
      if (retained) expect(receipt.acknowledged.content).toEqual(receipt.content)
      if (mode === "live" || mode === "reminder") {
        expect(receipt.acknowledged.content).toBeNull()
        expect(receipt.acknowledged.mutation).toBe(`accepted:${receipt.message}`)
      }
      // A user header alone cannot consume the only durable copy of its missing payload.
      expect(receipt.after.content, `Original physical input recovery mismatch: ${root}`).toEqual(
        retained ? receipt.content : null,
      )
      expect(receipt.after.mutation).toBe(`${retained ? "send" : "accepted"}:${receipt.message}`)
    } finally {
      if (child.exitCode === null) {
        state.forced = true
        child.kill("SIGKILL")
      }
      const [code, stdout, stderr] = await withTimeout(
        Promise.all([child.exited, ...streams]),
        10_000,
        `Original input fixture did not close ${root}`,
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

test("actual cold lost-ACK input reconciles once across two naturally retired backend processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-input-cold-"))
  const pids: number[] = []
  for (const stage of ["cold", "reopen"]) {
    const child = Bun.spawn(
      [process.execPath, "run", "--conditions=browser", "test/kilocode/fixtures/accepted-input-draft.ts", stage],
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
    pids.push(child.pid)
    const streams = [collect(child.stdout), collect(child.stderr)]
    const state = { forced: false }
    try {
      const [code, stdout, stderr] = await withTimeout(
        Promise.all([child.exited, ...streams]),
        60_000,
        `Cold original input epoch ${stage}: ${root}`,
      )
      await Bun.write(join(root, `${stage}-stdout.log`), stdout)
      await Bun.write(join(root, `${stage}-stderr.log`), stderr)
      expect(code, `Cold input epoch failed ${root}: ${stderr}`).toBe(0)
      const receipt = await Bun.file(join(root, `${stage}.json`)).json()
      expect(receipt.cleanup).toEqual([])
      expect(receipt.retirement.failed).toBe(false)
      expect(receipt.realModelInference).toBe(false)
      if (stage === "cold") {
        expect(receipt.user.parts).toHaveLength(5)
        expect(receipt.after).toEqual(receipt.before)
        expect(receipt.after.content).toEqual(receipt.content)
        expect(receipt.after.mutation).toBe(`send:${receipt.message}`)
        expect(receipt.requests.filter((item: { path: string }) => item.path.endsWith("/message"))).toHaveLength(1)
      }
      if (stage === "reopen") {
        const prior = await Bun.file(join(root, "cold.json")).json()
        expect(receipt.user).toEqual(prior.user)
        expect(receipt.capture).toEqual(prior.capture)
        expect(receipt.before).toEqual(prior.before)
        expect(receipt.sources).toEqual(prior.sources)
        expect(receipt.after.content).toBeNull()
        expect(receipt.after.mutation).toBe(`accepted:${receipt.message}`)
        expect(receipt.after.token.revision).toBe(receipt.before.token.revision + 1)
        expect(receipt.clears).toEqual([`accepted:${receipt.message}`])
        expect(receipt.newer.content.text).toBe("New ordinary draft after cold recovery\n")
        expect(receipt.newer.mutation).toBe("newer-after-cold")
        expect(receipt.requests.every((item: { path: string }) => !item.path.includes("/prompt"))).toBe(true)
      }
    } finally {
      if (child.exitCode === null) {
        state.forced = true
        child.kill("SIGKILL")
      }
      const [code, stdout, stderr] = await withTimeout(
        Promise.all([child.exited, ...streams]),
        10_000,
        `Cold original epoch did not close ${stage}: ${root}`,
      )
      await Bun.write(join(root, `${stage}-stdout.log`), stdout)
      await Bun.write(join(root, `${stage}-stderr.log`), stderr)
      await Bun.write(
        join(root, `${stage}-process.json`),
        JSON.stringify({ pid: child.pid, code, forced: state.forced, stdoutEOF: true, stderrEOF: true, joined: true }),
      )
      expect(state.forced).toBe(false)
    }
  }
  expect(new Set(pids).size).toBe(2)
}, 160_000)
