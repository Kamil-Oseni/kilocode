import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { MemoryFiles } from "@kilocode/kilo-memory/store"
import type { BrainSettings } from "./settings"

type Approved = Parameters<typeof MemoryFiles.dreamManual.start>[2]["approved"]
type Review = Readonly<{ root: string; project: string; approved: Approved }>

/** Explicit host review binds one selected input set to the original configured root. */
export async function selection(
  input: {
    settings: BrainSettings
    project: string
    approved: Approved
    trusted(project: string): boolean
    review(value: Review, signal: AbortSignal): Promise<boolean>
  },
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const project = input.project
  const approved = structuredClone(input.approved)
  const settings = input.settings
  const trusted = input.trusted.bind(input)
  const review = input.review.bind(input)
  if (!path.isAbsolute(project) || !trusted(project)) throw new Error("Select an exact trusted Dream workspace")
  const cfg = await settings.load()
  signal.throwIfAborted()
  if (!cfg || cfg.setup.version !== 2 || !settings.current(cfg.setup))
    throw new Error("Select the original reviewed SecondBrain configuration")
  const root = cfg.setup.root
  if (Buffer.byteLength(JSON.stringify(approved)) > 64000) throw new Error("Dream selection exceeds its review bound")
  if (!(await review({ root, project, approved: structuredClone(approved) }, signal)))
    throw new Error("Manual Dream selection was not approved")
  signal.throwIfAborted()
  if (!trusted(project) || !settings.current(cfg.setup)) throw new Error("Dream authority changed during review")
  let closed = false
  return {
    root,
    project,
    approved: structuredClone(approved),
    close() {
      closed = true
    },
    async authorize(selected: string, directory: string, evidence: Approved, current: AbortSignal) {
      current.throwIfAborted()
      signal.throwIfAborted()
      if (
        closed ||
        selected !== root ||
        directory !== project ||
        !isDeepStrictEqual(evidence, approved) ||
        !trusted(project) ||
        !settings.current(cfg.setup)
      )
        throw new Error("Original manual Dream selection is no longer authorized")
    },
  }
}
