import { randomBytes } from "node:crypto"
import { mkdtemp, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { reply, request, sign } from "./maintenance-protocol"
import type { Files } from "./profile-preference-files"

/** A private administration child never inherits the source profile as its own runtime home. */
export async function maintenance(input: {
  roots: readonly Readonly<{ kind: "json" | "sqlite"; path: string }>[]
  source: { database: string; storage: string; data?: string; preferences?: Files; exports?: string }
  password: string
  command?: readonly string[]
}) {
  const snapshot = input.roots.map((root) => ({ ...root }))
  const selected = {
    ...input.source,
    preferences: input.source.preferences ? { ...input.source.preferences } : undefined,
  }
  const command = input.command
    ? [...input.command]
    : /^bun(?:\.exe)?$/i.test(path.basename(process.execPath))
      ? [
          process.execPath,
          "run",
          "--conditions=browser",
          path.resolve(import.meta.dir, "../../index.ts"),
          "__profile-maintenance",
        ]
      : [process.execPath, "__profile-maintenance"]
  const password = input.password
  const roots = await Promise.all(snapshot.map(async (root) => ({ kind: root.kind, path: await realpath(root.path) })))
  const preferences = selected.preferences
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(selected.preferences)
            .filter((entry) => entry[1] !== undefined)
            .map(async ([key, file]) => [key, await realpath(file)]),
        ),
      )
    : undefined
  const source = {
    database: await realpath(selected.database),
    storage: await realpath(selected.storage),
    ...(selected.data ? { data: await realpath(selected.data) } : {}),
    ...(preferences ? { preferences } : {}),
    ...(selected.exports ? { exports: await realpath(selected.exports) } : {}),
  }
  const generation = crypto.randomUUID()
  const id = crypto.randomUUID()
  const secret = randomBytes(32).toString("hex")
  const body = request.parse({
    format: "raya.maintenance-request",
    version: 1,
    generation,
    id,
    roots,
    source,
    password,
  })
  const envelope = JSON.stringify({ body, digest: sign(body, secret) })
  if (Buffer.byteLength(envelope) > 128 * 1024) throw new Error("Maintenance request exceeds supported size")
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "raya-maintenance-"))
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      key.startsWith("OTEL_") ||
      key.startsWith("KILO_TEST_DAEMON_") ||
      key.startsWith("RAYA_DAEMON_") ||
      /^RAYA_(?:SOURCE|CONTROLLER|HOST|PARENT)_/.test(key) ||
      /(API_KEY|TOKEN|SECRET)$/.test(key)
    )
      delete env[key]
  Object.assign(env, {
    HOME: privateRoot,
    USERPROFILE: privateRoot,
    KILO_TEST_HOME: privateRoot,
    XDG_DATA_HOME: path.join(privateRoot, "data"),
    XDG_CONFIG_HOME: path.join(privateRoot, "config"),
    XDG_STATE_HOME: path.join(privateRoot, "state"),
    XDG_CACHE_HOME: path.join(privateRoot, "cache"),
    RAYA_DB: path.join(privateRoot, "unused.db"),
    KILO_DB: path.join(privateRoot, "unused.db"),
    RAYA_AUTH_CONTENT: "{}",
    KILO_AUTH_CONTENT: "{}",
    RAYA_MAINTENANCE_GENERATION: generation,
    RAYA_MAINTENANCE_REQUEST: id,
    RAYA_MAINTENANCE_CHANNEL: secret,
  })
  const child = Bun.spawn(command, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true })
  let forced = false
  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      forced = true
      child.kill()
    }
  }, 30_000)
  const sending = (async () => {
    await child.stdin.write(envelope)
    await child.stdin.end()
  })().then(
    () => undefined,
    (err: unknown) => err,
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timer)
  const error = await sending
  await writeFile(path.join(privateRoot, "stderr.log"), stderr)
  if (error)
    throw new AggregateError([error], `Maintenance request transport failed; diagnostics retained at ${privateRoot}`)
  if (forced || child.signalCode !== null)
    throw new Error(`Maintenance process failed to exit naturally; diagnostics retained at ${privateRoot}`)
  const line = stdout.split("\n").find((line) => line.startsWith("RAYA_MAINTENANCE_REPLY "))
  if (!line) throw new Error(`Maintenance process has no correlated reply; diagnostics retained at ${privateRoot}`)
  const receipt = reply.parse(JSON.parse(line.slice("RAYA_MAINTENANCE_REPLY ".length)))
  if (receipt.generation !== generation || receipt.id !== id || code !== (receipt.result.ok ? 0 : 1))
    throw new Error(`Maintenance process reply/exit identity mismatch; diagnostics retained at ${privateRoot}`)
  if (
    receipt.environment.home !== privateRoot ||
    receipt.environment.data !== env.XDG_DATA_HOME ||
    receipt.environment.config !== env.XDG_CONFIG_HOME ||
    receipt.environment.state !== env.XDG_STATE_HOME ||
    receipt.environment.cache !== env.XDG_CACHE_HOME ||
    receipt.environment.database !== env.RAYA_DB
  )
    throw new Error(`Maintenance process environment identity mismatch; diagnostics retained at ${privateRoot}`)
  return Object.freeze({ receipt, pid: child.pid, code, forced: false as const, privateRoot })
}
