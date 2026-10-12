/** Use the existing conversation cards for one missing Memory decision at a time. */
export function question(stage: "connect" | "notes" | "index" | "capture", root: string) {
  const folder = root.length > 120 ? `…${root.slice(-119)}` : root
  const choices = {
    connect: {
      prompt: `Connect Raya to your notes in ${folder || "the prepared folder"}? Credentials stay in the secure input.`,
      id: "use_prepared",
      label: "Connect memory",
    },
    notes: {
      prompt: "Choose which notes Raya can read? You can review the selected files before allowing access.",
      id: "choose_notes",
      label: "Choose notes",
    },
    index: {
      prompt: "Index your approved notes so Raya can find relevant memories?",
      id: "index_notes",
      label: "Index notes",
    },
    capture: {
      prompt: "Let Raya save useful conversation details to memory? You can review the saving settings.",
      id: "enable_capture",
      label: "Enable automatic saving",
    },
  }
  const choice = choices[stage]
  return {
    prompt: choice.prompt,
    options: [
      { id: choice.id, label: choice.label },
      { id: "cancel", label: "Not now" },
    ],
  }
}
