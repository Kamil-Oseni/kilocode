import { sourceScopes } from "@opencode-ai/core/kilocode/process-profile"
import { workerScopes } from "./cli/worker-scopes"
import { z } from "zod"
import { observation } from "./cli/profile-retirement"

const Schema = z.object({ runID: z.string().min(1), generation: z.uuid(), requestID: z.uuid() }).strict()
export type Request = z.infer<typeof Schema>
export type Receipt = Request & {
  role: "indexing-worker"
  receipt: ReturnType<typeof observation>
  scopes?: ReturnType<typeof workerScopes>
}
export const GENERATION = "RAYA_INDEXING_GENERATION"
export const RUN = "RAYA_INDEXING_RUN"

export function accept(input: unknown, env = process.env) {
  const request = Schema.parse(input)
  if (request.generation !== env[GENERATION] || request.runID !== env[RUN])
    throw new Error("Indexing shutdown identity does not match")
  return request
}

export function acknowledge(request: Request): Receipt {
  return { ...request, role: "indexing-worker", receipt: observation(), scopes: sourceScopes() }
}

export function validate(input: Receipt, request: Request) {
  if (
    input.role !== "indexing-worker" ||
    input.runID !== request.runID ||
    input.generation !== request.generation ||
    input.requestID !== request.requestID
  )
    throw new Error("Indexing shutdown acknowledgment does not match")
  return { ...input, scopes: workerScopes(input.scopes, input.receipt.roots) }
}
