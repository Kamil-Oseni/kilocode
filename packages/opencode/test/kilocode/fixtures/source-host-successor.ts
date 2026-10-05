import { successor } from "../../../src/kilocode/migration/source-host"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
await successor()
await closeProcessProfile()
process.exit()
