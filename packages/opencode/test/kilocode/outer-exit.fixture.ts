import { Effect, Exit, Logger, Scope } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { fileLogger } from "@opencode-ai/core/observability/logging"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { join, resolve } from "node:path"
import { finish } from "../../src/kilocode/cli/finish"

const root = process.env.RAYA_EXIT_PROFILE
if (!root) throw new Error("Missing isolated exit profile")
const mode = process.env.RAYA_EXIT_CASE
if (mode === "status") process.exitCode = 7
const scope = Scope.makeUnsafe()
const logger =
  mode === "effect-log" || mode === "effect-log-cleanup"
    ? await Effect.runPromise(
        fileLogger(join(root, "effect-last.log")).pipe(
          Effect.provide(NodeFileSystem.layer),
          Effect.provideService(Scope.Scope, scope),
        ),
      )
    : undefined
await Effect.runPromise(
  Scope.addFinalizer(
    scope,
    Effect.gen(function* () {
      if (logger) {
        yield* Effect.promise(() => Bun.write(join(root, "log-path"), join(root, "effect-last.log")))
        yield* Effect.log("RAYA_OUTER_FINALIZER_LAST_MARKER").pipe(Effect.provide(Logger.layer([logger])))
      }
      if (mode === "log" || mode === "log-cleanup" || mode === "serve-orphan") {
        yield* Effect.promise(async () => {
          const log = await import("@opencode-ai/core/util/log")
          await Bun.write(join(root, "log-path"), log.file())
          log.Default.info("RAYA_OUTER_FINALIZER_LAST_MARKER")
        })
      }
      if (mode === "held") {
        yield* Effect.promise(() => Bun.write(join(root, "waiting"), "held"))
        while (!(yield* Effect.promise(() => Bun.file(join(root, "release")).exists()))) yield* Effect.sleep(10)
      }
      yield* Effect.promise(() =>
        Bun.write(join(root, "finalizer.json"), JSON.stringify({ code: process.exitCode ?? 0, mode, settled: true })),
      )
      if (["cleanup", "both", "status", "log-cleanup", "effect-log-cleanup", "publish-cleanup"].includes(mode ?? ""))
        yield* Effect.die(new Error("outer exit finalizer failed"))
    }),
  ),
)
RuntimeRegistry.register(() => Effect.runPromise(Scope.close(scope, Exit.void)))

if (mode === "held" || mode === "status") await finish([])
if (mode?.startsWith("publish"))
  await finish([], async () => {
    const receipt = await Bun.file(join(root, "finalizer.json")).json()
    if (!receipt.settled) throw new Error("Publication ran before retirement")
    if (mode === "publish-throw") throw new Error("RAYA_PRIVATE_PUBLICATION_ERROR")
    process.stdout.write("RAYA_RETIREMENT_PUBLICATION\n")
  })

const entry = resolve(import.meta.dir, "../../src/index.ts")
process.argv = [process.execPath, entry, ...(mode === "help" ? ["--help"] : ["db", "path"])]
if (mode === "serve-orphan") process.argv = [process.execPath, entry, "serve", "--hostname", "127.0.0.1", "--port", "0"]
if (mode === "command" || mode === "both")
  process.argv = [process.execPath, entry, "db", "SELECT * FROM raya_missing_outer_exit_table"]
await import(entry)
throw new Error("Outer CLI entry returned without explicit exit")
