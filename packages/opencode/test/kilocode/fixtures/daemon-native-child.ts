import { open } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"

const root = process.env.RAYA_DAEMON_TEST_ROOT
if (!root) throw new Error("Missing private daemon native fixture")
const mode = process.env.RAYA_DAEMON_CHILD_CASE
const scope = Scope.makeUnsafe()
const file = await open(path.join(root, "native-finalizer.log"), "a")
if (mode === "failed") await file.close() // Real closed-handle fault, not a mocked cleanup result.
await Effect.runPromise(
  Scope.addFinalizer(
    scope,
    Effect.promise(async () => {
      await Bun.write(path.join(root, "native-finalizer-entered"), "entered")
      if (mode === "held")
        while (!(await Bun.file(path.join(root, "native-finalizer-release")).exists())) await Bun.sleep(10)
      try {
        await file.write("RAYA_DAEMON_NATIVE_FINAL_MARKER\n")
      } finally {
        await file.close()
      }
      await Bun.write(path.join(root, "native-finalizer-closed"), "closed")
    }),
  ),
)
RuntimeRegistry.register(() => Effect.runPromise(Scope.close(scope, Exit.void)))
const entry = path.resolve("src/index.ts")
process.argv = [process.execPath, entry, ...process.argv.slice(2)]
await import(entry)
throw new Error("Actual CLI serve returned without natural outer exit")
