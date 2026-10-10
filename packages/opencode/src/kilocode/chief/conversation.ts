/** Supplied conversational intent grants no acquisition, preference-save or goal authority. */
export function greeting(request: string) {
  if (Buffer.byteLength(request, "utf8") > 512) return false
  const rows = request
    .trim()
    .replace(/[.!]$/, "")
    .split(/[.;!]\s*/)
  if (rows.length > 6) return false
  if (
    !/^(?:(?:hi|hello|hey|good morning|good afternoon|good evening)|(?:please )?(?:reply|respond) with (?:one|a) (?:(?:short|brief|friendly) )?greeting|(?:please )?say (?:hi|hello))$/i.test(
      rows[0],
    )
  )
    return false
  const action =
    "(?:save (?:this|it)(?: as (?:a )?(?:preference|memory))?|(?:perform|take) any actions|(?:use|call) (?:any )?tools|change anything)"
  const restriction = new RegExp(`^(?:please )?(?:do not|don't) ${action}(?: (?:or|and) ${action})*$`, "i")
  return rows
    .slice(1)
    .every(
      (row) =>
        /^(?:this is|it's|it is) (?:just |only )?(?:a )?(?:temporary |brief )?(?:conversation|chat|greeting) (?:check|test)$/i.test(
          row,
        ) ||
        /^no (?:actions|tools|saving)$/i.test(row) ||
        restriction.test(row),
    )
}
