import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { context } from "@opencode-ai/core/kilocode/source-launch"
import { covers } from "@opencode-ai/core/kilocode/source-policy"
import { SourceSelection } from "@opencode-ai/core/kilocode/source-selection-schema"
import { sql } from "@/storage/db"
import { Storage } from "@/storage/storage"
import { selected } from "./storage-scope"

const key = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const rows = Schema.Array(Schema.Struct({ name: Schema.String, file: Schema.String })).check(Schema.isMaxLength(64))

/** Review live paths only. Configuration closure remains the authenticated retired capture's responsibility. */
export const selection = Effect.fn("RayaSourceSelection")(function* () {
  const database = yield* Database.Service
  const storage = yield* Storage.Service
  const global = yield* Global.Service
  const handle = database.db
  const data = global.data
  const connected = Schema.decodeUnknownSync(rows)(yield* handle.all(sql`PRAGMA database_list`))
  const main = connected.filter((row) => row.name === "main")
  if (main.length !== 1 || !main[0].file) throw new Error("An on-disk selected database is required")
  const dir = selected(storage)
  const ticket = yield* Effect.promise(() => context())
  if (!ticket?.header.policy) throw new Error("An owned native source is required")
  const policy = ticket.header.policy
  const state: { file: string; directory: boolean; tuple: string[] }[] = []
  const pin = async (file: string, directory: boolean) => {
    if (!path.isAbsolute(file) || file.length > 4096 || /[\0\r\n]/.test(file))
      throw new Error("Unsupported selection path")
    const actual = await realpath(file)
    const info = await lstat(file, { bigint: true })
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n) ||
      !covers(policy, actual)
    )
      throw new Error("Selected source object is unsupported")
    return [actual, String(info.dev), String(info.ino), String(info.birthtimeNs)]
  }
  const canonical = async (file: string, directory: boolean) => {
    const tuple = await pin(file, directory)
    state.push({ file, directory, tuple })
    return tuple[0]
  }
  const profile = yield* Effect.promise(async () => {
    const database = await canonical(main[0].file, false)
    const storage = await canonical(dir, true)
    const selected = await canonical(data, true)
    if (key(path.dirname(storage)) !== key(selected)) throw new Error("Storage and selected data namespaces differ")
    const file = path.join(selected, "session-export.db")
    const exists = await lstat(file).catch((err: unknown) => {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
    const exports = exists ? await canonical(file, false) : undefined
    return { database, storage, data: selected, ...(exports ? { exports } : {}) }
  })
  if (selected(storage) !== dir || global.data !== data || database.db !== handle)
    throw new Error("Source selections changed during review")
  const current = Schema.decodeUnknownSync(rows)(yield* handle.all(sql`PRAGMA database_list`))
  if (JSON.stringify(current) !== JSON.stringify(connected)) throw new Error("Connected database changed during review")
  yield* Effect.promise(async () => {
    for (const value of state)
      if (JSON.stringify(await pin(value.file, value.directory)) !== JSON.stringify(value.tuple))
        throw new Error("Selected source identity changed during review")
    const exports = await lstat(path.join(profile.data, "session-export.db")).catch((err: unknown) => {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
      throw err
    })
    if (!!exports !== !!profile.exports) throw new Error("Selected export namespace changed during review")
  })
  if (selected(storage) !== dir || global.data !== data || database.db !== handle)
    throw new Error("Source selections changed during review")
  const source = {
    pid: ticket.header.pid,
    birth: ticket.header.birth,
    executable: ticket.header.executable,
    digest: ticket.header.digest,
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ source, profile, state, policy: ticket.header.policyInventory }))
    .digest("hex")
  return Schema.decodeUnknownSync(SourceSelection)({
    format: "raya.source-export-selection",
    version: 1,
    source,
    profile,
    fingerprint,
    preferences: "authenticated-capture-only",
    completeProfileCoverage: false,
    portableCaptureAuthorized: false,
    restartRequired: true,
  })
})
