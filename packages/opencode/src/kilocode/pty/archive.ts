import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Location } from "@opencode-ai/core/location"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Pty } from "@opencode-ai/core/pty"
import type { WorkspaceID } from "@opencode-ai/schema/workspace-id"
import type { SessionID } from "@/session/schema"
import { PtyOwners } from "./lifecycle"
import { locationServiceMapLayer } from "./location-map"

export interface Interface {
  readonly stop: (sessionID: SessionID, directory: string, workspaceID?: WorkspaceID) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@raya/PtyArchive") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      const database = yield* Database.Service
      const owners = yield* PtyOwners.Service
      return Service.of({
        stop: (sessionID, directory, workspaceID) =>
          Effect.gen(function* () {
            const row = yield* database.db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!row || row.directory !== directory || (row.workspace_id ?? undefined) !== workspaceID)
              throw new Error("Terminal archive requires its exact persisted session location")
            const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID }))
            yield* Effect.gen(function* () {
              const pty = yield* Pty.Service
              yield* pty.stopOwner(sessionID)
            }).pipe(Effect.provide(location), Effect.orDie)
            yield* owners.assert(sessionID, directory)
          }),
      })
    }),
  ).pipe(Layer.provide(locationServiceMapLayer)),
  deps: [Database.node, PtyOwners.node],
})

export * as PtyArchive from "./archive"
