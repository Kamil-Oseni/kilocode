import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { encode } from "@opencode-ai/core/kilocode/source-transfer"
import { SourceSelection } from "@opencode-ai/core/kilocode/source-selection-schema"
import type { KiloConnectionService } from "../services/cli-backend/connection-service"

/** The receipt remains partial and no failed export is retried automatically. */
export async function archive(
  connection: Pick<KiloConnectionService, "getClient" | "isClientCurrent" | "matchesSource" | "exportProfile">,
  review: typeof SourceSelection.Type,
  password: string,
  output: string,
  accepted: () => void,
) {
  const bytes = Buffer.byteLength(password, "utf8")
  if (bytes < 12 || bytes > 1024) throw new Error("Archive password must contain 12–1024 UTF-8 bytes")
  const selected = Schema.decodeUnknownSync(SourceSelection)(review, { onExcessProperty: "error" })
  const exists = await lstat(output).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  if (exists) throw new Error("Archive destination already exists")
  const client = connection.getClient()
  const response = await client.global.sourceExportSelection({ throwOnError: true })
  const current = Schema.decodeUnknownSync(SourceSelection)(response.data, { onExcessProperty: "error" })
  if (
    !connection.isClientCurrent(client) ||
    JSON.stringify(current) !== JSON.stringify(selected) ||
    !connection.matchesSource(current.source)
  )
    throw new Error("Archive selection changed; review it again before capture")
  // Validate private transfer bounds before retiring any host; never log the payload.
  encode({
    format: "raya.source-export",
    version: 1,
    id: randomUUID(),
    source: current.source,
    profile: current.profile,
    password,
    output,
  })
  accepted()
  return connection.exportProfile({ profile: current.profile, password, output }, Date.now() + 60_000)
}
