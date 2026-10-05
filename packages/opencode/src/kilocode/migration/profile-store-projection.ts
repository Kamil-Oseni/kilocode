import type z from "zod"
import type { payload } from "./profile-bundle"
import { inactiveSQL } from "./profile-inactive-sql"
import { mapper, remap } from "./profile-workspaces"
import { remapComposers } from "./profile-composers"

/** Pure inactive evidence rendering; no store files, owners, or source counters are installed. */
export function projectStores(
  source: Pick<z.output<typeof payload>, "stores">,
  mapping: ReadonlyMap<string, string>,
  now: number,
) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Inactive store projection requires exact writer time")
  const translate = mapper(mapping)
  return source.stores?.map((store) => {
    if (store.kind !== "raya") return store
    return {
      ...store,
      sql: remap(inactiveSQL(store.sql), mapping),
      workspaces: store.workspaces.map(translate),
      content: store.content
        ? {
            ...store.content,
            composers: store.content.composers ? remapComposers(store.content.composers, mapping) : undefined,
          }
        : undefined,
    }
  })
}
