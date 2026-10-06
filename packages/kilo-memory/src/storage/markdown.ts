/** Serialization for memory source documents: `## Section` headings containing `- key :: text` items. */
export namespace MemoryMarkdown {
  export type Entry = { section: string; key: string; text: string }

  const defaultSection = "Facts"

  function scan(text: string) {
    let fence = ""
    const lines = text.split("\n").map((raw) => {
      const match = raw.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/)
      if (fence) {
        if (match && match[1][0] === fence[0] && match[1].length >= fence.length && /^[\t \r]*$/.test(match[2]))
          fence = ""
        return { raw, visible: false }
      }
      if (!match || (match[1][0] === "`" && match[2].includes("`"))) return { raw, visible: true }
      fence = match[1]
      return { raw, visible: false }
    })
    return { lines, open: fence.length > 0 }
  }

  export function header(section: string) {
    return `## ${section}`
  }

  export function line(key: string, text: string) {
    return `- ${key} :: ${text}`
  }

  // Parse a source document into ordered entries. Items before the first heading take the default
  // section; non-item and malformed (empty key/body) lines are skipped.
  export function parse(text: string): Entry[] {
    const entries: Entry[] = []
    let section = defaultSection
    for (const line of scan(text).lines) {
      if (!line.visible) continue
      const value = line.raw.trim()
      if (value.startsWith("## ")) {
        section = value.slice(3).trim() || section
        continue
      }
      if (!value.startsWith("- ") || !value.includes(" :: ")) continue
      const idx = value.indexOf(" :: ")
      const key = value.slice(2, idx).trim()
      const body = value.slice(idx + 4).trim()
      if (!key || !body) continue
      entries.push({ section, key, text: body })
    }
    return entries
  }

  // Upsert a line under its heading: replace an existing line with the same key in that section,
  // otherwise append; create the heading when absent. Reports whether the document changed.
  export function upsert(input: { text: string; section: string; line: string }) {
    const marker = header(input.section)
    const view = scan(input.text)
    if (view.open) throw new Error("Cannot update memory with an unclosed code fence.")
    const lines = view.lines.map((item) => item.raw)
    const at = view.lines.findIndex((item) => item.visible && item.raw.trim() === marker)
    if (at === -1) {
      const next = `${input.text.trimEnd()}\n\n${marker}\n${input.line}\n`
      return { text: next, changed: next !== input.text }
    }
    const end = view.lines.findIndex((item, idx) => idx > at && item.visible && item.raw.trim().startsWith("## "))
    const stop = end === -1 ? lines.length : end
    const prefix = input.line.split(" :: ")[0]
    const without = lines.filter(
      (item, idx) => idx <= at || idx >= stop || !view.lines[idx].visible || !item.trim().startsWith(`${prefix} ::`),
    )
    const head = without.slice(0, at + 1)
    const tail = without.slice(at + 1)
    const next = [...head, input.line, ...tail].join("\n")
    return { text: next, changed: next !== input.text }
  }

  // Remove every item line whose entry matches; headings and other lines are preserved.
  export function remove(input: { text: string; match: (entry: Entry) => boolean }) {
    const lines = scan(input.text).lines
    let section = defaultSection
    const kept = lines.filter((item) => {
      if (!item.visible) return true
      const value = item.raw.trim()
      if (value.startsWith("## ")) {
        section = value.slice(3).trim() || section
        return true
      }
      if (!value.startsWith("- ") || !value.includes(" :: ")) return true
      const idx = value.indexOf(" :: ")
      const key = value.slice(2, idx).trim()
      const text = value.slice(idx + 4).trim()
      return !input.match({ section, key, text })
    })
    return { text: kept.map((item) => item.raw).join("\n"), count: lines.length - kept.length }
  }
}
