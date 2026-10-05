// kilocode_change - new file
import { shutdown } from "@/kilocode/cli/cmd/tui/worker-shutdown"

export function createWorkerShutdown(input: Parameters<typeof shutdown>[0]) {
  return shutdown(input)
}
