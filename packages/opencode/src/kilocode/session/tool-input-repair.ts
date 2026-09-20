export namespace ToolInputRepair {
  const LIMIT = 1024 * 1024

  export function complete(input: string): string | undefined {
    const text = input.trim()
    if (text.length === 0 || text.length > LIMIT || text[0] !== "{") return undefined

    try {
      JSON.parse(text)
      return undefined
    } catch {
      // Continue only to structural delimiter completion below.
    }

    const stack: string[] = []
    let quoted = false
    let escaped = false
    for (const char of text) {
      if (quoted) {
        if (escaped) {
          escaped = false
          continue
        }
        if (char === "\\") {
          escaped = true
          continue
        }
        if (char === '"') quoted = false
        continue
      }
      if (char === '"') {
        quoted = true
        continue
      }
      if (char === "{") stack.push("}")
      if (char === "[") stack.push("]")
      if (char === "}" || char === "]") {
        if (stack.pop() !== char) return undefined
      }
    }
    if (quoted || escaped || stack.length === 0) return undefined

    const output = `${text}${stack.reverse().join("")}`
    try {
      const value = JSON.parse(output)
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
      return output
    } catch {
      return undefined
    }
  }
}
