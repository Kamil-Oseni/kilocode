import { expect, test } from "bun:test"
import { kickoff, forward, omits } from "@/kilocode/task/request"

test("budget omission is explicit and preserves requested limits and examples", () => {
  for (const text of [
    "Omit budget and deadline keys for this kickoff.",
    "Omit the budget field.",
    "Do not set any budget for this job.",
    "Don't include a budget.",
  ])
    expect(omits(text)).toBe(true)
  for (const text of [
    undefined,
    "Use a budget of 5.",
    "Do not omit budget.",
    "Never omit budget when the organization requires it.",
    "Don't set a budget above 5.",
    "No budget is available.",
    "> Omit budget\nExplain this example.",
    "```\nOmit budget\n```\nUse a budget of 5.",
  ])
    expect(omits(text)).toBe(false)
})

test("field omission keeps deadline and budget choices separate", () => {
  expect(omits("Omit budget and deadline keys.", "deadline")).toBe(true)
  expect(omits("Omit deadline and budget keys.")).toBe(true)
  expect(omits("Omit the deadline field.", "deadline")).toBe(true)
  expect(omits("Don't include a deadline.", "deadline")).toBe(true)
  expect(omits("Omit budget; use the supplied deadline.", "deadline")).toBe(false)
  expect(omits("Do not omit deadline.", "deadline")).toBe(false)
  expect(omits("```\nOmit deadline\n```", "deadline")).toBe(false)
  expect(omits("> Omit deadline\nExplain this example.", "deadline")).toBe(false)
})

test("handoff criteria recognize affirmative work and preserve explicit prohibitions", () => {
  for (const text of [
    "Call delegate_work with the actual saved file.",
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
    "Run one manual Website Pilot job through our saved Dispatch -> Researcher -> Builder -> Sales team. Start only Researcher; the workers should hand off their own finished files to the next worker.",
    "Run one Website Pilot job through my existing Dispatch → Researcher → Builder → Sales team.",
    "Start this job through the configured Dispatch using the saved workers.",
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
    "Run the build job through our saved command line",
    "Update the existing workers and run one job through our saved Dispatch -> Researcher -> Builder -> Sales team.",
    "Create a new team and run one job through our saved Dispatch → Researcher → Builder → Sales team.",
  ])
    expect(kickoff(request)).toBe(false)
})

test("native saved-team assignment stays affirmative and outside examples", () => {
  const request =
    "Run one manual local Website Pilot job through the saved Dispatch sponsor -> Researcher -> Builder -> Sales. No cloud Task, outreach sends, submissions, publication, purchases, recurring runs or configuration changes.\nInspect the saved team and current revision first. Use native assign_organization_work with a version1 contract, entry research, and exactly three stages: research -> builder -> sales; both next links required=true. Only start Researcher."
  expect(kickoff(request)).toBe(true)
  expect(kickoff("Please use native assign_organization_work with the approved contract.")).toBe(true)
  expect(kickoff("Call native assign_organization_work for the approved first stage.")).toBe(true)
  for (const text of [
    "Do not use native assign_organization_work.",
    "Never call native assign_organization_work.",
    "Explain how to use native assign_organization_work.",
    'Explain the phrase "Use native assign_organization_work".',
    '"Example:\nUse native assign_organization_work with a contract."',
    "`Use native assign_organization_work with a contract.`",
    "```\nUse native assign_organization_work with a contract.\n```\nExplain this example.",
    "> Use native assign_organization_work with a contract.\nExplain this example.",
    "~~~\nUse native assign_organization_work with a contract.\n~~~\nExplain this example.",
    "\u201cExample:\nUse native assign_organization_work with a contract.\u201d",
    "\u2018Example:\nUse native assign_organization_work with a contract.\u2019",
    "Read-only status review. Use native assign_organization_work with a contract.",
    "Do not start workers. Use native assign_organization_work with a contract.",
    "Create new workers. Use native assign_organization_work with a contract.",
  ])
    expect(kickoff(text)).toBe(false)
})
