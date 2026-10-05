import path from "node:path"
import { writeFile } from "node:fs/promises"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"

const dir = process.env.RAYA_TEST_ACK_EXTERNAL
if (!dir || !path.isAbsolute(dir)) throw new Error("External ACK fixture requires a private absolute root")
registerProcessProfile([dir])
await writeFile(
  path.join(dir, "actual-index.json"),
  JSON.stringify({ fixture: "external-ack", content: "café 日本語 😀" }),
)
await import("../../../src/index")
