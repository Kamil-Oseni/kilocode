import { authenticate, reply } from "./maintenance-protocol"
import { withCapture } from "./capture-authority"
import { exportProfile } from "./profile-export"

/** Internal one-shot process entry. Channel authentication proves creator intent, never writer completeness. */
export async function maintenance() {
  const generation = process.env.RAYA_MAINTENANCE_GENERATION
  const id = process.env.RAYA_MAINTENANCE_REQUEST
  const secret = process.env.RAYA_MAINTENANCE_CHANNEL
  if (!generation || !id || !secret) throw new Error("Missing owned maintenance process identity")
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of Bun.stdin.stream()) {
    size += chunk.length
    if (size > 128 * 1024) throw new Error("Maintenance request exceeds supported size")
    chunks.push(chunk)
  }
  let admitted = false
  const result = await (async () => {
    try {
      const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (
        !envelope ||
        typeof envelope !== "object" ||
        !("body" in envelope) ||
        !("digest" in envelope) ||
        typeof envelope.digest !== "string"
      )
        throw new Error("Invalid maintenance envelope")
      const value = authenticate(envelope.body, secret, envelope.digest)
      if (value.generation !== generation || value.id !== id) throw new Error("Maintenance request identity differs")
      admitted = true
      return await withCapture(value.roots, async (proof, roots) => ({
        ok: true as const,
        bundle: await exportProfile(proof, roots, value.source, value.password),
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : ""
      return {
        ok: false as const,
        reason: !admitted
          ? ("invalid-request" as const)
          : message.includes("complete")
            ? ("coverage-incomplete" as const)
            : ("capture-refused" as const),
      }
    }
  })()
  const receipt = reply.parse({
    format: "raya.maintenance-reply",
    version: 1,
    generation,
    id,
    result,
    environment: {
      home: process.env.HOME,
      data: process.env.XDG_DATA_HOME,
      config: process.env.XDG_CONFIG_HOME,
      state: process.env.XDG_STATE_HOME,
      cache: process.env.XDG_CACHE_HOME,
      database: process.env.RAYA_DB,
    },
  })
  process.stdout.write("RAYA_MAINTENANCE_REPLY " + JSON.stringify(receipt) + "\n")
  process.exitCode = result.ok ? 0 : 1
}

if (import.meta.main) await maintenance()
