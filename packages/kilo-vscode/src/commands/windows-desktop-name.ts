import { execFile } from "node:child_process"
import { isAbsolute } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

/** A native diagnostic result is not desktop authority. Only Default is eligible. */
export function decodeDesktopNames(output: string): { host?: string; input?: string } {
  if (Buffer.byteLength(output, "utf8") > 8_192) throw new Error("Invalid desktop metadata")
  const value: unknown = JSON.parse(output)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid desktop metadata")
  const record = value as Record<string, unknown>
  const name = (value: unknown) =>
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 255 &&
      !/[\u0000-\u001f]/.test(value) &&
      Buffer.from(value, "utf8").toString("utf8") === value)
  if (
    Object.keys(record).sort().join(",") !== "host,input,interactive,operation,version" ||
    record.version !== 1 ||
    record.operation !== "desktop-names" ||
    !name(record.host) ||
    !name(record.input) ||
    typeof record.interactive !== "boolean" ||
    record.interactive !== (record.host === "Default" && record.input === "Default")
  )
    throw new Error("Invalid desktop metadata")
  return {
    host: typeof record.host === "string" ? record.host : undefined,
    input: typeof record.input === "string" ? record.input : undefined,
  }
}

export async function desktopNames(path: string, signal?: AbortSignal): Promise<{ host?: string; input?: string }> {
  if (process.platform !== "win32") return {}
  if (!isAbsolute(path)) throw new Error("An explicit native desktop helper is required")
  signal?.throwIfAborted()
  const started = performance.now()
  const output = await execute(path, ["--desktop-names-v1"], {
    windowsHide: true,
    timeout: 8_000,
    maxBuffer: 8_192,
    signal,
    encoding: "buffer",
  })
  signal?.throwIfAborted()
  if (performance.now() - started >= 8_000) throw new Error("Desktop metadata deadline exceeded")
  return decodeDesktopNames(new TextDecoder("utf-8", { fatal: true }).decode(output.stdout))
}
