import { existsSync } from "node:fs"
import { applyEdits, modify } from "jsonc-parser"
import { ConfigParse } from "@/config/parse"
import { ConfigPublication } from "./publication"
import { isRecord } from "@/util/record"

export namespace ConfigSetup {
  export function missing(text: string, file: string) {
    const value = ConfigParse.jsonc(text, file)
    return !isRecord(value) || !value.$schema
  }
  export function schema(file: string) {
    return ConfigPublication.promise({ files: [file] }, async (tx) => {
      const before = await tx.read(file)
      if (before === undefined) throw new Error("Config setup predecessor disappeared")
      const value = ConfigParse.jsonc(before, file)
      if (isRecord(value) && value.$schema) return before
      const after = applyEdits(
        before,
        modify(before, ["$schema"], "https://app.kilo.ai/config.json", {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
          getInsertionIndex: () => 0,
        }),
      )
      if (after !== before) await tx.write(file, before, after)
      return after
    })
  }

  export function seed(files: readonly string[], target: string) {
    return ConfigPublication.promise({ files, targets: [target] }, async (tx) => {
      if (files.some((file) => existsSync(file))) return
      await tx.write(target, "{}", JSON.stringify({ $schema: "https://app.kilo.ai/config.json" }, null, 2))
    })
  }

  export function legacy(
    files: readonly string[],
    source: string,
    target: string,
    merge: (before: unknown, patch: unknown) => unknown,
  ) {
    return ConfigPublication.promise({ files: [...files, source], targets: [source, target] }, async (tx) => {
      const text = await tx.read(source)
      if (text === undefined) return false
      const parsed = Bun.TOML.parse(text)
      if (!isRecord(parsed)) throw new Error("Config legacy source is not an object")
      const { provider, model, ...rest } = parsed
      const patch = {
        ...rest,
        ...(provider && model ? { model: `${provider}/${model}` } : {}),
        $schema: "https://app.kilo.ai/config.json",
      }
      const before = (await tx.read(target)) ?? "{}"
      const after = JSON.stringify(merge(ConfigParse.jsonc(before, target), patch), null, 2)
      if (after !== before) await tx.write(target, before, after)
      await tx.remove(source, text)
      return true
    })
  }
}
