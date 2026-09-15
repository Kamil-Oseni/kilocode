import path from "path"
import { Global } from "@opencode-ai/core/global"

// kilocode_change start - resolve the managed output directory from the active profile
export function truncationDir() {
  return path.join(Global.Path.data, "tool-output")
}
// kilocode_change end
