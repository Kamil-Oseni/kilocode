import { createHash } from "node:crypto"
import { Schema } from "effect"
import { Refusal } from "../session/tool-refusal"

export const Exact = Schema.Struct({
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
}).annotate({
  description:
    "Write literal UTF-8 without formatting or inherited BOM/encoding. Required bytes and sha256 must match actual complete Read evidence. Content and its complete JSON representation must each fit 8192 bytes. Read the saved target to verify equality.",
})

export function check(content: string, exact: typeof Exact.Type | undefined) {
  if (!exact) return
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(++index)
      if (next >= 0xdc00 && next <= 0xdfff) continue
      throw new Refusal("exact-write", "Exact UTF-8 write refused: unpaired surrogate in content.")
    }
    if (code >= 0xdc00 && code <= 0xdfff)
      throw new Refusal("exact-write", "Exact UTF-8 write refused: unpaired surrogate in content.")
  }
  const data = Buffer.from(content, "utf8")
  if (data.length > 8192 || Buffer.byteLength(JSON.stringify(content).replace(/</g, "\\u003c"), "utf8") > 8192)
    throw new Refusal("exact-write", "Exact UTF-8 write refused: content exceeds the complete Read evidence bound.")
  if (data.length !== exact.bytes || createHash("sha256").update(data).digest("hex") !== exact.sha256)
    throw new Refusal(
      "exact-write",
      "Exact UTF-8 write refused: content bytes or SHA-256 differ from the expected Read evidence. Decode the complete file-content-json string exactly; check BOM, newline endings and final newline. No file was written.",
    )
}
