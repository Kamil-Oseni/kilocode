import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeSemanticHost } from "../../src/services/computer-use/desktop-semantic-host"

const target = { windowID: "0xAB", identity: "A".repeat(64), location: "pid:7;title:Transport;bounds:0,0,400,300" }
const fixture = join(import.meta.dir, "fixtures", "desktop-semantic-child.ts")

async function stopped(pid: number) {
  const until = performance.now() + 3_000
  while (performance.now() < until) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return
      throw error
    }
    await Bun.sleep(10)
  }
  throw new Error("Semantic child did not exit")
}

test("semantic host keeps one real child warm and retires it on cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raya-semantic-host-"))
  const witness = join(dir, "pid")
  const host = new NativeSemanticHost(process.execPath, 2_000, [fixture, "normal", witness])
  try {
    const first = await host.read(target)
    const pid = Number(readFileSync(witness, "utf8"))
    expect(first.semantics.status).toBe("available")
    expect(first.age).toBeLessThanOrEqual(125)
    const second = await host.read(target)
    expect(Number(readFileSync(witness, "utf8"))).toBe(pid)
    expect(second.request).not.toBe(first.request)
    host.cancel()
    await stopped(pid)
    expect((await host.read(target)).generation).toBeGreaterThan(first.generation)
    const replacement = Number(readFileSync(witness, "utf8"))
    expect(replacement).not.toBe(pid)
    host.cancel()
    await stopped(replacement)
  } finally {
    host.cancel()
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)

test("semantic timeout kills the real blocked child and discards its generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raya-semantic-timeout-"))
  const witness = join(dir, "pid")
  const host = new NativeSemanticHost(process.execPath, 500, [fixture, "hang", witness])
  try {
    await host.read(target)
    const pid = Number(readFileSync(witness, "utf8"))
    const pending = host.read(target)
    await expect(host.read(target)).rejects.toThrow(/already active/)
    await expect(pending).rejects.toThrow(/timed out/)
    await stopped(pid)
    expect((await host.read(target)).semantics.status).toBe("available")
    const replacement = Number(readFileSync(witness, "utf8"))
    host.cancel()
    await stopped(replacement)
  } finally {
    host.cancel()
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)

for (const mode of ["overflow", "wrong", "malformed", "refused"]) {
  test(`semantic host refuses real child ${mode} output without disclosing it`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "raya-semantic-refusal-"))
    const witness = join(dir, "pid")
    const host = new NativeSemanticHost(process.execPath, 2_000, [fixture, mode, witness])
    try {
      const error = await host.read(target).catch((value: unknown) => value)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain("must not appear")
      if (mode === "refused") expect((error as Error).message).toContain("target_changed")
      await stopped(Number(readFileSync(witness, "utf8")))
    } finally {
      host.cancel()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)
}

test("cancellation before dispatch never starts a child", async () => {
  const host = new NativeSemanticHost(process.execPath, 2_000, [fixture, "normal", "must-not-create"])
  const pending = host.read(target)
  host.cancel()
  await expect(pending).rejects.toThrow(/cancelled/)
})

test("retired startup rejection cannot cancel an immediately queued replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raya-semantic-generation-"))
  const witness = join(dir, "pid")
  const host = new NativeSemanticHost(process.execPath, 2_000, [fixture, "normal", witness])
  try {
    const pending = host.read(target).catch((value: unknown) => value)
    // Allow the old read to wait for real child readiness, then replace it immediately.
    await Promise.resolve()
    host.cancel()
    const replacement = host.read(target)
    expect(await pending).toBeInstanceOf(Error)
    expect((await replacement).semantics.status).toBe("available")
    const pid = Number(readFileSync(witness, "utf8"))
    host.cancel()
    await stopped(pid)
  } finally {
    host.cancel()
    rmSync(dir, { recursive: true, force: true })
  }
}, 10_000)

const native = process.env.RAYA_SEMANTIC_FIXTURE_PATH
test.skipIf(process.platform !== "win32" || !native || !existsSync(native))(
  "production host stops an actual hung Windows UIA provider on a never-activated desktop",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "raya-semantic-provider-"))
    const witness = join(dir, "entered")
    const host = new NativeSemanticHost(native!, 5_000, ["--serve-hang", witness])
    try {
      await expect(host.read(target)).rejects.toThrow(/timed out/)
      const marker = readFileSync(witness, "utf8")
      expect(marker).toMatch(/^pid:\d+;provider_entered$/)
      const pid = Number(/^pid:(\d+)/.exec(marker)![1])
      await stopped(pid)
      expect(existsSync(witness)).toBe(true)
    } finally {
      host.cancel()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  15_000,
)

const binary = process.env.RAYA_SEMANTIC_BINARY
test.skipIf(process.platform !== "win32" || !binary || !existsSync(binary))(
  "production native worker refuses a mismatched target before any provider read",
  async () => {
    const host = new NativeSemanticHost(binary!, 2_000)
    try {
      await expect(host.read(target)).rejects.toThrow(/target_changed/)
    } finally {
      host.cancel()
    }
  },
  5_000,
)
