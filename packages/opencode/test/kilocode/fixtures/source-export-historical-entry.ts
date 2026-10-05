import path from "node:path"

await import("./source-export-historical-sqlite")
const { ManagedRuntime } = await import("effect")
const { Database } = await import("@opencode-ai/core/database/database")
const { seedAllocator } = await import("./source-sql-allocator-seed")
if (!process.env.RAYA_DB) throw new Error("Allocator fixture requires private primary database")
const runtime = ManagedRuntime.make(Database.layerFromPath(process.env.RAYA_DB))
const counters = await runtime.runPromise(seedAllocator).finally(() => runtime.dispose())
const evidence = process.env.RAYA_TEST_EVIDENCE
if (!evidence || !path.isAbsolute(evidence)) throw new Error("Allocator fixture requires private witness directory")
await Bun.write(path.join(evidence, "allocator.json"), JSON.stringify(counters))
await import("./source-storage-seed")
await import("./source-operational-seed")
await import("./source-voice-reconciliation-seed")
await import("../../../src/index")
