/** Canonical display of the authorized directory listing, shared with its historical handoff. */
export function format(input: {
  path: string
  entries: readonly string[]
  totalEntries: number
  offset: number
  truncated: boolean
}) {
  return [
    `<path>${input.path}</path>`,
    `<type>directory</type>`,
    `<entries>`,
    input.entries.join("\n"),
    input.truncated
      ? `\n(Showing ${input.entries.length} of ${input.totalEntries} entries. Use 'offset' parameter to read beyond entry ${input.offset + input.entries.length})`
      : `\n(${input.totalEntries} entries)`,
    `</entries>`,
  ].join("\n")
}
