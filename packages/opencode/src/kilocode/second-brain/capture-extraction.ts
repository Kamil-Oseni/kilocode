import { jsonSchema } from "ai"
import { Schema } from "effect"
import { CaptureEntries } from "./capture-protocol"

const contract = Schema.Struct({ entries: CaptureEntries })

/** Generation and publication share the same bounded entry contract. */
export const extraction = jsonSchema<typeof contract.Type>(Schema.toJsonSchemaDocument(contract).schema, {
  validate: async (value) =>
    Schema.is(contract)(value)
      ? { success: true, value }
      : { success: false, error: new Error("Capture extraction does not match the bounded entry schema") },
})

export function extracted(value: unknown) {
  if (!Schema.is(contract)(value)) throw new Error("Capture extraction does not match the bounded entry schema")
  return value.entries
}
