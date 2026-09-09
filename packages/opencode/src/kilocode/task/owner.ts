import { hostname } from "node:os"

export function owner() {
  return { host: hostname(), pid: process.pid }
}

/** Only ESRCH for a valid local PID proves absence; denied probes and foreign hosts remain uncertain. */
export function stopped(value: unknown) {
  if (!value || typeof value !== "object" || !("host" in value) || !("pid" in value)) return false
  if (value.host !== hostname() || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0)
    return false
  try {
    process.kill(value.pid, 0)
    return false
  } catch (error) {
    return !!error && typeof error === "object" && "code" in error && error.code === "ESRCH"
  }
}
