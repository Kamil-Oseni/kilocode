import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import { realpathSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { ProfileWriterLive } from "@/kilocode/migration/writer-live"

export namespace SandboxPreference {
  export function root() {
    return path.join(realpathSync.native(path.dirname(Global.Path.state)), "kilo-sandbox-preference")
  }

  function file(directory: string, base = root()) {
    return path.join(base, createHash("sha256").update(directory).digest("hex") + ".json")
  }

  export async function read(directory: string): Promise<boolean | undefined> {
    const target = file(directory)
    const text = await fs.readFile(target, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined
      throw err
    })
    if (text === undefined) return undefined
    const value: unknown = JSON.parse(text)
    return typeof value === "boolean" ? value : undefined
  }

  export async function write(
    directory: string,
    enabled: boolean,
    admission: ProfileWriterLive.Admission = ProfileWriterLive.preference,
  ) {
    return Effect.runPromise(
      admission.run(
        Effect.promise(async () => {
          const base = root()
          const target = file(directory, base)
          const temp = path.join(base, `.${randomUUID()}.tmp`)
          await fs.mkdir(base, { recursive: true, mode: 0o700 })
          await fs.writeFile(temp, JSON.stringify(enabled), { encoding: "utf8", flag: "wx", mode: 0o600 })
          await fs.rename(temp, target).catch(async (err) => {
            await fs.rm(temp, { force: true })
            throw err
          })
        }),
      ),
    )
  }
}
