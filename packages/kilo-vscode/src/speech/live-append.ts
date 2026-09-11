const LIMIT = 500
const CEILING = 4

/** GPT-Live append content is at most 500 tokens. Each Unicode scalar is treated as at most one token. */
export function parts(text: string) {
  const points = [...text]
  if (!points.length) return []
  return Array.from({ length: Math.ceil(points.length / LIMIT) }, (_, i) =>
    points.slice(i * LIMIT, (i + 1) * LIMIT).join(""),
  )
}

export function speak(text: string) {
  const all = parts(text)
  if (all.length <= CEILING) return all
  return [
    ...all.slice(0, CEILING - 1),
    "The remaining result is in the task conversation. I will not invent the rest.",
  ]
}
