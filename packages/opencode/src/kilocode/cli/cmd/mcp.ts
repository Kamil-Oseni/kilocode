import { ConfigParse } from "@/config/parse"
import path from "node:path"
import { existsSync } from "node:fs"
import { applyEdits, modify } from "jsonc-parser"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { ConfigPublication } from "../../config/publication"

export namespace KilocodeMcpConfig {
  export function candidates(base: string, global: boolean) {
    const names = ["kilo.jsonc", "kilo.json", "opencode.jsonc", "opencode.json"]
    return [
      ...(global ? [] : [".kilo", ".kilocode"].flatMap((dir) => names.map((name) => path.join(base, dir, name)))),
      ...names.map((name) => path.join(base, name)),
    ]
  }

  export async function add(file: string, name: string, config: ConfigMCPV1.Info, base: string, global: boolean) {
    const files = candidates(base, global)
    const patch = structuredClone(config)
    if (!name || name.length > 256 || ["__proto__", "constructor", "prototype"].includes(name) || !files.includes(file))
      throw new Error("MCP configuration publication input is invalid")
    return ConfigPublication.promise({ files, targets: [file], roots: [base] }, async (tx) => {
      const selected = files.find((file) => existsSync(file)) ?? path.join(base, "kilo.json")
      if (selected !== file) throw new Error("MCP configuration target changed during admission")
      const before = (await tx.read(file)) ?? "{}"
      ConfigParse.jsonc(before, file)
      const after = format(
        file,
        applyEdits(
          before,
          modify(before, ["mcp", name], patch, {
            formattingOptions: { tabSize: 2, insertSpaces: true },
          }),
        ),
      )
      if (after !== before) await tx.write(file, before, after)
      return file
    })
  }

  export function format(file: string, input: string) {
    if (file.endsWith(".jsonc")) return input
    return JSON.stringify(ConfigParse.jsonc(input, file), null, 2)
  }
}
