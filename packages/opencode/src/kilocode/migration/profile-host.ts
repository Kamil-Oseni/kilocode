import { lstat } from "node:fs/promises"
import path from "node:path"
import { PayloadSchema, type Payload } from "@opencode-ai/core/kilocode/source-capsule"
import { read } from "./profile-file"

export const host = PayloadSchema.superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
    ctx.addIssue({ code: "custom", message: "Host evidence exceeds its byte bound" })
})

/** Held choices are inert evidence. This function supplies no native ownership or writer authority. */
export async function held(data: string, selected?: Payload) {
  const file = path.join(data, "restore-host.json")
  const info = await lstat(file).catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
    throw err
  })
  const previous = info ? host.parse(JSON.parse((await read(file, 1024 * 1024, 1024 * 1024)).value)) : undefined
  if (!selected) return previous
  const current = host.parse(selected)
  if (!previous) return current
  return host.parse({
    format: "raya.host-capsule",
    version: 1,
    hosts: [...new Map([...previous.hosts, ...current.hosts].map((item) => [item.id, item])).values()],
  })
}
