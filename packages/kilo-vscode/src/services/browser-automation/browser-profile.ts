import { createHash } from "node:crypto"
import { mkdir, open, readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { BrowserIdentity } from "./browser-auth"

export async function profile(root: string, directory: string) {
  const canonical = await realpath(directory)
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical
  const profileID = createHash("sha256").update(identity).digest("hex")
  const owner: BrowserIdentity = { profileID, directory: canonical }
  await mkdir(root, { recursive: true, mode: 0o700 })
  if ((await realpath(root)) !== resolve(root)) throw new Error("Browser profile storage identity changed")
  const path = join(root, profileID)
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return
    throw error
  })
  if ((await realpath(path)) !== resolve(path)) throw new Error("Browser workspace profile identity changed")
  const file = join(path, "owner.json")
  const handle = await open(file, "wx", 0o600).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return
    throw error
  })
  if (handle) {
    try {
      await handle.writeFile(JSON.stringify(owner))
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  if ((await readFile(file, "utf8")) !== JSON.stringify(owner))
    throw new Error("Browser profile owner does not match this workspace")
  return { owner, path }
}
