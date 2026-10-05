import { withRetirement } from "../../../src/kilocode/migration/source-host"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
await withRetirement(async () => {
  await Bun.write(process.argv[2], "unexpected capture")
})
await closeProcessProfile()
process.exit()
