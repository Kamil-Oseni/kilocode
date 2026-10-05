import { Schema } from "effect"

export namespace Codec {
  export const Info = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    hash: Schema.String,
    createdAt: Schema.Number,
  })
  export type Info = typeof Info.Type

  export const List = Schema.Array(Info)
}
