import { MemoryOperation } from "./operation"
import { MemoryAudit } from "./audit"
import { MemoryFs } from "./fs"
import { MemorySessions } from "./sessions"
import { MemorySources } from "./sources"
import { MemoryState } from "./state"
import { MemoryDream } from "./dream"
import { MemoryDreamJob } from "./dream-job"

/** Low-level raw-root APIs. Callers must pass a project-owned root from MemoryPaths.root(ctx). */
export namespace MemoryFiles {
  export const dream = MemoryDream
  export const dreamJob = MemoryDreamJob
  export const configure = MemoryOperation.configure
  export const hosted = MemoryOperation.hosted

  export type Decision = MemoryAudit.Decision
  export type InventoryItem = MemorySources.InventoryItem
  export type Inventory = MemorySources.Inventory

  export const exists = MemoryFs.exists
  export const queue = MemoryFs.queue

  export const readState = MemoryOperation.scoped(MemoryState.readState)
  export const writeState = MemoryOperation.scoped(MemoryState.writeState)
  export const inventoryKey = MemorySources.inventoryKey
  export const deriveInventory = MemorySources.deriveInventory
  export const writeManifest = MemoryOperation.scoped(MemoryState.writeManifest)

  export const append = MemoryAudit.append
  export const decide = MemoryAudit.decide
  export const readDecisions = MemoryAudit.readDecisions
  export const readChanges = MemoryAudit.readChanges

  export const indexExpired = MemoryState.indexExpired
  export const scaffold = MemoryOperation.scoped(MemoryState.scaffold)
  export const owned = MemoryState.owned
  export const cleanup = MemoryOperation.scoped(MemoryState.cleanup)

  export const writeSession = MemoryOperation.scoped(MemorySessions.writeSession)
  export const readSession = MemorySessions.readSession
  export const pruneSessions = MemoryOperation.scoped(MemorySessions.pruneSessions)
  export const recentSessions = MemorySessions.recentSessions

  export const readSource = MemorySources.readSource
  export const writeSource = MemoryOperation.scoped(MemorySources.writeSource)

  export const readIndex = MemoryState.readIndex
  export const writeIndex = MemoryOperation.scoped(MemoryState.writeIndex)

  export const show = MemoryOperation.scoped(MemoryState.show)
  export const purge = MemoryOperation.scoped(MemoryState.purge)
}
