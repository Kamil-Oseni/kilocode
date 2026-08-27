// raya_change - Milestone H transcription accuracy evidence
export function wordErrorRate(expected: string, actual: string) {
  return rate(words(expected), words(actual))
}

export function characterErrorRate(expected: string, actual: string) {
  return rate(chars(expected), chars(actual))
}

function words(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'-]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function chars(value: string) {
  return [...value.normalize("NFKC").replace(/[\s\p{P}]+/gu, "")]
}

function rate(expected: string[], actual: string[]) {
  if (expected.length === 0) return actual.length === 0 ? 0 : 1
  const row = Array.from({ length: actual.length + 1 }, (_, index) => index)
  for (let i = 1; i <= expected.length; i++) {
    let prior = row[0]!
    row[0] = i
    for (let j = 1; j <= actual.length; j++) {
      const old = row[j]!
      row[j] = expected[i - 1] === actual[j - 1] ? prior : Math.min(prior + 1, row[j - 1]! + 1, old + 1)
      prior = old
    }
  }
  return row[actual.length]! / expected.length
}
