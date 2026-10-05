import { open } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Scope } from "effect"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"

const root = process.env.RAYA_INDEXING_TEST_ROOT!
registerProcessProfile([root])
const scope = Scope.makeUnsafe()
const file = await open(path.join(root, "native.log"), "a")
if (process.env.RAYA_INDEXING_TEST_MODE === "failed") await file.close()
await Effect.runPromise(
  Scope.addFinalizer(
    scope,
    Effect.promise(async () => {
      await Bun.write(path.join(root, "entered"), "entered")
      if (process.env.RAYA_INDEXING_TEST_MODE === "held")
        while (!(await Bun.file(path.join(root, "release")).exists())) await Bun.sleep(10)
      try {
        await file.write("RAYA_INDEX_NATIVE_FINAL_MARKER\n")
      } finally {
        await file.close()
      }
      await Bun.write(path.join(root, "closed"), "closed")
    }),
  ),
)
RuntimeRegistry.register(() => Effect.runPromise(Scope.close(scope, Exit.void)))
await import("../../../src/kilocode/indexing-worker")
await Bun.write(path.join(root, "ready"), "ready")
