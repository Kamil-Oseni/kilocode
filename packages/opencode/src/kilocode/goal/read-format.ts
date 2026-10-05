export function scanner() {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const prefix: number[] = []
  const endings = new Set<string>()
  let size = 0
  let prior = -1
  let valid = true
  const decode = (bytes?: Uint8Array) => {
    if (!valid) return
    try {
      decoder.decode(bytes, { stream: bytes !== undefined })
    } catch (err) {
      if (!(err instanceof TypeError)) throw err
      valid = false
    }
  }
  return {
    add(bytes: Uint8Array) {
      size += bytes.length
      decode(bytes)
      for (const byte of bytes) {
        if (prefix.length < 3) prefix.push(byte)
        if (byte === 0) valid = false
        if (prior === 13) endings.add(byte === 10 ? "CRLF" : "CR")
        if (byte === 10 && prior !== 13) endings.add("LF")
        prior = byte
      }
    },
    finish() {
      decode()
      if (!valid || !Number.isSafeInteger(size)) return undefined
      if (prior === 13) endings.add("CR")
      return {
        bytes: size,
        encoding: "UTF-8",
        bom: prefix[0] === 239 && prefix[1] === 187 && prefix[2] === 191,
        endings: endings.size > 1 ? "mixed" : ([...endings][0] ?? "none"),
        newline: prior === 10 || prior === 13,
      }
    },
  }
}
