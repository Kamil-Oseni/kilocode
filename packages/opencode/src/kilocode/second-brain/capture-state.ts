/** Only an explicit original saving-control request authorizes changing future capture. */
export function selected(text: string): "pause" | "resume" | undefined {
  const match =
    /^(?:please |(?:Can|Could) you (?:please )?|I (?:want|would like) (?:you )?to )?(pause|resume|stop) (?:automatic (?:(?:personal )?memory |SecondBrain )?saving|(?:automatic )?(?:personal )?memory capture|saving (?:my )?(?:personal )?memory)(?:,? please)?[.!?]?$/i.exec(
      text.trim(),
    )
  if (!match) return undefined
  return match[1].toLowerCase() === "resume" ? "resume" : "pause"
}
