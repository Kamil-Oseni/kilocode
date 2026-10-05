import { createHash } from "node:crypto"
import { lstat, mkdtemp, open, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import yargs from "yargs"
import z from "zod"

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value && !/[\0\r\n]/.test(value))
const mapping = z
  .object({
    workspaces: z.record(z.string().min(1).max(4096), absolute),
    primaries: z.array(z.string().min(1).max(4096)).max(128).optional(),
  })
  .strict()
const secret = z
  .object({
    password: z.string().refine((value) => Buffer.byteLength(value) >= 12 && Buffer.byteLength(value) <= 1024),
  })
  .strict()

async function read(file: string, maximum: number) {
  absolute.parse(file)
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum)
    throw new Error("Import input is not a bounded unique regular file")
  const physical = await realpath(file)
  const handle = await open(physical, "r")
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.size !== before.size
    )
      throw new Error("Import input changed before reading")
    const buffer = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    const after = await handle.stat()
    const current = await lstat(file)
    if (
      offset !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    )
      throw new Error("Import input changed during reading")
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

async function password() {
  if (process.stdin.isTTY) throw new Error("Import requires private stdin")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 4096) throw new Error("Import stdin exceeded bound")
    chunks.push(bytes)
  }
  return secret.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).password
}

async function disjoint(target: string, mappings: Readonly<Record<string, string>>) {
  const home = (process.env.KILO_TEST_HOME ?? os.homedir()).trim()
  const base = os.homedir()
  const roots = [
    ...[
      process.env.XDG_DATA_HOME || path.join(base, ".local", "share"),
      process.env.XDG_CACHE_HOME || path.join(base, ".cache"),
      process.env.XDG_CONFIG_HOME || path.join(base, ".config"),
      process.env.XDG_STATE_HOME || path.join(base, ".local", "state"),
    ].map((value) => {
      if (!value || !path.isAbsolute(value)) throw new Error("Active profile root is invalid")
      return path.join(value.replace(/[\r\n]/g, ""), "kilo")
    }),
    path.join(home, ".kilocode"),
    path.join(home, ".config", "kilo"),
  ]
  for (const name of ["CONFIG_DIR", "LANCEDB_PATH", "DB", "CONFIG", "MODELS_PATH"] as const) {
    const value = process.env[`RAYA_${name}`] ?? process.env[`KILO_${name}`]
    if (!value || value === ":memory:") continue
    roots.push(["DB", "CONFIG", "MODELS_PATH"].includes(name) ? path.dirname(path.resolve(value)) : path.resolve(value))
  }
  const canonical = async (file: string): Promise<string> =>
    realpath(file).catch(async (err: unknown) => {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT" || path.dirname(file) === file) throw err
      return path.join(await canonical(path.dirname(file)), path.basename(file))
    })
  const key = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
  const inside = (root: string, file: string) => {
    const relative = path.relative(key(root), key(file))
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  }
  const scopes = await Promise.all(roots.map(canonical))
  for (const candidate of [target, ...Object.values(mappings)]) {
    const physical = await canonical(candidate)
    if (scopes.some((root) => inside(root, physical) || inside(physical, root)))
      throw new Error("Inactive import overlaps an active profile root")
  }
}

/** Public inactive import runs before ordinary CLI bootstrap and isolates every lazy Global dependency. */
export async function run(args: readonly string[]) {
  const state: { runtime?: string; output?: string } = {}
  try {
    const input = await yargs([...args])
      .scriptName("kilo profile-import")
      .command("$0 <archive> <target>", "Import an encrypted profile into a fresh inactive container")
      .option("mapping", {
        type: "string",
        demandOption: true,
        describe: "Absolute path to explicit workspace mapping JSON",
      })
      .option("sha256", { type: "string", demandOption: true, describe: "Expected encrypted archive SHA-256" })
      .strict()
      .exitProcess(false)
      .help()
      .fail(() => {
        throw new Error("Invalid import arguments")
      })
      .parseAsync()
    if (input.help) return
    const archive = absolute.parse(input.archive)
    const target = absolute.parse(input.target)
    const digest = z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .transform((value) => value.toLowerCase())
      .parse(input.sha256)
    const text = await read(archive, 180 * 1024 * 1024)
    if (createHash("sha256").update(text).digest("hex") !== digest) throw new Error("Import archive digest differs")
    const paths = mapping.parse(JSON.parse((await read(absolute.parse(input.mapping), 128 * 1024)).toString("utf8")))
    if (Object.keys(paths.workspaces).length > 128 || paths.primaries?.some((value) => !(value in paths.workspaces)))
      throw new Error("Import mapping exceeds supported bounds")
    const parent = await realpath(path.dirname(target))
    if (path.join(parent, path.basename(target)) !== target) throw new Error("Import target parent is not physical")
    const occupied = await lstat(target).then(
      () => true,
      (err: unknown) => {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") return false
        throw err
      },
    )
    if (occupied) throw new Error("Import target must be new")
    await disjoint(target, paths.workspaces)
    const passphrase = await password()
    state.runtime = await mkdtemp(path.join(os.tmpdir(), "raya-profile-import-"))
    for (const name of Object.keys(process.env))
      if (/^(?:OTEL_|RAYA_|KILO_|OPENCODE_)|(?:API_KEY|TOKEN|SECRET)$/.test(name)) delete process.env[name]
    Object.assign(process.env, {
      HOME: path.join(state.runtime, "home"),
      USERPROFILE: path.join(state.runtime, "home"),
      KILO_TEST_HOME: path.join(state.runtime, "home"),
      LOCALAPPDATA: path.join(state.runtime, "local"),
      XDG_DATA_HOME: path.join(state.runtime, "data"),
      XDG_CONFIG_HOME: path.join(state.runtime, "config"),
      XDG_CACHE_HOME: path.join(state.runtime, "cache"),
      XDG_STATE_HOME: path.join(state.runtime, "state"),
      RAYA_DB: path.join(state.runtime, "unused.db"),
      KILO_DB: path.join(state.runtime, "unused.db"),
      RAYA_AUTH_CONTENT: "{}",
      KILO_AUTH_CONTENT: "{}",
      KILO_DISABLE_MODELS_FETCH: "1",
      KILO_DISABLE_AUTOUPDATE: "1",
      KILO_PURE: "1",
    })
    const { restore } = await import("./profile-restore")
    const result = await restore(text.toString("utf8"), passphrase, target, paths.workspaces, {
      primaries: paths.primaries,
    })
    state.output = `${JSON.stringify({ ...result, completeProfileCoverage: false, portableCaptureAuthorized: false })}\n`
  } catch {
    process.exitCode = 1
    process.stderr.write(
      "Raya profile import refused. Verify the archive, digest, private stdin, mappings and fresh destination.\n",
    )
  } finally {
    if (state.runtime) {
      const { finish } = await import("../cli/finish")
      await finish([], () => {
        if (state.output) process.stdout.write(state.output)
      })
    }
  }
}
