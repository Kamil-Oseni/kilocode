// raya_change - Milestone B intelligent auto-routing
import { describe, expect, it } from "bun:test"
import { RayaChief } from "../../src/kilocode/chief"
import data from "./fixtures/chief-routing.json"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

type State = Extract<MessageV2.WithParts["parts"][number], { type: "tool" }>["state"]
const completed = {
  status: "completed",
  input: {},
  output: "The saved worker accepted the request.",
  title: "Worker request",
  metadata: {},
  time: { start: 2, end: 3 },
} satisfies State

function response(tool: string, state: State = completed, parent = MessageID.make("msg_current")): MessageV2.WithParts {
  const session = SessionID.make("ses_routine_reply")
  const message = MessageID.make("msg_routine_result")
  return {
    info: {
      id: message,
      sessionID: session,
      parentID: parent,
      role: "assistant",
      agent: "auto",
      mode: "auto",
      providerID: ProviderV2.ID.make("local"),
      modelID: ModelV2.ID.make("fixture"),
      cost: 0,
      path: { cwd: ".", root: "." },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1 },
    },
    parts: [
      {
        id: PartID.make("prt_routine_result"),
        sessionID: session,
        messageID: message,
        type: "tool",
        callID: "routine-result",
        tool,
        state,
      },
    ],
  }
}

it("releases a reply after a current user's completed Routine operation", () => {
  for (const tool of [
    "schedule_task",
    "inspect_routines",
    "create_organization",
    "update_routine",
    "update_organization",
    "assign_organization_work",
  ])
    expect(RayaChief.settled([response(tool)], "msg_current")).toBe(true)
})

it("does not borrow a settled Routine result from an older user request", () => {
  expect(
    RayaChief.settled([response("assign_organization_work", completed, MessageID.make("msg_old"))], "msg_current"),
  ).toBe(false)
  expect(RayaChief.settled([], "msg_current")).toBe(false)
})

it("does not release a reply while the current Routine operation is unfinished", () => {
  for (const state of [
    { status: "pending", input: {}, raw: "" },
    { status: "running", input: {}, time: { start: 2 } },
  ] satisfies State[])
    expect(RayaChief.settled([response("assign_organization_work", state)], "msg_current")).toBe(false)
})

it("does not treat unrelated completed tools as a settled Routine operation", () => {
  for (const tool of ["read", "chief_route", "task", "get_goal"])
    expect(RayaChief.settled([response(tool)], "msg_current")).toBe(false)
})

it("releases an honest failure reply for the current Routine operation without fabricating success", () => {
  const state = {
    status: "error",
    input: {},
    error: "Organization revision changed; no work was assigned.",
    time: { start: 2, end: 3 },
  } satisfies State
  expect(RayaChief.settled([response("assign_organization_work", state)], "msg_current")).toBe(true)
  expect(state.status).toBe("error")
})

type Fixture = {
  prompt: string
  agent: RayaChief.Role
}

const fixtures = data as Fixture[]

it("keeps tracked-work assignment tools available for explicit saved-worker kickoff requests", () => {
  const tools = {
    chief_route: { id: "route" },
    inspect_routines: { id: "inspect" },
    assign_organization_work: { id: "assign" },
  }
  for (const request of [
    "Start one Website Pilot job through Dispatch: research the three supplied prospects, have Builder make the Eric concept, then Sales save three tailored UNSENT drafts. Use a fresh job folder. Nothing should be sent or published. Verify the actual files and handoffs.",
    "Launch a customer outreach workflow through my saved sales worker.",
    "Delegate this invoice work to the existing accounting team.",
  ]) {
    const available = RayaChief.tools(tools, { [RayaChief.requestKey]: request })
    expect(available.inspect_routines).toBe(tools.inspect_routines)
    expect(available.assign_organization_work).toBe(tools.assign_organization_work)
    expect(available.chief_route).toBeUndefined()
  }
  for (const request of [
    "Build a team dashboard for my workers",
    "Create a team page for our website",
    "Spawn an agent to review this pull request",
    "Run a background task to debug this worker",
    "Start a workflow editor component for my app",
    "Run the test job through the dashboard",
  ])
    expect(RayaChief.tools(tools, { [RayaChief.requestKey]: request })).toEqual({ chief_route: tools.chief_route })
})

it("offers goal creation only after routing without an open goal or absent capability", () => {
  const tools = { create_goal: { id: "create" }, get_goal: { id: "get" } }
  expect(RayaChief.tools(tools, { [RayaChief.phaseKey]: "task" }).create_goal).toBe(tools.create_goal)
  for (const phase of ["route", "verify", "goal", "done"])
    expect(RayaChief.tools(tools, { [RayaChief.phaseKey]: phase }).create_goal).toBeUndefined()
  expect(RayaChief.tools(tools, { [RayaChief.phaseKey]: "task", "raya.goal.open": true }).create_goal).toBeUndefined()
  expect(RayaChief.tools({ get_goal: tools.get_goal }, { [RayaChief.phaseKey]: "task" })).toEqual({
    get_goal: tools.get_goal,
  })
  expect(RayaChief.tools(tools, { [RayaChief.phaseKey]: "verify" })).toEqual({ get_goal: tools.get_goal })
})
const agents: RayaChief.Agent[] = [
  { name: "generalist", description: "Fast generalist for small direct tasks" },
  { name: "coder", description: "Software implementation, fixes, refactors, APIs, and tests" },
  {
    name: "engineer",
    description: "Hard implementation for concurrency, protocols, and correctness-sensitive systems",
  },
  { name: "designer", description: "UI, UX, Figma, layouts, visual systems, and motion" },
  { name: "researcher", description: "Research, sources, documentation, evidence, and benchmarks" },
  { name: "accountant", description: "Ledgers, reconciliation, invoices, statements, tax, and finance" },
  { name: "reasoner", description: "Architecture, algorithms, proofs, security, concurrency, and trade-offs" },
]

describe("Raya Chief routing", () => {
  it(`meets the ${(RayaChief.target * 100).toFixed(0)}% labeled-fixture accuracy target`, () => {
    const decisions = fixtures.map((item) => ({
      expected: item.agent,
      actual: RayaChief.route({ request: item.prompt, agents }).role,
    }))
    const correct = decisions.filter((item) => item.actual === item.expected).length
    const accuracy = correct / decisions.length

    expect(fixtures.length).toBeGreaterThanOrEqual(25)
    expect(new Set(fixtures.map((item) => item.agent))).toEqual(
      new Set(["coder", "engineer", "designer", "researcher", "accountant", "reasoner"]),
    )
    expect(accuracy).toBeGreaterThanOrEqual(RayaChief.target)
  })

  it("adds negligible local policy latency before the measured cheap-model call", () => {
    const started = performance.now()
    for (let index = 0; index < 1_000; index++) {
      const item = fixtures[index % fixtures.length]!
      RayaChief.route({ request: item.prompt, agents })
    }
    const elapsed = performance.now() - started

    expect(elapsed / 1_000).toBeLessThan(0.25)
  })

  it("marks ambiguous requests for an in-chat option prompt instead of guessing", () => {
    const request = "Help me decide what to do with this project"
    const decision = RayaChief.route({ request, agents })

    expect(decision.confidence).toBeLessThan(RayaChief.threshold)
    expect(RayaChief.needsPrompt(decision, RayaChief.threshold, request)).toBe(true)
    expect(decision.candidates.length).toBeGreaterThanOrEqual(2)
    expect(RayaChief.question(decision)).toMatchObject({
      prompt: "Auto found more than one plausible specialist. Who should handle this request?",
      allow_multiple: false,
      options: decision.candidates.map((item) => ({
        id: item.agent,
        label: item.agent,
      })),
    })
  })

  // raya_change - ordinary and spoken conversational turns should not trigger a specialist questionnaire
  it("routes small direct requests to the fast generalist without prompting", () => {
    const request = "Write a one-sentence greeting"
    const decision = RayaChief.route({ request, agents })

    expect(decision.agent).toBe("generalist")
    expect(RayaChief.needsPrompt(decision, RayaChief.threshold, request)).toBe(false)
  })

  it("routes an exact file-facts request without asking about unrelated specialists", () => {
    const request =
      "Read-only check in this dummy workspace: report whether raya-review-fresh-a.txt and raya-review-fresh-b.txt exist, each exact byte length, and whether each ends with a newline. Do not edit any file, change the completed goal, launch apps, or interact with the desktop."
    const available = agents.map((item) => {
      if (item.name === "generalist")
        return {
          ...item,
          description:
            "Fast generalist for small file operations, concise answers, and other direct low-complexity work.",
        }
      if (item.name === "designer")
        return {
          ...item,
          description:
            "Product and interface design specialist for UI, UX, Figma, layouts, visual systems, and motion.",
        }
      if (item.name === "accountant")
        return {
          ...item,
          description:
            "Accounting specialist for ledgers, reconciliation, invoices, statements, tax, and financial analysis.",
        }
      return item
    })
    const decision = RayaChief.route({ request, agents: available })

    expect(decision.agent).toBe("generalist")
    expect(RayaChief.needsPrompt(decision, RayaChief.threshold, request)).toBe(false)
    expect(RayaChief.prompt(available)).toContain("do not launch another existence-only child")
    expect(RayaChief.prompt(available)).toContain("Use file_facts or state uncertainty")
  })

  it("still asks when design and finance are genuinely tied", () => {
    const request = "Create a Figma accounting finance template"
    const decision = RayaChief.route({ request, agents })

    expect(decision.candidates.slice(0, 2).map((item) => item.role)).toEqual(["accountant", "designer"])
    expect(decision.candidates[0]?.score).toBe(decision.candidates[1]?.score)
    expect(RayaChief.needsPrompt(decision, RayaChief.threshold, request)).toBe(true)
  })

  it("marks an explicit parallel review for a saved Chief plan", () => {
    const request =
      "Review two independent things in parallel using read-only specialists: inspect chat timestamps and composer styles."
    expect(RayaChief.route({ request, agents })).toMatchObject({ role: "researcher", needs_plan: true })
    expect(RayaChief.route({ request: "Inspect chat timestamps", agents }).needs_plan).toBe(false)
    expect(RayaChief.prompt(agents)).toContain("do not call chief_inspect, chief_review, or chief_synthesize")
    expect(RayaChief.prompt(agents)).toContain("do not expose internal session IDs, task IDs, branch IDs")
    expect(RayaChief.prompt(agents)).toContain("An English request requires an English reply")
  })

  it("answers only self-contained conversational turns without a child", () => {
    expect(RayaChief.direct("Hi! ")).toBe(true)
    expect(RayaChief.direct("What does idempotency mean? ")).toBe(true)
    expect(RayaChief.direct("Explain the term idempotency.")).toBe(true)
    expect(RayaChief.direct("What does this error mean?")).toBe(false)
    expect(RayaChief.direct("Explain my code")).toBe(false)
    expect(RayaChief.direct("Define a function")).toBe(false)
    expect(RayaChief.direct("Write a greeting in a file")).toBe(false)
    expect(RayaChief.direct("Find the latest invoice")).toBe(false)
  })

  it("keeps bounded greeting restrictions separate from acquisition and actions", () => {
    for (const text of [
      "Hello! Don't save this or take any actions.",
      "Please say hello. Please do not change anything.",
      "Good morning. No tools. No saving.",
      "Respond with a brief greeting. This is only a chat test; do not call any tools.",
      "Reply with one short greeting. This is a temporary conversation check; do not save it as a preference or perform any actions.",
    ]) {
      expect(RayaChief.direct(text)).toBe(true)
      const decision = RayaChief.route({ request: text, agents })
      expect(decision.agent).toBe("generalist")
      expect(RayaChief.needsPrompt(decision, RayaChief.threshold, text)).toBe(false)
    }
    for (const text of [
      "Hello. Read my file.",
      "Hi, then edit the project.",
      "Say hello and turn on the lights.",
      "Reply with a greeting. What is the current weather?",
      "Hello. Search my saved preferences.",
      "Hello. Do not save this, then send an email.",
      "Hello. No tools except search.",
      "Hello. This is a chat test and place an order.",
      `Hello. ${"x".repeat(512)}`,
    ])
      expect(RayaChief.direct(text)).toBe(false)
  })

  // raya_change - regression for a trivial file task previously sent to Designer
  it("sends difficult implementation to Engineer and everyday coding to coder", () => {
    const agentsWithEngineer = agents
    expect(
      RayaChief.route({
        request: "Implement a lock-free concurrent queue",
        agents: agentsWithEngineer,
      }),
    ).toMatchObject({ agent: "engineer", role: "engineer" })
    expect(
      RayaChief.route({
        request: "Fix the authentication bug in this function",
        agents: agentsWithEngineer,
      }),
    ).toMatchObject({ agent: "coder", role: "coder" })
    expect(
      RayaChief.route({
        request: "Evaluate the architecture tradeoffs for a distributed queue",
        agents: agentsWithEngineer,
      }),
    ).toMatchObject({ agent: "reasoner", role: "reasoner" })
  })

  it("routes version-control work to a git-capable specialist", () => {
    for (const request of ["Commit and push all changes", "Push the curriculum branch to origin/main"]) {
      const decision = RayaChief.route({ request, agents })
      expect(decision).toMatchObject({ agent: "coder", role: "coder", needs_plan: false })
      expect(RayaChief.needsPrompt(decision, RayaChief.threshold, request)).toBe(false)
    }
  })

  it("keeps one small temporary file task away from Designer", () => {
    const decision = RayaChief.route({
      request: "Create one temporary test file, explain what you did, then stop.",
      agents,
    })

    expect(decision).toMatchObject({
      agent: "generalist",
      role: "generalist",
      needs_plan: false,
    })
    expect(decision.confidence).toBeGreaterThanOrEqual(RayaChief.threshold)
  })

  it("keeps website redesigns on Designer and listing-only redesign plans on the generalist", () => {
    expect(
      RayaChief.route({
        request: "Redesign this website",
        agents,
      }),
    ).toMatchObject({ agent: "designer", role: "designer" })
    expect(
      RayaChief.route({
        request:
          "This file contains all the pages in the etymon website: SITE_MAP.md I want to redesign the pages and make it modern and neat. I want you to list the order in which i should redesign here in chat. Do not design, just list the order.",
        agents,
      }),
    ).toMatchObject({ agent: "generalist", role: "generalist" })
    expect(
      RayaChief.route({
        request: "Create a responsive Figma mockup for the dashboard",
        agents,
      }),
    ).toMatchObject({ agent: "designer", role: "designer" })
  })

  // raya_change - synthetic persistent-goal policy must not pollute the user's routing intent
  it("classifies only user-authored text when a goal adds synthetic guidance", () => {
    const objective = "Create one text file"
    const request = RayaChief.requestText([
      { type: "text", text: objective },
      {
        type: "text",
        text: "Gather evidence, audit every requirement, inspect the design and research alternatives.",
        synthetic: true,
      },
    ])

    expect(request).toBe(objective)
    expect(RayaChief.route({ request, agents }).agent).toBe("generalist")
    expect(
      RayaChief.requestText(
        [{ type: "text", text: "Synthetic continuation policy", synthetic: true }],
        "Create one text file, then append Hello World",
      ),
    ).toBe("Create one text file, then append Hello World")
  })

  // raya_change - Milestone I configurable routing threshold
  it("applies the configured confidence threshold without code changes", () => {
    const decision = { confidence: 0.8 } as Pick<ReturnType<typeof RayaChief.route>, "confidence">
    expect(RayaChief.needsPrompt(decision, 0.85)).toBe(true)
    expect(RayaChief.needsPrompt(decision, 0.75)).toBe(false)
  })

  // raya_change start - Auto phase enforcement regression
  it("exposes read-only media alongside personal recall without releasing verification tools", () => {
    const tools = {
      chief_route: { id: "chief" },
      second_brain_recall: { id: "notes" },
      second_brain_media_recall: { id: "media" },
      get_goal: { id: "goal" },
      edit: { id: "edit" },
    }
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "route" }))).toEqual([
      "chief_route",
      "second_brain_recall",
      "second_brain_media_recall",
    ])
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "verify" }))).toEqual(["get_goal"])
  })

  it("advertises only Chief until an ordinary fresh request is routed", () => {
    const tools = {
      chief_route: { id: "chief" },
      chief_plan: { id: "plan-branches" },
      chief_inspect: { id: "inspect-branches" },
      chief_review: { id: "review-branch" },
      chief_synthesize: { id: "synthesize-branches" },
      task: { id: "task" },
      get_goal: { id: "get" },
      update_goal: { id: "update" },
      update_goal_plan: { id: "plan" },
      read: { id: "read" },
    }

    const workflow = [
      "chief_route",
      "chief_plan",
      "chief_inspect",
      "chief_review",
      "chief_synthesize",
      "task",
      "get_goal",
      "update_goal",
      "update_goal_plan",
    ]
    const initial = workflow.filter((name) => name !== "task")
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "route" }))).toEqual(["chief_route"])
    expect(Object.keys(RayaChief.tools(tools, undefined))).toEqual(["chief_route"])
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "task" }))).toEqual(workflow)
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "goal" }))).toEqual(workflow)
    expect(Object.keys(RayaChief.tools(tools, { [RayaChief.phaseKey]: "done" }))).toEqual(workflow)
    expect(
      Object.keys(
        RayaChief.tools(tools, {
          [RayaChief.phaseKey]: "task",
          [RayaChief.pendingKey]: { request: "Review two files" },
        }),
      ),
    ).toContain("task")

    // Ordinary fresh requests route first; clarification remains available after routing and
    // during explicit Routines or canvas workflows.
    const rich = {
      ...tools,
      ask_options: { id: "ask" },
      question: { id: "question" },
      create_canvas: { id: "cc" },
      update_canvas: { id: "uc" },
    }
    expect(RayaChief.tools(rich, { [RayaChief.phaseKey]: "route" })).toEqual({ chief_route: tools.chief_route })
    expect(RayaChief.tools({ question: rich.question }, undefined)).toEqual({})
    expect(
      Object.keys(
        RayaChief.tools(rich, { [RayaChief.requestKey]: "Read acceptance.txt and report its exact content" }),
      ),
    ).toEqual(["chief_route"])
    expect(Object.keys(RayaChief.tools(rich, { "raya.canvas.command": false }))).toEqual(["chief_route"])
    for (const phase of ["task", "goal", "done"])
      expect(Object.keys(RayaChief.tools(rich, { [RayaChief.phaseKey]: phase }))).toEqual([
        ...workflow,
        "ask_options",
        "question",
      ])
    expect(Object.keys(RayaChief.tools(rich, { "raya.canvas.command": true }))).toEqual([
      ...initial,
      "ask_options",
      "question",
      "create_canvas",
      "update_canvas",
    ])
    const routines = {
      ...rich,
      schedule_task: { id: "schedule" },
      inspect_routines: { id: "inspect" },
      create_organization: { id: "create" },
      update_routine: { id: "routine" },
      update_organization: { id: "organization" },
      assign_organization_work: { id: "assign" },
    }
    const expected = [
      "schedule_task",
      "inspect_routines",
      "create_organization",
      "update_routine",
      "update_organization",
      "assign_organization_work",
      "ask_options",
      "question",
    ]
    expect(
      Object.keys(
        RayaChief.tools(routines, {
          [RayaChief.requestKey]:
            "Create a small organization for testing persistence. Ask me the required setup questions one at a time before creating anything.",
        }),
      ),
    ).toEqual(expected)
    for (const request of [
      "Create routines for the household",
      "Create organizations for my businesses",
      "Set up a team of specialist workers for research",
      "Build a team to handle my website business",
      "Create agents to help me learn violin",
      "I want an agent to handle invoices when I ask",
    ])
      expect(Object.keys(RayaChief.tools(routines, { [RayaChief.requestKey]: request }))).toEqual(expected)
    expect(
      Object.keys(RayaChief.tools(routines, { [RayaChief.requestKey]: "Build a team dashboard for my workers" })),
    ).toEqual(["chief_route"])
    expect(RayaChief.prompt(agents)).toContain("use the available Routines tools yourself")
    expect(RayaChief.prompt(agents)).toContain("chief_plan")
    expect(RayaChief.prompt(agents)).toContain("background:true")
    expect(RayaChief.routine("Have an accounting agent send me a report every Friday")).toBe(true)
    expect(RayaChief.routine("Create routines for the household")).toBe(true)
    expect(RayaChief.routine("Create organizations for my businesses")).toBe(true)
    expect(RayaChief.routine("Set up a team of specialist workers for research")).toBe(true)
    expect(RayaChief.routine("Build a team to handle my website business")).toBe(true)
    expect(RayaChief.routine("Give these agents a team with clear roles")).toBe(true)
    expect(RayaChief.routine("Create agents to help me learn violin")).toBe(true)
    expect(RayaChief.routine("I want an agent to handle invoices when I ask")).toBe(true)
    expect(RayaChief.routine("Give me a research worker for customer outreach")).toBe(true)
    expect(RayaChief.routine("Build a team dashboard for my workers")).toBe(false)
    expect(RayaChief.routine("Create a team page for our website")).toBe(false)
    expect(RayaChief.routine("Build a team dashboard for my business")).toBe(false)
    expect(RayaChief.routine("Fix this authentication bug")).toBe(false)
    expect(RayaChief.routine("Create an agent dashboard for my app")).toBe(false)
    expect(RayaChief.routine("Add an agent configuration file for the CLI")).toBe(false)
    expect(RayaChief.routine("Spawn an agent to review this pull request")).toBe(false)
    expect(RayaChief.routine("I want an agent to review this pull request")).toBe(false)
    expect(RayaChief.routine("Create an agent to fix this bug")).toBe(false)
    expect(RayaChief.begin({ [RayaChief.phaseKey]: "goal" })).toBe("route")
    expect(RayaChief.begin({ [RayaChief.phaseKey]: "goal" }, true)).toBe("task")
    expect(RayaChief.begin({ [RayaChief.phaseKey]: "route" }, true)).toBe("task")
    expect(RayaChief.begin({ [RayaChief.phaseKey]: "done" }, true)).toBe("task")
    expect(
      RayaChief.continuation({
        [RayaChief.phaseKey]: "task",
        [RayaChief.requestKey]: "Finish the saved objective",
      }),
    ).toBe("Finish the saved objective")
    expect(
      RayaChief.continuation({
        [RayaChief.phaseKey]: "route",
        [RayaChief.requestKey]: "This new request still needs Chief",
      }),
    ).toBeUndefined()
    expect(RayaChief.continuation({ [RayaChief.phaseKey]: "task" })).toBeUndefined()
    const request = "Create three temporary text files"
    const decision = {
      request,
      agent: "generalist",
      role: "generalist" as const,
      model: "test/model",
      needs_plan: false,
      confidence: 0.94,
      reason: "small direct task",
      latency: 1,
      chiefModel: "test/model",
      candidates: [{ agent: "generalist", role: "generalist" as const, score: 1, reason: "small" }],
      prompted: false,
    }
    const current = {
      [RayaChief.phaseKey]: "task",
      [RayaChief.requestKey]: request,
      [RayaChief.logKey]: [decision],
    }
    expect(RayaChief.follow(current)?.agent).toBe("generalist")
    expect(RayaChief.follow({ ...current, [RayaChief.phaseKey]: "goal" })?.agent).toBe("generalist")
    expect(RayaChief.follow({ ...current, [RayaChief.phaseKey]: "route" })).toBeUndefined()
    expect(RayaChief.follow({ ...current, [RayaChief.phaseKey]: "done" })).toBeUndefined()
    expect(RayaChief.follow({ ...current, [RayaChief.requestKey]: "Read these two files" })).toBeUndefined()
    expect(RayaChief.pending({ ...current, [RayaChief.pendingKey]: decision })?.agent).toBe("generalist")
    expect(
      RayaChief.pending({ ...current, [RayaChief.phaseKey]: "route", [RayaChief.pendingKey]: decision }),
    ).toBeUndefined()
    expect(
      RayaChief.pending({ ...current, [RayaChief.requestKey]: "A newer request", [RayaChief.pendingKey]: decision }),
    ).toBeUndefined()
    expect(RayaChief.lastStep).toContain("update_goal")
  })
  // raya_change end
})
