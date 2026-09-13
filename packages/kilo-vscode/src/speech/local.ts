// raya_change - credentials for managed voice control stay on numeric loopback HTTP origins
export function local(value: string): string | undefined {
  try {
    const url = new URL(value)
    const parts = url.hostname.split(".")
    const host =
      url.hostname === "[::1]" ||
      (parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && +part <= 255))
    const root = url.pathname === "/" && !url.search && !url.hash
    if (url.protocol !== "http:" || !host || !root || url.username || url.password) return undefined
    return url.origin
  } catch {
    return undefined
  }
}
