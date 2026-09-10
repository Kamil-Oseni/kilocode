import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { CapabilityCatalog } from "@/kilocode/capability/catalog"

const Parameters = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description: "Optional words describing a local capability, input format or desired result.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10))),
})

export const DiscoverCapabilitiesTool = Tool.define(
  "discover_capabilities",
  Effect.succeed({
    description:
      "Discover known local file, text-artifact, document/spreadsheet extraction, repository and chart capabilities exposed in this model turn. Use when capability or output-format support is unclear. Reports exact limitations; does not execute tools, grant permissions, connect accounts or list every business-service integration. A spreadsheet reader is not an editor or recalculation engine.",
    parameters: Parameters,
    execute: (query: typeof Parameters.Type, ctx: Tool.Context) =>
      Effect.sync(() => {
        const result = CapabilityCatalog.inspect(ctx, query)
        return {
          title: "Local work capabilities",
          output: JSON.stringify(result),
          metadata: { version: result.version, bound: result.bound, matched: result.matched, truncated: false },
        }
      }),
  }),
)
