import { freemem, totalmem } from "node:os"
import { status } from "../provider/local-scheduler"
import type { RayaAdmin } from "./registry"

/** Backend-wide observations: these are not attributable to a single worker or GPU model. */
export function resources(): RayaAdmin.Resources {
  const memory = process.memoryUsage()
  return {
    observedAt: Date.now(),
    process: { pid: process.pid, rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
    host: { free: freemem(), total: totalmem() },
    inference: status(),
  }
}
