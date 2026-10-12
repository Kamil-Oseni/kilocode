import path from "node:path"
import { check } from "../control/frames"
import { image } from "../control/identity"
import { parseCatalog, type Catalog } from "../control/catalog"
import { bridge } from "../control/catalog-capture"

/** Select only the current transport included in the reviewed immutable paired upgrade. */
export async function transport(
  prior: Catalog,
  proof: {
    source: string
    images: readonly { path: string; bytes: number; sha256: string }[]
    next: { setup: { source_sha256: Readonly<Record<string, string>> } }
  },
) {
  const file = path.join(proof.source, "control.py")
  const refs = proof.images.filter((row) => row.path === file)
  check(refs.length === 1 && refs[0].sha256 === bridge, "Reviewed upgrade control bridge required")
  const held = await image(file)
  check(held.digest === bridge && held.raw.length === refs[0].bytes, "Reviewed upgrade control bridge changed")
  return parseCatalog({
    ...prior,
    source: proof.source,
    source_sha256: proof.next.setup.source_sha256,
    bridge: file,
    bridge_sha256: bridge,
  })
}
