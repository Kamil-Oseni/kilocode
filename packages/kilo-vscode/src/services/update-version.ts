/** Parse complete SemVer values; prefixes are accepted only at the start. */
function parse(value: string) {
  const match =
    /^(?:raya-v|v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    )
  if (!match) return
  const pre = match[4]?.split(".") ?? []
  if (pre.some((part) => /^0\d+$/.test(part))) return
  return { core: match.slice(1, 4).map(BigInt), pre }
}

/** Follow numeric, ASCII, and identifier-count precedence; ignore build metadata. */
export function compare(a: string, b: string): number {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) throw new Error("Cannot compare invalid Raya release versions.")
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index]! > right.core[index]! ? 1 : -1
  }
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length)
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const numeric = /^\d+$/.test(x)
    const other = /^\d+$/.test(y)
    if (numeric && other) return BigInt(x) > BigInt(y) ? 1 : -1
    if (numeric !== other) return numeric ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

/** Only the Raya release workflow's tag namespace can supply extension updates. */
export function eligible(release: { tag_name: string; draft: boolean; prerelease: boolean }, previews: boolean) {
  if (release.draft || typeof release.tag_name !== "string" || !release.tag_name.startsWith("raya-v")) return false
  const version = parse(release.tag_name)
  return !!version && (previews || (!release.prerelease && version.pre.length === 0))
}
