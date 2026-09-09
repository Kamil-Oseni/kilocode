import { createHash } from "node:crypto"
import { mkdtemp, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { repository } from "./update-release"

const schema = z.object({
  name: z.string(),
  url: z.string(),
  size: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 1024),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  state: z.literal("uploaded"),
})

class InvalidUpdate extends Error {}

export function select(assets: unknown[], target: string) {
  if (!["win32-x64", "darwin-arm64", "linux-x64"].includes(target)) return
  const matches = assets.filter(
    (asset) => asset && typeof asset === "object" && "name" in asset && asset.name === `raya-${target}.vsix`,
  )
  if (!matches.length) return
  if (matches.length !== 1) throw new InvalidUpdate("The release contains ambiguous platform assets.")
  const parsed = schema.safeParse(matches[0])
  if (!parsed.success)
    throw new InvalidUpdate("The update asset needs a valid SHA-256 digest, size, and uploaded status.")
  return parsed.data
}

/** Only verified bytes in a private temporary directory reach the installer. */
export async function stage(
  asset: z.infer<typeof schema>,
  repo: string,
  token: string,
  install: (path: string) => Promise<void>,
  request: (input: string | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  repository(repo)
  const prefix = `https://api.github.com/repos/${repo}/releases/assets/`
  if (!asset.url.toLowerCase().startsWith(prefix.toLowerCase()) || !/^\d+$/.test(asset.url.slice(prefix.length)))
    throw new InvalidUpdate("The update asset does not belong to the configured GitHub repository.")
  const directory = await mkdtemp(join(tmpdir(), "raya-update-"))
  try {
    const signal = AbortSignal.timeout(60_000)
    const response = await request(asset.url, {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "raya-update-checker",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "manual",
      signal,
    })
    const download = await (async () => {
      if (response.status !== 302) return response
      const location = response.headers.get("location")
      if (!location) throw new InvalidUpdate("The update download redirect is missing.")
      const url = new URL(location)
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(url.hostname)
      )
        throw new InvalidUpdate("The update download redirected to an unsupported host.")
      // The signed download URL is fetched without the private repository credential.
      return request(url, { redirect: "error", signal })
    })()
    if (!download.ok || !download.body) throw new InvalidUpdate(`Update download failed (HTTP ${download.status}).`)
    const path = join(directory, "update.vsix")
    const file = await open(path, "wx", 0o600)
    const reader = download.body.getReader()
    const hash = createHash("sha256")
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > asset.size) throw new InvalidUpdate("The update download exceeded its declared size.")
        hash.update(chunk.value)
        await file.writeFile(chunk.value)
      }
      if (size !== asset.size) throw new InvalidUpdate("The update download was truncated.")
      if (`sha256:${hash.digest("hex")}` !== asset.digest) throw new InvalidUpdate("The update checksum did not match.")
      await file.sync()
    } finally {
      await reader.cancel().catch(() => console.warn("[Raya] Update response cleanup failed."))
      await file.close()
    }
    await install(path)
  } catch (error) {
    if (error instanceof InvalidUpdate) throw error
    throw new InvalidUpdate("The update could not be downloaded, verified, or installed. Retry the update check.")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
