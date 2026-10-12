export type Policy = {
  overlap?: "skip" | "queue"
  missed?: "skip" | "latest"
}

export function summary(value: Policy) {
  return {
    overlap:
      value.overlap === "skip"
        ? "Skip a scheduled occurrence if the previous run is still active."
        : value.overlap === "queue"
          ? "Keep at most one pending scheduled run until the previous run finishes."
          : "Keep the existing handling of overlapping scheduled times.",
    missed:
      value.missed === "skip"
        ? "Skip missed scheduled times."
        : value.missed === "latest"
          ? "Catch up at most one eligible missed occurrence; older times are not replayed."
          : "Keep the existing handling of missed scheduled times.",
  }
}
