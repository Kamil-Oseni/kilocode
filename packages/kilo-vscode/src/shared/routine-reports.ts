import { z } from "zod"
import type { KilocodeRoutineReportsResponse } from "@kilocode/sdk/v2/client"

type Wire = KilocodeRoutineReportsResponse[number]
export type RoutineReport = Omit<Wire, "at" | "notice"> & {
  at: number
  notice?: Omit<NonNullable<Wire["notice"]>, "at"> & { at: number }
}

/** Mirrors the backend's durable report-card wire contract without loading its runtime. */
const Card = z.object({
  version: z.literal(1),
  id: z.string(),
  runID: z.string().optional(),
  agentID: z.string(),
  name: z.string(),
  sourceSessionID: z.string().optional(),
  reportSessionID: z.string(),
  workerSessionID: z.string().optional(),
  projectID: z.string(),
  directory: z.string(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  runRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  status: z.enum(["queued", "running", "complete", "blocked", "error"]),
  at: z.number().min(-8.64e15).max(8.64e15),
  summary: z.string().max(8000),
  delivery: z.enum(["delivered", "unavailable"]),
  notice: z.object({ at: z.number().min(-8.64e15).max(8.64e15), reason: z.enum(["busy", "deferred"]) }).optional(),
})
export const Reports: z.ZodType<RoutineReport[]> = z.array(Card).max(200)
export type AgentReportsRead = { type: "agentReportsRead"; requestID: string; sessionID: string }
export type AgentReportsLoaded = {
  type: "agentReportsLoaded"
  requestID: string
  sessionID: string
  items?: readonly RoutineReport[]
  error?: string
}
