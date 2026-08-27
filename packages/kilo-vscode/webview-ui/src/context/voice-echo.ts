// raya_change - Residual echo guard: remove the known spoken reply from the next captured utterance.
export class VoiceEcho {
  private text = ""
  private resume = ""

  set(text: string) {
    this.text = text
    this.resume = ""
  }

  interrupt(seconds: number) {
    const tokens = this.text.trim().split(/\s+/).filter(Boolean)
    const spoken = Math.min(Math.max(0, tokens.length - 1), Math.floor(Math.max(0, seconds - 0.15) * 2.4))
    this.resume = tokens.slice(spoken).join(" ")
  }

  clear() {
    this.text = ""
    this.resume = ""
  }

  take() {
    const text = this.resume
    this.resume = ""
    return text || undefined
  }

  clean(input: string) {
    const spoken = words(this.text)
    const heard = words(input)
    this.text = ""
    if (spoken.length === 0 || heard.length === 0) {
      this.resume = ""
      return input
    }
    const rows = Array.from({ length: heard.length + 1 }, () => new Uint16Array(spoken.length + 1))
    for (let i = 1; i <= heard.length; i++) {
      for (let j = 1; j <= spoken.length; j++) {
        rows[i]![j] =
          heard[i - 1] === spoken[j - 1]
            ? (rows[i - 1]?.[j - 1] ?? 0) + 1
            : Math.max(rows[i - 1]?.[j] ?? 0, rows[i]?.[j - 1] ?? 0)
      }
    }
    const total = rows[heard.length]?.[spoken.length] ?? 0
    if (total / heard.length >= 0.72 && heard.length - total <= 2) return
    const split = heard.reduce((best, _, index) => {
      const size = index + 1
      const matched = rows[size]?.[spoken.length] ?? 0
      const previous = rows[size - 1]?.[spoken.length] ?? 0
      return matched > previous && matched >= 3 && matched / size >= 0.72 ? size : best
    }, 0)
    if (split === 0) {
      this.resume = ""
      return input
    }
    const rest = heard.slice(split)
    if (rest.length > 0) this.resume = ""
    return rest.join(" ").trim() || undefined
  }
}

function words(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
}
