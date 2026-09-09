import { Cause, Context, Effect, Layer, Option } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { KiloSessions } from "@/kilo-sessions/kilo-sessions"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "node:path"
import { Bus } from "@/bus"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionSummary } from "@/session/summary"
import { SessionExport } from "@/kilocode/session-export"
import { createWorkspaceProvider } from "@/kilocode/session-export/workspace-provider"
import { Instance } from "@/kilocode/instance"
import { Identity } from "@kilocode/kilo-telemetry"
import { MemoryLifecycle } from "@/kilocode/memory/turn"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { MemoryEvents } from "@/kilocode/memory/events"
import { installMemoryRuntime } from "@/kilocode/memory/runtime"
import { KiloToolRegistry } from "@/kilocode/tool/registry"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { KilocodeWatcher } from "@/kilocode/watcher"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder" // kilocode_change
import { Storage } from "@/storage/storage" // raya_change - Milestone A durable goal storage
import { RayaGoalContinuation } from "@/kilocode/goal/continuation" // raya_change - Milestone A idle continuation
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "@/config/config" // raya_change - Milestone I goal continuation setting

const log = Log.create({ service: "kilocode-bootstrap" })

export namespace KilocodeBootstrap {
  export interface Interface {
    readonly init: () => Effect.Effect<void, unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("@kilocode/Bootstrap") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      // Bind the package memory effect layer to opencode (paths, instance binder, logger, event sink).
      installMemoryRuntime()
      const kilo = yield* KiloSessions.Service
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const runs = yield* SessionRunState.Service
      const summary = yield* SessionSummary.Service
      const provider = yield* Provider.Service
      const memory = yield* MemoryService.Service
      const watcher = yield* KilocodeWatcher.Service
      const storage = Option.getOrUndefined(yield* Effect.serviceOption(Storage.Service)) // raya_change - Milestone A durable goal storage
      const config = yield* Config.Service // raya_change - Milestone I
      const database = yield* Database.Service
      const routines = storage ? yield* RayaTaskRunner.lifecycle({ bus, storage, sessions, database }) : undefined

      const init = Effect.fn("KilocodeBootstrap.init")(function* () {
        yield* watcher.init()
        yield* kilo.init()
        yield* MemoryLifecycle.subscribe({ bus, sessions, summary, provider, memory })
        if (storage) {
          yield* RayaGoalContinuation.subscribe({
            database,
            bus,
            sessions,
            storage,
            enabled: () => config.get().pipe(Effect.map((cfg) => cfg.raya_routing?.goal_continuation !== false)),
          }) // raya_change - Milestones A/I configurable idle continuation
          if (routines) yield* routines()
          yield* RayaGoalContinuation.restore({
            database,
            directory: Instance.directory,
            sessions,
            storage,
            enabled: () => config.get().pipe(Effect.map((cfg) => cfg.raya_routing?.goal_continuation !== false)),
            idle: (id) => runs.inspect(id).pipe(Effect.map((state) => state.phase === "idle")),
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.sync(() => log.warn("goal startup scan failed", { err: Cause.squash(cause) })),
            ),
            Effect.forkDetach,
          )
        }
        // Invalidate enabled cache on every memory state mutation (properties.directory holds the memory root).
        yield* bus.subscribeCallback(MemoryEvents.Status, (evt) =>
          KiloToolRegistry.invalidateMemoryEnabled(evt.properties.directory),
        )
        yield* bus.subscribeCallback(MemoryEvents.Updated, (evt) =>
          KiloToolRegistry.invalidateMemoryEnabled(evt.properties.directory),
        )
        // Session export bootstrap.
        yield* Effect.gen(function* () {
          if (!SessionExport.enabled) return
          const anon = yield* EffectBridge.fromPromise(() =>
            Identity.getMachineId().catch((err) => {
              log.warn("session export identity failed", { err })
              return undefined
            }),
          )
          SessionExport.init({
            agentVersion: InstallationVersion,
            anonId: anon,
            dbPath: path.join(Global.Path.data, "session-export.db"),
            workspaceKey: Instance.directory,
            subscribeAll: (cb) => Bus.subscribeAll(cb),
            snapshotProvider: createWorkspaceProvider({
              root: Instance.directory,
              statePath: path.join(Global.Path.data, "session-export-workspace.json"),
            }),
          })
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.warn("session export bootstrap failed", { err: Cause.squash(cause) })),
          ),
        )
        if (process.env["KILO_PLATFORM"] !== "vscode") {
          yield* EffectBridge.fromPromise(() =>
            import("@/kilocode/indexing").then((mod) => mod.KiloIndexing.init()),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.warn("indexing bootstrap failed", { err: Cause.squash(cause) })),
            ),
            Effect.forkDetach,
          )
        }
      })

      return Service.of({ init })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide([
      KiloSessions.defaultLayer,
      Session.defaultLayer,
      AppNodeBuilder.build(SessionRunState.node),
      AppNodeBuilder.build(SessionSummary.node),
      AppNodeBuilder.build(Provider.node),
      MemoryService.layer,
      Bus.defaultLayer,
      KilocodeWatcher.defaultLayer,
      AppNodeBuilder.build(Storage.node), // raya_change - Milestone A durable goal storage
      AppNodeBuilder.build(Database.node),
      AppNodeBuilder.build(Config.node), // raya_change - Milestone I routing settings
    ]),
  )

  const memory = LayerNode.make({ service: MemoryService.Service, layer: MemoryService.layer, deps: [] })
  const watcher = LayerNode.make({ service: KilocodeWatcher.Service, layer: KilocodeWatcher.defaultLayer, deps: [] })
  export const node = LayerNode.suspend(() =>
    LayerNode.make({
      service: Service,
      layer,
      deps: [
        KiloSessions.node,
        Session.node,
        SessionRunState.node,
        SessionSummary.node,
        Provider.node,
        memory,
        Bus.node,
        watcher,
        Storage.node, // raya_change - Milestone A durable goal storage
        Database.node,
        Config.node, // raya_change - Milestone I routing settings
      ],
    }),
  )
}
