import { expect, test } from "bun:test"
import { constants } from "node:fs"
import { copyFile, lstat, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

test("actual scheduled Runner cross-runtime Question original owners stop and join", async () => {
  const root = await mkdtemp(join(tmpdir(), "raya-scheduler-question-"))
  const grep = Bun.which("rg")
  if (!grep) throw new Error("Existing fixture ripgrep binary is required; downloads are refused")
  const before = await lstat(grep, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16n * 1024n * 1024n)
    throw new Error("Fixture ripgrep source is not a bounded regular image")
  const bin = join(root, "cache", "kilo", "bin")
  await mkdir(bin, { recursive: true })
  const target = join(bin, process.platform === "win32" ? "rg.exe" : "rg")
  const bytes = await Bun.file(grep).arrayBuffer()
  await copyFile(grep, target, constants.COPYFILE_EXCL)
  const after = await lstat(grep, { bigint: true })
  expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs, after.nlink]).toEqual([
    before.dev,
    before.ino,
    before.size,
    before.mtimeNs,
    before.ctimeNs,
    before.nlink,
  ])
  expect(await Bun.file(target).arrayBuffer()).toEqual(bytes)
  const env = Object.fromEntries(
    ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "PSModulePath"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]!]] : [],
    ),
  )
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "run",
      "--conditions=browser",
      "test/kilocode/fixtures/scheduler-question-stop.ts",
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...env,
        PATH: [
          dirname(process.execPath),
          dirname(grep),
          join(process.env.SystemRoot ?? "C:/Windows", "System32"),
          join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0"),
        ].join(process.platform === "win32" ? ";" : ":"),
        HOME: root,
        USERPROFILE: root,
        KILO_TEST_HOME: root,
        KILO_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
        RAYA_SCHEDULER_PROFILE: root,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_STATE_HOME: join(root, "state"),
        RAYA_DB: join(root, "raya.db"),
        RAYA_NO_DAEMON: "1",
        KILO_NO_DAEMON: "1",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_MODELS_PATH: resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
        KILO_AUTH_CONTENT: "{}",
        RAYA_AUTH_CONTENT: "{}",
        KILO_CONFIG_CONTENT: '{"formatter":false,"lsp":false,"permission":"deny","enabled_providers":[]}',
        RAYA_CONFIG_CONTENT: "",
        KILO_CONFIG: "",
        RAYA_CONFIG: "",
        KILO_CONFIG_DIR: "",
        RAYA_CONFIG_DIR: "",
        KILO_SERVER_PASSWORD: "",
        RAYA_SERVER_PASSWORD: "",
      },
    },
  )
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    const state = { bytes: 0, overflow: false }
    for (;;) {
      const row = await reader.read()
      if (row.done) break
      state.bytes += row.value.byteLength
      if (state.bytes <= 65536) chunks.push(row.value)
      if (state.bytes > 65536) state.overflow = true
    }
    reader.releaseLock()
    return { text: Buffer.concat(chunks).toString("utf8"), eof: true, overflow: state.overflow }
  }
  const stdout = read(child.stdout)
  const stderr = read(child.stderr)
  const [code, out, err] = await Promise.all([child.exited, stdout, stderr])
  await Bun.write(join(root, "stdout.log"), out.text)
  await Bun.write(join(root, "stderr.log"), err.text)
  expect(out.overflow || err.overflow).toBe(false)
  expect(code, `Retained disposable profile ${root}; ${err.text}`).toBe(0)
  expect(await Bun.file(join(root, "receipt.json")).json()).toMatchObject({
    passed: true,
    questionClosed: true,
    scheduler: { active: 0, failures: 0 },
  })
}, 120_000)
