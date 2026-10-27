import { isDeepStrictEqual } from "node:util"
import { Effect, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionID } from "@/session/schema"
import * as Lineage from "./effect-lineage"
import * as Files from "./output-scope"
import { record } from "./continuation"

/** Attenuate actual native effects; this never grants a tool, path or filesystem permission. */
export const check = Effect.fn("RoutineOutputs.check")(function* (sessionID: string, targets: readonly string[]) {
  const actor = yield* Lineage.session()
  if (actor !== undefined && actor !== sessionID)
    return yield* Effect.fail(new Error("The original output-scope session changed."))
  // Resolve existing selected services only after a genuine execution callback exists.
  const session = yield* Effect.promise(() => import("@/session/session"))
  const service = yield* Effect.serviceOption(session.Session.Service)
  if (Option.isNone(service)) {
    if (actor === undefined) return undefined
    return yield* Effect.fail(new Error("The original output-scope session is unavailable."))
  }
  const found = yield* service.value.get(SessionID.make(sessionID)).pipe(Effect.option)
  if (Option.isNone(found)) {
    return yield* Effect.fail(new Error("The original output-scope session is unavailable."))
  }
  const current = found.value
  if (current.metadata?.rayaRoutine === undefined) {
    const database = yield* Effect.serviceOption(Database.Service)
    if (Option.isSome(database)) {
      const module = yield* Effect.promise(() => import("./delegation"))
      const delegated = yield* module.RayaTaskDelegation.make(database.value).bySession(sessionID)
      if (delegated) {
        if (delegated.outputs !== undefined)
          return yield* Effect.fail(new Error("The original managed session lost its output-scope identity."))
        const stores = yield* Effect.promise(() => import("@/storage/storage"))
        const storage = yield* Effect.serviceOption(stores.Storage.Service)
        if (Option.isNone(storage)) return yield* Effect.fail(new Error("The original startup scope is unavailable."))
        const starts = yield* Effect.promise(() => import("./snapshot"))
        const snapshot = delegated.childRunID
          ? yield* starts.RayaTaskSnapshot.make({ storage: storage.value }).find(delegated.childRunID)
          : undefined
        if (!snapshot || snapshot.outputs !== undefined)
          return yield* Effect.fail(new Error("The original scoped startup identity is unavailable."))
      }
    }
    const original = yield* Lineage.origin()
    if (original?.sessionID === sessionID)
      return yield* Effect.fail(new Error("The original managed session lost its output-scope identity."))
    if (original) {
      const stores = yield* Effect.promise(() => import("@/storage/storage"))
      const storage = yield* Effect.serviceOption(stores.Storage.Service)
      if (Option.isNone(storage)) return yield* Effect.fail(new Error("The original startup scope is unavailable."))
      const starts = yield* Effect.promise(() => import("./snapshot"))
      const snapshot = yield* starts.RayaTaskSnapshot.make({ storage: storage.value }).find(original.id)
      if (!snapshot || snapshot.outputs !== undefined)
        return yield* Effect.fail(new Error("Scoped worker execution cannot escape through a child session."))
    }
    return undefined
  }
  if (actor === undefined)
    return yield* Effect.fail(new Error("The original output-scope execution owner is unavailable."))
  const identity = yield* Schema.decodeUnknownEffect(record)(current.metadata?.rayaRoutine)
  if (!identity.delegationID) {
    const original = yield* Lineage.origin()
    const stores = yield* Effect.promise(() => import("@/storage/storage"))
    const storage = yield* Effect.serviceOption(stores.Storage.Service)
    if (original && Option.isNone(storage))
      return yield* Effect.fail(new Error("The original startup scope is unavailable."))
    if (original && Option.isSome(storage)) {
      const starts = yield* Effect.promise(() => import("./snapshot"))
      const snapshot = yield* starts.RayaTaskSnapshot.make({ storage: storage.value }).find(original.id)
      if (!snapshot || snapshot.outputs !== undefined)
        return yield* Effect.fail(new Error("The scoped startup lost its original delegation identity."))
    }
    if (identity.outputs !== undefined)
      return yield* Effect.fail(new Error("A declared output scope needs its original delegation."))
    return undefined
  }
  const database = yield* Effect.serviceOption(Database.Service)
  if (Option.isNone(database))
    return yield* Effect.fail(new Error("The original output-scope database is unavailable."))
  const module = yield* Effect.promise(() => import("./delegation"))
  const delegated = yield* module.RayaTaskDelegation.make(database.value).get(identity.delegationID)
  if (actor === undefined || !(yield* Lineage.matches({ id: identity.runID, agentID: identity.agentID, sessionID })))
    return yield* Effect.fail(new Error("The original output-scope execution owner is unavailable."))
  if (
    delegated.recipientID !== identity.agentID ||
    delegated.childRunID !== identity.runID ||
    delegated.sessionID !== sessionID ||
    delegated.organizationID !== identity.organizationID ||
    delegated.organizationRevision !== identity.organizationRevision ||
    (delegated.state !== "running" && delegated.state !== "needs_input") ||
    !isDeepStrictEqual(delegated.outputs, identity.outputs)
  )
    return yield* Effect.fail(new Error("The saved output scope no longer matches this original run."))
  const stores = yield* Effect.promise(() => import("@/storage/storage"))
  const storage = yield* Effect.serviceOption(stores.Storage.Service)
  const fs = yield* Effect.serviceOption(FSUtil.Service)
  if (Option.isNone(storage) || Option.isNone(fs))
    return yield* Effect.fail(new Error("The original output-scope services are unavailable."))
  const starts = yield* Effect.promise(() => import("./snapshot"))
  const snapshot = yield* starts.RayaTaskSnapshot.make({ storage: storage.value }).find(identity.runID)
  if (
    !snapshot ||
    snapshot.sessionID !== sessionID ||
    snapshot.agentID !== identity.agentID ||
    !isDeepStrictEqual(snapshot.outputs, delegated.outputs)
  )
    return yield* Effect.fail(new Error("The immutable output-scope snapshot changed."))
  if (delegated.outputs === undefined) return undefined
  const files = delegated.outputs
  yield* Files.pinned(fs.value, files)
  const paths = yield* Files.canonical(fs.value, targets)
  if (paths.some((file) => !Files.includes(files, file)))
    return yield* Effect.fail(
      new Error("This file is outside this worker's declared outputs. Preserve other stages' files."),
    )
  return files
})
