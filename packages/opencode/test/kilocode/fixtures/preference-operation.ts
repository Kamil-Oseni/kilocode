import { Global } from "@opencode-ai/core/global"
import { SandboxPreference } from "@/kilocode/sandbox/preference"
import { Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"

const input = Schema.decodeUnknownSync(Schema.Struct({ dir: Schema.String, base: Schema.String, mode: Schema.String }))(
  JSON.parse(process.argv[2]),
)
Global.Path.state = path.join(input.base, "kilo")
try {
  if (input.mode === "one") {
    await SandboxPreference.write("project", true)
    await fs.writeFile(path.join(input.dir, "result.json"), JSON.stringify({ ok: true }))
  }
  if (input.mode === "loop") {
    const deadline = performance.now() + 10_000
    let count = 0
    while (!(await Bun.file(path.join(input.dir, "release")).exists())) {
      if (performance.now() >= deadline) throw new Error("Preference fixture release timed out")
      await SandboxPreference.write("project", count % 2 === 0)
      count += 1
      await fs.writeFile(path.join(input.dir, "count"), String(count))
    }
    await fs.writeFile(path.join(input.dir, "result.json"), JSON.stringify({ ok: true, count }))
  }
} catch (err) {
  await fs.writeFile(path.join(input.dir, "result.json"), JSON.stringify({ ok: false, error: String(err) }))
}
