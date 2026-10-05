import { lstat } from "node:fs/promises"
import { NativeProcess } from "./process-host"

/** An absent hint saves a helper launch; only the native held read supplies positive metadata. */
export async function read(file: string, helper?: string, probe = false) {
  if (probe) {
    const info = await lstat(file).catch((err: unknown) => {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err
      return undefined
    })
    if (!info) return undefined
  }
  const value = await NativeProcess.receipt(file, helper)
  return value ? (JSON.parse(Buffer.from(value.data, "base64").toString("utf8")) as unknown) : undefined
}
