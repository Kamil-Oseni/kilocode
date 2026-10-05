import { ripgrep } from "@opencode-ai/core/kilocode/ripgrep-owner"

// Actual original command exit observes the same Core participant, without admitting a writer.
process.on("exit", () => {
  process.stderr.write("RAYA_MODELS_OWNER " + JSON.stringify(ripgrep.snapshot()) + "\n")
})
