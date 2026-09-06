# Routines

Routines are standing jobs. You assign a named agent a role, a job in plain language, and a time to wake. The agent sleeps until that time, opens its own chat, does the work, and goes back to sleep. That is different from a goal, which lives inside one conversation and keeps going until the work is done or honestly blocked.

Open Routines from the sidebar sync icon. History stays on the rewind-clock icon. The roster is the page. Assign is a separate screen, so the list is not competing with a form. Each row shows the role, the job, when it next runs, and whether it is working, waiting on you, done, or blocked.

Open chat jumps to that agent's latest session. Recent runs are links into those chats as well. Run now starts a session immediately and stays disabled while that run is in flight, so a double click does not spawn extra sessions. Pause stops future wakeups without deleting the assignment. Remove deletes the routine and its run history. Past chats stay in History.

Assign a routine by picking a starter role or choosing Custom and typing a role name. Set a model or leave it as the same model you use in chat. Tools are either all tools including writes, or read-and-notify only. Briefer defaults to notify only. Every other role defaults to full write access and every tool. Accountant jobs still need Money tools checked at assign time. Inbox jobs still need Messages tools checked. Those flags are capability gates, not a limit on the tools a running agent may use.

When is plain English: "every weekday at 6pm", "every morning", "in 2 minutes", "just when I ask", or "every time CI fails on main". A one-shot fires once. A paused routine does not fire. The scheduler ticks about once a minute, skips a routine that is already running, and records cost and outcome on the row. If the same block happens three times in a row, the routine disables itself and leaves a note.

A run that needs a permission or an answer parks as waiting on you until you handle it in the chat. History updates that presence live. The Routines roster refreshes on its own every few seconds, and also when a session status changes, so waiting on you should appear without leaving and coming back.

Structured plans can run in this chat or in the background. Run in background assigns a coder routine, starts it once, and replaces the buttons with a confirmation so the same plan is not launched twice. Point a routine at a markdown plan if you want later runs to follow that checklist.

Restart the extension after installing a snapshot so the sidebar icon and the new assign fields load.
