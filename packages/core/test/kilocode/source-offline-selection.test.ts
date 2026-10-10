import assert from "node:assert/strict"
import * as processes from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, spyOn, test } from "bun:test"
import { assertImage, discover, startup, withImage } from "../../src/kilocode/source-offline"
import { select } from "../../src/kilocode/source-offline-selection"

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  )

test.skipIf(process.platform !== "win32")(
  "legacy encrypted native journal is recovered and tampering refuses before stable creation",
  async () => {
    await fixture(async (cfg) => {
      const control = await withImage(
        { ...cfg.input, helper: cfg.helper, registry: cfg.legacy },
        async (image) => assertImage(image, cfg.input.roots).control,
      )
      const file = path.join(control, "journal.bin")
      const original = await readFile(file)
      expect(original.byteLength).toBeGreaterThan(0)
      const changed = Buffer.from(original)
      changed[changed.length - 1] ^= 1
      await writeFile(file, changed)
      await assert.rejects(select({ account: cfg.account, env: cfg.env, helper: cfg.helper }))
      expect(await readFile(file)).toEqual(changed)
      expect(await exists(cfg.stable)).toBe(false)
      await writeFile(file, original)
      const selection = await select({ account: cfg.account, env: cfg.env, helper: cfg.helper })
      expect(selection.receipts).toHaveLength(1)
      expect(selection.receipts[0].recovered).toBe(true)
      expect(await exists(cfg.stable)).toBe(false)
      expect(await readFile(file)).toEqual(original)
      expect(await readFile(path.join(cfg.source, "note.json"), "utf8")).toBe('{"owned":"original café 日本語"}')
    })
  },
  60_000,
)

test.skipIf(process.platform !== "win32")(
  "first held callback failure permanently fences its selected registry lifetime",
  async () => {
    await fixture(async (cfg) => {
      const selection = await select({ account: cfg.account, env: cfg.env, helper: cfg.helper })
      await assert.rejects(
        selection.withImage(cfg.input, async (image) => {
          assertImage(image, cfg.input.roots)
          throw new Error("Owned first callback failure")
        }),
      )
      const called = { value: false }
      await assert.rejects(
        selection.withImage(cfg.input, async () => {
          called.value = true
        }),
        /lifetime refused/,
      )
      expect(called.value).toBe(false)
      expect(await readFile(path.join(cfg.source, "note.json"), "utf8")).toBe('{"owned":"original café 日本語"}')
    })
  },
  60_000,
)

test.skipIf(process.platform !== "win32")(
  "original missing-leaf ancestor replacement refuses before first acquisition",
  async () => {
    await fixture(async (cfg) => {
      const selection = await select({ account: cfg.account, env: cfg.env, helper: cfg.helper })
      await rename(cfg.account, `${cfg.account}-original`)
      await mkdir(cfg.account)
      const called = { value: false }
      await assert.rejects(
        selection.withImage(cfg.input, async () => {
          called.value = true
        }),
      )
      expect(called.value).toBe(false)
      expect(await exists(cfg.stable)).toBe(false)
    })
  },
  60_000,
)

test.skipIf(process.platform !== "win32")(
  "explicit startup alias remains refused without selecting the stable default",
  async () => {
    await fixture(async (cfg) => {
      await mkdir(path.dirname(cfg.legacy))
      await symlink(cfg.source, cfg.legacy, "junction")
      await discover([cfg.stable], cfg.helper)
      await assert.rejects(startup({ registry: cfg.legacy, helper: cfg.helper }))
      expect(await exists(cfg.stable)).toBe(false)
    })
  },
  60_000,
)

test.skipIf(process.platform !== "win32")(
  "missing account profile retains negative evidence through both actual images below existing AppData",
  async () => {
    await fixture(async (cfg) => {
      const profile = path.join(cfg.account, ".raya-profile")
      const input = {
        roots: [{ kind: "json" as const, path: profile }],
        policy: { version: 1 as const, directories: [profile], files: [] },
      }
      expect(await exists(profile)).toBe(false)
      const selection = await select({ account: cfg.account, env: cfg.env, helper: cfg.helper })
      expect(await exists(cfg.stable)).toBe(false)
      const controls: string[] = []
      for (const phase of [1, 2]) {
        await selection.withImage(input, async (image) => {
          const value = assertImage(image, input.roots)
          expect(value.roots).toHaveLength(1)
          expect(value.roots[0].absence?.namespace).toBe(cfg.account)
          expect(value.files).toHaveLength(0)
          expect(path.dirname(value.control)).toBe(cfg.stable)
          controls.push(value.control)
          expect(controls).toHaveLength(phase)
        })
        expect(await exists(profile)).toBe(false)
      }
      expect(new Set(controls).size).toBe(2)
    })
  },
  60_000,
)

for (const mode of ["absent", "occupied", "redirected"])
  test.skipIf(process.platform !== "win32")(
    `account AppData ${mode} refuses selection without realizing its stable registry`,
    async () => {
      await fixture(async (cfg) => {
        assert.equal(path.relative(cfg.root, cfg.parent), path.join("account", "AppData"))
        assert.equal(await realpath(cfg.parent), cfg.parent)
        await rmdir(cfg.parent)
        if (mode === "occupied") await writeFile(cfg.parent, "owned occupied parent")
        if (mode === "redirected") await symlink(cfg.source, cfg.parent, "junction")
        await assert.rejects(select({ account: cfg.account, env: cfg.env, helper: cfg.helper }))
        expect(await exists(cfg.stable)).toBe(false)
        expect(await exists(path.join(cfg.source, ".raya-offline-recovery"))).toBe(false)
        expect(await readFile(path.join(cfg.source, "note.json"), "utf8")).toBe('{"owned":"original café 日本語"}')
      })
    },
    60_000,
  )

test.skipIf(process.platform !== "win32")(
  "AppData parent substitution after first held image refuses its second acquisition",
  async () => {
    await fixture(async (cfg) => {
      const selection = await select({ account: cfg.account, env: cfg.env, helper: cfg.helper })
      await selection.withImage(cfg.input, async (image) => {
        assertImage(image, cfg.input.roots)
      })
      await rename(cfg.parent, `${cfg.parent}-original`)
      await mkdir(cfg.parent)
      const called = { value: false }
      await assert.rejects(
        selection.withImage(cfg.input, async () => {
          called.value = true
        }),
      )
      expect(called.value).toBe(false)
      expect(await exists(cfg.stable)).toBe(false)
      expect(await readFile(path.join(cfg.source, "note.json"), "utf8")).toBe('{"owned":"original café 日本語"}')
    })
  },
  60_000,
)

async function fixture(body: (cfg: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const cfg = await setup()
  const events: {
    pid?: number
    exit?: number | null
    signal?: NodeJS.Signals | null
    close: boolean
    stdout: { bytes: number; eof: boolean; sha256?: string }
    stderr: { bytes: number; eof: boolean; sha256?: string }
  }[] = []
  const original = processes.spawn
  const state = { passed: false }
  const delegate = new Proxy(original, {
    apply(target, context, args) {
      const child: processes.ChildProcess = Reflect.apply(target, context, args)
      const values: unknown = args[1]
      if (!Array.isArray(values) || values[0] !== "profile-offline") return child
      const row: (typeof events)[number] = {
        pid: child.pid,
        close: false,
        stdout: { bytes: 0, eof: false },
        stderr: { bytes: 0, eof: false },
      }
      events.push(row)
      for (const name of ["stdout", "stderr"] as const) {
        const stream = child[name]
        assert(stream)
        const digest = createHash("sha256")
        stream.on("data", (bytes: Buffer) => {
          digest.update(bytes)
          row[name].bytes += bytes.length
        })
        stream.once("end", () => {
          row[name].eof = true
          row[name].sha256 = digest.digest("hex")
        })
      }
      child.once("exit", (code, signal) => {
        row.exit = code
        row.signal = signal
      })
      child.once("close", () => {
        row.close = true
      })
      return child
    },
  })
  const observer = spyOn(processes, "spawn").mockImplementation(delegate)
  try {
    await body(cfg)
    expect(events.length).toBeGreaterThan(0)
    for (const row of events) {
      expect(row.pid).toBeGreaterThan(0)
      expect(row.close).toBe(true)
      expect(row.signal).toBeNull()
      expect(row.stdout.eof).toBe(true)
      expect(row.stderr.eof).toBe(true)
      expect(row.stdout.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(row.stderr.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(row.exit === 0 || row.exit === 1).toBe(true)
    }
    state.passed = true
  } finally {
    observer.mockRestore()
    if (!state.passed) await writeFile(path.join(cfg.root, "failure.json"), JSON.stringify({ events }, null, 2))
    if (state.passed) await rm(cfg.root, { recursive: true })
  }
}

async function setup() {
  assert(process.env.RAYA_OFFLINE_TEST_HELPER, "Require the explicitly compiled discovery-capable private helper")
  const executable = await realpath(process.env.RAYA_OFFLINE_TEST_HELPER)
  const helper = {
    executable,
    digest: createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
  }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "raya-offline-selection-")))
  const account = path.join(root, "account")
  const parent = path.join(account, "AppData")
  const local = path.join(root, "local")
  const source = path.join(root, "source")
  await Promise.all([mkdir(parent, { recursive: true }), mkdir(local), mkdir(source)])
  await writeFile(path.join(source, "note.json"), '{"owned":"original café 日本語"}')
  return {
    root,
    account,
    parent,
    local,
    source,
    helper,
    env: { LOCALAPPDATA: local },
    legacy: path.join(local, "Raya", "offline-recovery"),
    stable: path.join(parent, ".raya-offline-recovery"),
    input: {
      roots: [{ kind: "json" as const, path: source }],
      policy: { version: 1 as const, directories: [source], files: [] },
    },
  }
}

test.skipIf(process.platform !== "win32")(
  "cold default selection recovers a genuinely minted legacy phase-zero journal after exact guardian fault",
  async () => {
    const cfg = await setup()
    const child = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(import.meta.dir, "fixtures", "source-offline-negative-crash.ps1"),
        "-Root",
        cfg.root,
        "-Helper",
        cfg.helper.executable,
        "-Bun",
        process.execPath,
        "-Mode",
        "guardian",
        "-Layout",
        "legacy-selection",
      ],
      {
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")),
          PSModulePath: path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "Modules"),
        },
      },
    )
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const hash = createHash("sha256")
      let bytes = 0
      let tail = Buffer.alloc(0)
      for await (const chunk of stream) {
        bytes += chunk.byteLength
        hash.update(chunk)
        tail = Buffer.concat([tail, chunk]).subarray(-65536)
      }
      return { bytes, digest: hash.digest("hex"), eof: true, tail: tail.toString("utf8") }
    }
    const [code, output, error] = await Promise.all([child.exited, drain(child.stdout), drain(child.stderr)])
    await writeFile(path.join(cfg.root, "cold-selection-result.json"), JSON.stringify({ code, output, error }))
    expect(code, `Retained owned fixture ${cfg.root}: ${error.tail}`).toBe(0)
    expect(output.eof).toBe(true)
    expect(error.eof).toBe(true)
    expect(child.signalCode).toBeNull()
    const receipt = JSON.parse(output.tail)
    expect(receipt).toMatchObject({
      legacySelection: true,
      heldPhase: 0,
      recoveredPhase: 1,
      tamperRefused: true,
      sourceIdentitiesPreserved: true,
      nativeBirthsHeld: true,
      exactAclRestored: true,
      negativePathsAbsent: true,
      siblingUnchanged: true,
      journalParentCount: 1,
      journalOnlyDirectories: true,
      zeroCapturedFiles: true,
      freshRecovery: true,
      repeatedRecovery: true,
      ownedPidsAbsent: true,
      guardianCode: 77,
      sourceCode: 0,
      watchdogForced: false,
      captureSuccessful: false,
      portableCaptureAuthorized: false,
    })
    expect(receipt.journalBefore).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.journalAfter).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.journalBefore).not.toBe(receipt.journalAfter)
    expect(await readFile(path.join(cfg.source, "note.json"), "utf8")).toBe('{"owned":"original café 日本語"}')
  },
  60_000,
)

for (const mode of ["missing", "empty"])
  test.skipIf(process.platform !== "win32")(
    `stable default with ${mode} legacy is selected without creation and reused by two actual held images`,
    async () => {
      await fixture(async (cfg) => {
        if (mode === "empty") await mkdir(cfg.legacy, { recursive: true })
        const selection = await select({ account: cfg.account, env: cfg.env, helper: cfg.helper })
        expect(selection.directory).toBe(cfg.stable)
        expect(selection.helper).toEqual(cfg.helper)
        expect(selection.receipts).toEqual([])
        expect(await exists(cfg.stable)).toBe(false)
        expect(await exists(cfg.legacy)).toBe(mode === "empty")
        const original = await readFile(path.join(cfg.source, "note.json"))
        const controls: string[] = []
        for (const phase of [1, 2])
          await selection.withImage(cfg.input, async (image) => {
            const value = assertImage(image, cfg.input.roots)
            expect(path.dirname(value.control)).toBe(cfg.stable)
            controls.push(value.control)
            expect(value.files.some((file) => file.original === path.join(cfg.source, "note.json"))).toBe(true)
            expect(controls).toHaveLength(phase)
          })
        expect(new Set(controls).size).toBe(2)
        expect(await readFile(path.join(cfg.source, "note.json"))).toEqual(original)
        const observed = (await discover([cfg.stable], cfg.helper))[0]
        expect(observed.exists).toBe(true)
        expect(observed.entries).toBe(2)
        const cold = await select({ account: cfg.account, env: cfg.env, helper: cfg.helper })
        expect(cold.directory).toBe(cfg.stable)
        expect(cold.receipts).toEqual([])
        const recovered = await startup({ registry: cfg.stable, helper: cfg.helper })
        expect(recovered).toHaveLength(2)
        expect(recovered.every((receipt) => receipt.recovered)).toBe(true)
        expect((await discover([cfg.stable], cfg.helper))[0].ancestor).toEqual(observed.ancestor)
        expect(await exists(cfg.legacy)).toBe(mode === "empty")
      })
    },
    60_000,
  )

test.skipIf(process.platform !== "win32")(
  "stable registry replacement between actual images refuses before the second callback",
  async () => {
    await fixture(async (cfg) => {
      const selection = await select({ account: cfg.account, env: cfg.env, helper: cfg.helper })
      await selection.withImage(cfg.input, async (image) => {
        assertImage(image, cfg.input.roots)
      })
      await rename(cfg.stable, `${cfg.stable}-original`)
      await mkdir(cfg.stable)
      const called = { value: false }
      await assert.rejects(
        selection.withImage(cfg.input, async () => {
          called.value = true
        }),
      )
      expect(called.value).toBe(false)
    })
  },
  60_000,
)

for (const mode of ["unknown", "occupied", "junction"])
  test.skipIf(process.platform !== "win32")(
    `legacy ${mode} refuses before stable registry creation`,
    async () => {
      await fixture(async (cfg) => {
        await mkdir(path.dirname(cfg.legacy))
        if (mode === "unknown") await mkdir(path.join(cfg.legacy, "unrecognized"), { recursive: true })
        if (mode === "occupied") await writeFile(cfg.legacy, "owned occupied leaf")
        if (mode === "junction") await symlink(cfg.source, cfg.legacy, "junction")
        await assert.rejects(select({ account: cfg.account, env: cfg.env, helper: cfg.helper }))
        expect(await exists(cfg.stable)).toBe(false)
        expect(await readFile(path.join(cfg.source, "note.json"), "utf8")).toBe('{"owned":"original café 日本語"}')
      })
    },
    60_000,
  )

test.skipIf(process.platform !== "win32")(
  "stable account junction refuses without creating a registry through the alias",
  async () => {
    await fixture(async (cfg) => {
      const physical = `${cfg.account}-physical`
      await rename(cfg.account, physical)
      await symlink(physical, cfg.account, "junction")
      await assert.rejects(select({ account: cfg.account, env: cfg.env, helper: cfg.helper }))
      expect(await exists(path.join(physical, "AppData", ".raya-offline-recovery"))).toBe(false)
    })
  },
  60_000,
)

test.skipIf(process.platform !== "win32")(
  "selected stable default retains positive source overlap refusal",
  async () => {
    await fixture(async (cfg) => {
      const selection = await select({ account: cfg.account, env: cfg.env, helper: cfg.helper })
      const called = { value: false }
      await assert.rejects(
        selection.withImage(
          {
            roots: [{ kind: "json", path: cfg.account }],
            policy: { version: 1, directories: [cfg.account], files: [] },
          },
          async () => {
            called.value = true
          },
        ),
        /overlap/,
      )
      expect(called.value).toBe(false)
      expect(await exists(cfg.stable)).toBe(false)
    })
  },
  60_000,
)
