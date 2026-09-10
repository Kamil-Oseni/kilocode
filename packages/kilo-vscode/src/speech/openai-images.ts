import { createHash } from "node:crypto"

type Result = { status: "shared" | "unknown" | "failed"; error?: string }
type Entry = {
  hash: string
  sent: boolean
  settled: boolean
  result: Promise<Result>
  finish: (result: Result) => void
}

/** One connection owns these immutable IDs. Uncertain delivery is never replayed. */
export class OpenAIImages {
  private entries = new Map<string, Entry>()

  share(
    id: string,
    data: string,
    signal: AbortSignal,
    stage: (image: { id: string; data: string }) => Promise<Record<string, unknown>>,
    send: (event: unknown) => void,
  ): Promise<Result> {
    const image = decode(data)
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !image)
      return Promise.resolve({ status: "failed", error: "Choose a JPEG, PNG or WebP image up to 256 KiB." })
    const prior = this.entries.get(id)
    if (prior)
      return prior.hash === image.hash
        ? prior.result
        : Promise.resolve({ status: "failed", error: "This image ID already identifies different content." })
    if (this.entries.size >= 8)
      return Promise.resolve({
        status: "failed",
        error: "Eight images have been selected. Start a new voice connection to share more.",
      })
    let resolve!: (result: Result) => void
    const pending = new Promise<Result>((finish) => {
      resolve = finish
    })
    const entry: Entry = {
      hash: image.hash,
      sent: false,
      settled: false,
      result: pending,
      finish: (result) => {
        if (entry.settled) return
        entry.settled = true
        resolve(result)
      },
    }
    this.entries.set(id, entry)
    const abort = () =>
      entry.finish({
        status: entry.sent ? "unknown" : "failed",
        error: "Voice ended before image sharing was confirmed.",
      })
    const timer = setTimeout(
      () =>
        entry.finish({
          status: "unknown",
          error: "Image delivery was not confirmed. It will not be sent again automatically.",
        }),
      30_000,
    )
    signal.addEventListener("abort", abort, { once: true })
    void pending.finally(() => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    })
    void (async () => {
      if (signal.aborted) return abort()
      const receipt = await stage({ id, data })
      if (signal.aborted) return abort()
      if (entry.settled) return
      if (
        receipt.id !== id ||
        receipt.sha256 !== image.hash ||
        receipt.mime !== image.mime ||
        receipt.bytes !== image.bytes
      )
        throw new Error("Image storage receipt did not match the selected image.")
      entry.sent = true
      send({
        type: "conversation.item.create",
        event_id: `image_${id}`,
        item: {
          id,
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Selected image ID: ${id}. Include this ID in raya_work images when the requested work needs this image. Sharing alone is not a request to start work.`,
            },
            { type: "input_image", image_url: data },
          ],
        },
      })
    })().catch(() =>
      entry.finish({
        status: entry.sent ? "unknown" : "failed",
        error: "Image sharing could not be confirmed. Select an image again only if you want another sharing attempt.",
      }),
    )
    return pending
  }

  receive(event: Record<string, unknown>) {
    if (event.type === "conversation.item.created" && event.item && typeof event.item === "object") {
      const item = event.item as Record<string, unknown>
      if (typeof item.id !== "string" || item.type !== "message" || item.role !== "user") return false
      const entry = this.entries.get(item.id)
      if (!entry?.sent) return false
      entry.finish({ status: "shared" })
      return true
    }
    if (event.type !== "error" || !event.error || typeof event.error !== "object") return false
    const error = event.error as Record<string, unknown>
    if (typeof error.event_id !== "string" || !error.event_id.startsWith("image_")) return false
    const entry = this.entries.get(error.event_id.slice(6))
    if (!entry?.sent) return false
    entry.finish({ status: "failed", error: "OpenAI rejected this image. Voice and existing work remain available." })
    return true
  }
}

function decode(data: string) {
  if (typeof data !== "string" || data.length > 350_000) return
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data)
  if (!match) return
  const bytes = Buffer.from(match[2], "base64")
  if (!bytes.length || bytes.length > 262_144 || bytes.toString("base64") !== match[2]) return
  const valid =
    match[1] === "image/jpeg"
      ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : match[1] === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
  if (!valid) return
  return { mime: match[1], bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") }
}
