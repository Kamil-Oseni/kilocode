import { expect, test } from "bun:test"
import { kickoff, forward } from "@/kilocode/task/request"

test("handoff criteria recognize affirmative work and preserve explicit prohibitions", () => {
  for (const text of [
    "Save research then hand off to Builder.",
    "Verify the accepted delegation and its file receipts.",
    "A successful handoff is required.",
  ])
    expect(forward(text)).toBe(true)
  for (const text of [
    "Do not delegate this question.",
    "No handoff is needed.",
    "Save the research without handing off.",
    "Read the full report.",
  ])
    expect(forward(text)).toBe(false)
})

test("saved job kickoff stays distinct from creating or managing workers", () => {
  expect(
    kickoff(
      "Start one Website Pilot job through Dispatch using the existing saved Researcher, Builder and Sales workers. Have Researcher read D:\\Raya\\Workspaces\\WebsitePilot\\prospects.json and seed-provenance.json: the supplied prospects are Eric's Window Cleaning, Contrast Window Cleaning, and Canada Wide Window Cleaning Inc. Use a fresh folder under D:\\Raya\\Workspaces\\WebsitePilot\\jobs. Researcher should save the research and hand off to Builder; Builder should make the unofficial Eric concept preview and hand off to Sales; Sales should save three tailored UNSENT outreach drafts. Verify actual files and handoffs and report back in this chat. Nothing should be sent, submitted, purchased or published.",
    ),
  ).toBe(true)
  for (const request of [
    "Run a research job via my saved team",
    "Assign this work to Builder",
    "Use my existing team to research three prospects",
    "Have the saved Sales worker prepare an unsent draft",
    "Do not create new workers. Start this job through Dispatch.",
  ])
    expect(kickoff(request)).toBe(true)
  for (const request of [
    undefined,
    "Create a new team of researchers",
    "Update the existing workers",
    "Pause my saved team",
    "Create new workers and start one job through Dispatch",
    "Start a new team dashboard",
    "Explain how saved teams work",
    "Run the build job through the command line",
  ])
    expect(kickoff(request)).toBe(false)
})
