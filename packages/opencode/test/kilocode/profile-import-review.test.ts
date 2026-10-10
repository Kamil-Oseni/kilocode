import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { ImportReviewSchema } from "@opencode-ai/core/kilocode/profile-import-review"

const directory = path.resolve(import.meta.dir, "../..")
const fixture = path.join(import.meta.dir, "fixtures/profile-import-review.ts")
const entry = path.join(directory, "src/kilocode/cli/entry.ts")
const metadata = z
  .object({ file: z.string(), sha256: z.string(), id: z.string(), workspaces: z.array(z.string()) })
  .strict()

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const digest = createHash("sha256")
  const state = { bytes: 0, tail: Buffer.alloc(0), eof: false }
  for (;;) {
    const next = await reader.read()
    if (next.done) {
      state.eof = true
      break
    }
    digest.update(next.value)
    state.bytes += next.value.length
    state.tail = Buffer.concat([state.tail, next.value]).subarray(-1024 * 1024)
  }
  return { ...state, sha256: digest.digest("hex"), text: state.tail.toString("utf8") }
}

async function child(args: string[], input: string, env: Record<string, string | undefined>) {
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "--conditions=browser", ...args], {
    cwd: directory,
    env: { ...Bun.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const stdout = drain(process.stdout)
  const stderr = drain(process.stderr)
  await Promise.resolve(process.stdin.write(input))
  await Promise.resolve(process.stdin.end())
  const [exit, out, err] = await Promise.all([process.exited, stdout, stderr])
  expect(out.eof).toBe(true)
  expect(err.eof).toBe(true)
  return { pid: process.pid, exit, stdout: out, stderr: err }
}

test("early archive inspection authenticates encrypted metadata without realizing active Global roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-import-review-test-"))
  const trap = path.join(root, "active-must-not-exist")
  const env = {
    // Bun selects its own cache before JavaScript can isolate lazy product dependencies.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "interpreter-cache"),
    HOME: trap,
    USERPROFILE: trap,
    KILO_TEST_HOME: trap,
    LOCALAPPDATA: trap,
    XDG_DATA_HOME: trap,
    XDG_CONFIG_HOME: trap,
    XDG_STATE_HOME: trap,
    XDG_CACHE_HOME: trap,
    RAYA_DB: path.join(trap, "active.db"),
    KILO_DB: path.join(trap, "active.db"),
  }
  const state = { passed: false, receipts: [] as Awaited<ReturnType<typeof child>>[] }
  try {
    const prepared = await child([fixture, root], "", env)
    state.receipts.push(prepared)
    expect(prepared.exit).toBe(0)
    const archive = metadata.parse(JSON.parse(prepared.stdout.text))
    const original = await readFile(archive.file)
    const invoke = async (
      file = archive.file,
      digest = archive.sha256,
      secret = JSON.stringify({ password: "test private review passphrase" }),
    ) => {
      const result = await child([entry, "profile-import-review", file, "--sha256", digest], secret, env)
      state.receipts.push(result)
      return result
    }
    const result = await invoke()
    expect(result.exit).toBe(0)
    expect(result.stdout.bytes).toBeLessThanOrEqual(1024 * 1024)
    const review = ImportReviewSchema.parse(JSON.parse(result.stdout.text))
    expect(review.archive.id).toBe(archive.id)
    expect(review.archive.sha256).toBe(archive.sha256)
    expect(review.workspaces.map((item) => item.source)).toEqual(archive.workspaces)
    expect(review.workspaces[0]).toEqual({
      source: archive.workspaces[0],
      kind: "managed",
      project: "project-日本語",
      name: "branch-café",
      destination: ["data", "kilo", "worktree", "project-日本語", "branch-café"],
    })
    expect(review.workspaces[1].kind).toBe("ordinary")
    expect(review.activation).toBe("held")
    expect(review.replay).toBe(false)
    expect(result.stdout.text).not.toContain("PRIVATE_NOTE_NOT_METADATA")
    expect(result.stdout.text).not.toContain("test private review passphrase")
    for (const result of [
      await invoke(archive.file, archive.sha256, JSON.stringify({ password: "wrong private passphrase" })),
      await invoke(archive.file, "0".repeat(64)),
      await invoke(archive.file, archive.sha256, "x".repeat(4097)),
      await invoke(archive.file, archive.sha256, '{"password":"short"}'),
      await invoke(
        archive.file,
        archive.sha256,
        JSON.stringify({ password: "test private review passphrase", extra: true }),
      ),
      await invoke(root),
    ]) {
      expect(result.exit).toBe(1)
      expect(result.stdout.bytes).toBe(0)
      expect(result.stderr.text).not.toContain("PRIVATE_NOTE_NOT_METADATA")
    }
    const malformed = path.join(root, "malformed.json")
    await writeFile(malformed, Buffer.from([0xff, 0xfe]))
    const refused = await invoke(
      malformed,
      createHash("sha256")
        .update(await readFile(malformed))
        .digest("hex"),
    )
    expect(refused.exit).toBe(1)
    expect(refused.stdout.bytes).toBe(0)
    expect(await readFile(archive.file)).toEqual(original)
    expect(
      await access(trap).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    state.passed = true
  } finally {
    if (state.passed) await rm(root, { recursive: true })
    if (!state.passed) await writeFile(path.join(root, "failure.json"), JSON.stringify(state.receipts, null, 2))
  }
}, 180_000)

test("inspection refuses an authenticated archive requiring more than 128 workspace mappings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-import-review-capacity-"))
  const env = { BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "interpreter-cache") }
  const state = { passed: false, receipts: [] as Awaited<ReturnType<typeof child>>[] }
  try {
    const prepared = await child([fixture, root, "129"], "", env)
    state.receipts.push(prepared)
    expect(prepared.exit).toBe(0)
    const archive = metadata.parse(JSON.parse(prepared.stdout.text))
    const result = await child(
      [entry, "profile-import-review", archive.file, "--sha256", archive.sha256],
      JSON.stringify({ password: "test private review passphrase" }),
      env,
    )
    state.receipts.push(result)
    expect(result.exit).toBe(1)
    expect(result.stdout.bytes).toBe(0)
    state.passed = true
  } finally {
    if (state.passed) await rm(root, { recursive: true })
    if (!state.passed) await writeFile(path.join(root, "failure.json"), JSON.stringify(state.receipts, null, 2))
  }
}, 60_000)

test("inspection refuses oversized encoded metadata without returning a truncated mapping", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-import-review-output-"))
  const env = { BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "interpreter-cache") }
  const state = { passed: false, receipts: [] as Awaited<ReturnType<typeof child>>[] }
  try {
    const prepared = await child([fixture, root, "128", "wide"], "", env)
    state.receipts.push(prepared)
    expect(prepared.exit).toBe(0)
    const archive = metadata.parse(JSON.parse(prepared.stdout.text))
    const result = await child(
      [entry, "profile-import-review", archive.file, "--sha256", archive.sha256],
      JSON.stringify({ password: "test private review passphrase" }),
      env,
    )
    state.receipts.push(result)
    expect(result.exit).toBe(1)
    expect(result.stdout.bytes).toBe(0)
    state.passed = true
  } finally {
    if (state.passed) await rm(root, { recursive: true })
    if (!state.passed) await writeFile(path.join(root, "failure.json"), JSON.stringify(state.receipts, null, 2))
  }
}, 60_000)
