# Raya Voice: Realtime Conversation Architecture

**Status:** Design specification. Not yet implemented.
**Version:** 0.2.1 — internal consistency review applied
**Date:** August 2026
**Supersedes:** Section 11 (Voice Architecture) of `Raya-Technical-Architecture.md`
**Corrects:** Sections 5.3 and 5.4.1 (Vertex AI MaaS open-model catalog) and the per-user cost ceilings in Section 5.7 of `Raya-Technical-Architecture.md`
**Companion artifact:** `docs/models/raya-pricing-model.canvas.tsx` — the live unit-economics and operating model behind Part X
**Audience:** CTO, backend and infrastructure engineering, ML engineering

---

## Preamble: What This Document Is

This document specifies the complete technical architecture for giving Raya a real voice — not a microphone button bolted onto a chat box, but a continuous, interruptible conversation that feels like talking to someone who is listening while you speak.

It is a build specification, not a survey. It names components, defines wire protocols, specifies interfaces at the type level, sets numeric service objectives, allocates the latency budget across every hop, prices the system per voice-minute against a full operating cost base, and sequences the work into phases with staffing. Where a decision is contested, the document states the alternatives, the evidence, and the reason for the choice, so that a future engineer can revisit the decision without re-deriving the analysis.

Three commitments shape everything that follows.

The first is **architectural parity with the best system that exists**. In August 2026 that is OpenAI's GPT-Live, whose engineering team published a detailed account of how they built it. We adopt their central insight wholesale, because it is correct: a responsive voice system is two planes, not one pipeline. We then diverge in the places where our constraints differ from theirs, and Part II states plainly both where we improve on their design and where we simply cannot match it.

The second is **model independence**. We buy our voice model rather than owning it, and the vendor we buy from is currently the best in the world at this and may not be in eighteen months. Every design decision in this document is filtered through one question: does this let us replace the voice model in a configuration change rather than a rewrite? The central artifact of this specification is therefore not a model choice. It is the **Voice Engine Interface** — the contract that makes the model a swappable part. OpenAI's own architecture is welded to a model they own. Ours is not, and that is a durable structural advantage rather than a hedge.

The third is **that Raya is a financial companion, and voice raises the stakes**. Voice is ambient, it is overheard, it is misheard, and it invites action without a screen to check. A voice architecture for a fintech is not the same document as a voice architecture for a general assistant, and the parts of this specification concerning authorization, reversibility, speaker identity, and acoustic privacy are not appendices. They are load-bearing, and they are the substance of what Raya does that a general voice assistant structurally cannot.

### The settled decisions this version encodes

Version 0.1 of this document was written on the assumption that we would self-host an open full-duplex model on Canadian GPUs. Research into compounded realtime pricing, Canadian GPU availability, and the measured intelligence gap in open full-duplex models overturned that assumption. Seven decisions are now settled and the document is written against them.

The production voice engine is the **OpenAI Realtime API running `gpt-realtime-2.1` with native audio output**, on every paid tier without exception. Tiers differ in allowance and in what Raya is permitted to do, never in how good she is.

**Reasoning is delegated to a swappable registry of Chinese open-weight models** consumed through Western inference providers, with DeepSeek V4-Flash as the economy default, MiniMax M2.7 as the standard agentic tier, GLM-5.1 on a zero-retention host for anything carrying financial detail, and DeepSeek V4-Pro for premium off-path work.

**LiveKit Cloud provides the SFU only**, pinned to its `us` region, with our media frontend joining rooms as an ordinary participant rather than as a registered LiveKit Agent.

**Canadian data residency is a roadmap commitment, not a launch blocker.** Launch processes voice in the United States under PIPEDA with explicit disclosure and a documented transfer assessment. Part IX develops the legal analysis and the path to Canadian processing.

**Raya launches with an OpenAI preset voice.** Voice identity is deferred, and Part V specifies the two routes to reclaiming it without rebuilding the system.

**Per-user voice cost is capped in dollars server-side** and presented to the user as minutes. This is what makes a flagship model affordable on a $25 tier.

**Token efficiency is a standing programme with an owner, not a one-off optimisation.** Four mechanisms — the instruction budget, cache discipline, uplink gating and compaction — govern what a voice-minute costs, and the two that carry product risk ship behind quality indicators that can revert them. Section 5.8 sequences the work and states the rule that settles any conflict: the quality indicator wins.

### Relationship to existing Raya documentation

`Raya-Technical-Architecture.md` remains the governing document for the Raya Engine: the orchestrator, context engine, tool registry, memory store, three-tier permission model, and streaming layer. This document does not replace any of that. Voice does not get its own brain. It reuses the entire Raya Engine and adds a real-time plane in front of it.

Three corrections to that document are made here and should be back-ported.

Section 11 specifies a cascaded speech-to-text, language model, text-to-speech pipeline with a semantic turn detector and a two-second end-to-end latency target. That design is sound as an engineering exercise and it is what most of the industry ships, but it structurally cannot produce the experience we want, for reasons developed in Part I. Section 11 is superseded. The cascade survives, but demoted: it becomes one implementation behind the Voice Engine Interface, valuable as a cost floor, a quality baseline, and the bottom of the degradation ladder, rather than as the architecture.

Section 5 routes all model traffic through Google Vertex AI Model Garden's Model-as-a-Service catalog. Google deprecated that entire open-model catalog — every Qwen, DeepSeek, Kimi and MiniMax MaaS model identifier — on 21 July 2026, with retirement on 21 October 2026, and directs customers to self-deployed Model Garden endpoints instead. Separately, none of those endpoints were ever served from a Canadian region. Part VI specifies the replacement registry. This correction is urgent independently of voice, because it affects text Raya today.

Section 5.7 sets per-user monthly cost ceilings of $0.50 for Plus and $2.00 for Pro, which conflict with the daily budgets of $0.75 and $3.00 already implemented in `retention-policy.service.ts`. Neither figure survives contact with voice. Part X replaces both with a single coherent entitlement model.

### How to read this document

Parts I through III are the conceptual core: why the industry-standard design fails, what replaces it, and the interface that makes it durable. An executive reader who reads only these three parts will understand the system and the reasoning behind it.

Parts IV through VII specify the planes in implementation detail — media, inference, delegation, and transcript reconstruction. Parts VIII and IX cover the Raya application layer and the safety architecture, including the three provisions that gate launch. Parts X through XII cover economics, operations, and failure. Parts XIII through XV cover the build sequence, the longer-term research track, and the risk register. The appendices carry wire formats, schemas, the evaluation corpus, and the cost derivation.

Four sections are the ones to argue with, because they carry the decisions everything else inherits: Section 1.6 on why the voice model and the reasoning model must be different models, Section 3.2 on the engine contract, Section 4.6 on barge-in bookkeeping, and Section 10.4 on capping cost in dollars rather than minutes.

---

# Part I: Why Turn-Taking Fails

## 1.1 The shape of the problem

Human conversational handoff is fast and it is anticipatory. Speakers begin planning their response before the other person finishes, and the gap between turns is typically around two hundred milliseconds — frequently less, and sometimes negative, because the turns overlap. This is not a performance detail. It is the mechanism by which conversation feels like conversation rather than like exchanging voice memos.

Every voice AI system built before 2026 inherited its structure from text chat: the user produces a complete message, the system detects that the message is complete, the system produces a complete reply. The audio equivalent of a text message is an audio blob, and the component that decides when the blob has ended is a **turn detector** — a small model, typically a voice-activity detector augmented with some semantic signal, that watches the incoming audio and guesses when the user has finished.

The turn detector sits on the critical path, alone, holding a decision it cannot make well. Nothing downstream can start until it commits. And the decision is genuinely hard, because silence does not mean completion. A speaker pausing to retrieve a number, to breathe, to reconsider a phrasing, or to work out what they actually think produces exactly the same acoustic signature as a speaker who has finished. The detector must therefore choose between two failure modes, and it must choose in advance, as a threshold, for all users and all utterances.

Set the threshold aggressively and the system interrupts people mid-thought. Set it conservatively and every exchange carries a dead pause before the assistant begins. There is no setting that avoids both, because the information required to distinguish the two cases is semantic and often is not present until after the ambiguous silence has already elapsed.

## 1.2 Why this is worse for Raya specifically

The financial conversations Raya exists to have are among the worst cases for turn detection, and this is not a marginal effect.

Money talk is full of retrieval pauses. "I think I spent, uh, maybe four hundred? on the car thing last month." Money talk is full of self-correction, because people revise numbers as they say them. Money talk is emotionally loaded, and emotionally loaded speech is slower, more hesitant, and more punctuated by silence than neutral speech. A user working out loud whether they can afford to leave their job will pause in the middle of sentences, and a system that treats those pauses as turn boundaries will interrupt them at precisely the moments when being interrupted is most damaging.

The existing Raya voice specification acknowledges this obliquely by proposing a semantic turn detector with a rule ladder — two seconds of silence always ends the turn, eight hundred milliseconds plus terminal punctuation ends the turn, and so on. Consider what those constants mean in practice. A user who pauses for two seconds mid-sentence gets cut off. A user who finishes a sentence cleanly waits at least eight hundred milliseconds before Raya even begins to think, and then waits again through transcription finalization, model inference, and speech synthesis. The specification's own end-to-end target of two seconds is an honest accounting of where that ladder leads.

Two seconds is roughly ten times the human conversational gap. It is enough time for a user to assume the connection dropped and start speaking again, which triggers a barge-in, which discards the response that was about to arrive.

## 1.3 The cascade tax

Turn detection is only the first of the serial costs. In a cascaded system the latency budget accumulates through stages that cannot overlap, because each stage requires its predecessor's complete output.

| Stage | Typical cost | Why it cannot be overlapped |
| :--- | :--- | :--- |
| Endpointing decision | 500–2000 ms | Nothing downstream may start until the turn is judged complete |
| Speech recognition finalization | 100–500 ms | Partial transcripts are unstable; the language model needs final text |
| Context assembly and prompt processing | 50–300 ms | Requires the finalized user message |
| Language model time-to-first-token | 200–800 ms | Requires the assembled prompt |
| Speech synthesis time-to-first-audio | 100–300 ms | Requires enough text to form a natural prosodic unit |
| Network and jitter buffer | 50–150 ms | Constant overhead |

Best case, with excellent components throughout, this lands around one second. Realistic case, it lands between 1.5 and 2.5 seconds. And the floor is structural: even if every component became instantaneous, the endpointing wait remains, because the architecture requires a commitment to "the user has stopped" before any work begins.

There is a second cost that does not appear in the latency table and matters more than it looks. The text bottleneck between recognition and the language model destroys everything about the audio that is not words. Hesitation, emphasis, pace, breathiness, rising uncertainty, the audible difference between "I'm fine" said flatly and "I'm fine" said thinly — all of it is discarded at the transcript boundary and cannot be recovered downstream. For a companion whose entire product thesis is attentiveness, throwing away the paralinguistic channel is not a technical compromise. It is a product failure that no amount of prompt engineering repairs.

## 1.4 What a native speech-to-speech model changes

A native speech-to-speech model removes both costs at once, because it removes the boundary that creates them.

Audio enters the model directly as audio. There is no transcript in the middle, so nothing is discarded at a text boundary — the model hears the hesitation, the rise in pitch, the thinness in the voice, and conditions its response on all of it. Audio leaves the model directly as audio, so there is no synthesis stage waiting for enough text to form a prosodic unit. And because the model is already consuming the user's speech as it arrives rather than waiting for a blob to be handed to it, there is no prefill to pay at turn end. The endpointing wait collapses from a serial stage into a decision the model makes while it is already primed to respond.

This is what makes the OpenAI Realtime API feel different in kind rather than in degree. It is not a faster cascade. It is a different shape, and the shape is what produces the experience.

Two honest qualifications. First, the model is not *fully* duplex in the research sense. It does not model two continuous channels and emit on its own channel while the user is speaking, so it cannot backchannel with "mm-hm" mid-sentence the way a person does. What it has instead is server-side semantic endpointing plus native interruption, which covers the overwhelming majority of the practical benefit. Section 3.6 keeps a true full-duplex engine specified behind the interface so that when the open frontier catches up, adopting it is a configuration change.

Second, interruption is only correct if the bookkeeping is correct, and this is the detail most integrations get wrong. When the user barges in, the model has already generated and streamed audio that the user never heard, because it was still sitting in a jitter buffer or a playout queue. If the model's context believes it said that audio, every subsequent turn is grounded in a false premise, and the conversation quietly desynchronizes from reality. The Realtime API exposes `conversation.item.truncate` precisely to correct this: we tell the model how many milliseconds of its own output the user actually heard, and it discards the rest from its context. Part IV specifies the accounting that makes that number accurate, and the conformance suite in Section 3.8 tests it. This is non-negotiable and it is treated as a first-class correctness property throughout the document, not as an integration detail.

## 1.5 Why the voice model still cannot be the whole system

A native speech-to-speech model solves the interaction problem. It does not solve the intelligence problem, and for Raya the intelligence problem is the product.

This holds for every option on the table, in different ways. The open full-duplex models are dramatically weaker reasoners than text models of comparable size, and the gap is measured rather than suspected: Moshi loses 12.7% on LlamaQ after full-duplex alignment relative to its own pre-alignment baseline, and the Lychee-FD authors trace the mechanism through layer-wise gradient analysis, showing that text and speech gradients turn from synergistic in shallow layers to actively conflicting in deep ones. The most telling evidence is behavioural rather than numerical. Kyutai, who built Moshi and therefore understand full-duplex better than anyone outside the frontier labs, subsequently shipped a cascaded system explicitly because Moshi "doesn't yet match the extended abilities of text models such as function-calling, stronger reasoning, and in-context learning."

OpenAI's realtime model is far stronger than any of those, but it is still not a frontier reasoner, and more importantly it knows nothing whatsoever about the user's money. It has never seen a Plaid transaction history, it does not hold Raya's memory of what this person said three weeks ago, it cannot evaluate whether a proposed action crosses the investment-advice boundary, and it has no access to the plan objects the user is actually trying to change. Asking it to reason directly over financial state would mean stuffing that state into a realtime context window that bills audio and text together at every turn — expensive, slow, and fragile in exactly the way that produces confidently wrong numbers.

So the voice model's job is not to be smart about money. Its job is to be present, to be fast, to sound like Raya, and to know when to ask for help.

## 1.6 The resolution

The tension between interaction quality and intelligence is real, and it is exactly the tension OpenAI resolved by refusing to pick. GPT-Live-1 handles the conversational surface. When something needs genuine reasoning or tool use, it delegates asynchronously to a frontier text model, off the media path, while continuing to talk.

We adopt the same resolution with different parts. The realtime model owns timing, turn-taking, interruption, prosody, and the immediate conversational surface — the things it is genuinely better at than any pipeline we could assemble. Everything requiring reasoning, financial grounding, tool execution, memory formation, or policy compliance is delegated to a text model that never touches the audio path, and which we choose for cost and capability independently of the voice model.

The economics of that split happen to be very good for us. Our delegate costs roughly a twentieth of a cent per voice-minute, because the conversational prefix is cached at $0.028 per million tokens and only the delta is billed fresh. OpenAI pays frontier prices for the equivalent hop. This is the one place in the architecture where our position is straightforwardly better than theirs, and Part VI spends it: delegation that cheap can be *speculative*, fired on a hint rather than a commitment, so that the answer is frequently already in hand by the time the model needs it.

This is the single most important structural decision in the document, and everything in Parts II through VII is an elaboration of it.

---

# Part II: System Overview — The Two-Plane Architecture

## 2.1 The governing principle

**The voice must flow.** Every component, every protocol choice, every deployment decision in this specification is subordinate to a single invariant: audio frames move between the user and the voice model on a fixed schedule, and nothing is permitted to interrupt that schedule.

This is stronger than a performance goal. It is an architectural constraint that determines what code is allowed to exist in which process. A request-response system can tolerate variance; a slow response is merely a slow response. A live media system cannot. A frame that arrives two hundred milliseconds late is not a slow frame, it is an audible artifact — a gap, a click, a stretch. The user hears the architecture failing.

The practical expression of the invariant is a boundary. The system has a **real-time plane** and an **asynchronous plane**, and the rule is absolute: no operation whose latency we do not control may execute on the real-time plane.

## 2.2 The two planes

The **real-time plane** carries user audio inbound and assistant audio outbound. It contains exactly three things: the transport from client to media edge, the media frontend that handles frames and session state, and the voice engine that performs inference. Its work is bounded, predictable, and measured in single-digit milliseconds per frame. It performs no database queries, no HTTP calls to business services, no tool execution, no policy evaluation, and no blocking input or output of any kind.

The **asynchronous plane** carries everything else: delegation to the reasoning model, tool execution, context assembly, memory retrieval and formation, transcript persistence, permission checks, analytics, and billing. It communicates with the real-time plane exclusively through a non-blocking boundary with explicit deadlines. Work on this plane can be slow, can fail, and can be retried. When it is slow, it delays its own result and nothing else. When it fails, the conversation continues; Raya simply says she could not get to it.

There is one subtlety worth stating explicitly, because buying the voice engine rather than hosting it changes where the boundary bites. The inference itself now happens across a WebSocket to a vendor whose latency we do not control. That does not violate the invariant — it relocates the risk. The real-time plane's obligation is not that inference is fast; it is that the *frame schedule* never stalls waiting for anything. The media frontend therefore treats the engine socket as a producer that may be late, maintains its own output clock, and emits silence on schedule when the engine has nothing to give. Part IV specifies the jitter absorption and the underrun policy that make this hold.

Everything that follows can be checked against one question: which plane does this run on, and does it respect the boundary?

## 2.3 Component topology

```
                       REAL-TIME PLANE  (fixed schedule, no blocking I/O)
   ┌────────────────────────────────────────────────────────────────────────────────┐
   │                                                                                │
   │   ┌────────────┐      WebRTC        ┌──────────────┐                           │
   │   │  Clients   │◄─── Opus 20 ms ───►│  LiveKit SFU │                           │
   │   │            │      (SRTP)        │  Cloud, `us` │                           │
   │   │ Web · iOS  │                    │  SFU only —  │                           │
   │   │ Android    │                    │  not Agents  │                           │
   │   │ Desktop    │                    └──────┬───────┘                           │
   │   │ SIP/PSTN   │                           │ Opus / PCM                        │
   │   └────────────┘                           ▼                                   │
   │                        ┌────────────────────────────────────┐                  │
   │                        │        MEDIA FRONTEND              │                  │
   │                        │        raya-mf  (Go)               │                  │
   │                        │        Cloud Run, CPU always on    │                  │
   │                        │                                    │                  │
   │                        │  · frame clock and jitter absorb   │                  │
   │                        │  · playout accounting (truncate)   │                  │
   │                        │  · session state, engine lifecycle │                  │
   │                        │  · Voice Engine Interface          │                  │
   │                        │  · barge-in control                │                  │
   │                        └───┬────────────▲──────────┬────────┘                  │
   │                            │ PCM        │ PCM      │ 1 s window (lossy)        │
   │                            ▼            │          ▼                           │
   │              ┌──────────────────────┐   │    ┌──────────────────┐              │
   │              │    VOICE ENGINE      │   │    │ PROSODY SIDECAR  │              │
   │              │  OpenAI Realtime API │───┘    │  affect + energy │              │
   │              │  gpt-realtime-2.1    │        │  own Cloud Run   │              │
   │              │  (swappable)         │        └────────┬─────────┘              │
   │              └──────────────────────┘                 │                        │
   └────────────────────────────────┬────────────────────── ┼───────────────────────┘
                                    │                      │
                    ══ async boundary (deadline-bounded, cancellable, lossy-tolerant) ══
                                    │                      │
   ┌────────────────────────────────┼──────────────────────┼───────────────────────┐
   │                                ▼                      ▼                       │
   │                     ┌────────────────────────────────────┐                    │
   │                     │        APPLICATION SERVER          │                    │
   │                     │        raya-api  (NestJS)          │                    │
   │                     │        Cloud Run — existing        │                    │
   │                     │                                    │                    │
   │                     │  · Raya Orchestrator               │                    │
   │                     │  · Context Engine                  │                    │
   │                     │  · Tool Registry                   │                    │
   │                     │  · Permission Gate + Undo Ledger   │                    │
   │                     │  · Turn Reconstructor              │                    │
   │                     │  · Memory Store                    │                    │
   │                     │  · Voice Entitlement + Spend Cap   │                    │
   │                     └──┬───────────┬───────────┬─────────┘                    │
   │                        │           │           │                              │
   │         ┌──────────────┘           │           └───────────────┐              │
   │         ▼                          ▼                           ▼              │
   │  ┌────────────────┐      ┌──────────────────┐        ┌──────────────────┐     │
   │  │   REASONING    │      │      TOOLS       │        │   PERSISTENCE    │     │
   │  │    DELEGATE    │      │  Plaid · Plans   │        │ Postgres · Redis │     │
   │  │ swappable reg. │      │  Goals · Search  │        │ Vector · Audit   │     │
   │  │ Fireworks ·    │      │  Calculators     │        │                  │     │
   │  │ DeepInfra ·    │      └──────────────────┘        └──────────────────┘     │
   │  │ Azure Foundry  │                                                            │
   │  └────────────────┘                                                            │
   │                                                                                │
   └────────────────────────── ASYNCHRONOUS PLANE ──────────────────────────────────┘
```

## 2.4 Component responsibilities

**Clients** capture microphone audio, perform acoustic echo cancellation, run on-device wake-word detection where the tier permits it, publish an Opus track over WebRTC, subscribe to the assistant's audio track, and render the conversation from the speculative transcript feed. The client is deliberately thin on logic. It does not decide when a turn ends, it does not decide when to interrupt, and it does not hold conversation state. It does, however, report playout position, because that number is an input to barge-in bookkeeping. Detailed in Part IV.

**LiveKit SFU** terminates WebRTC at the edge, handles ICE, DTLS, SRTP, congestion control, packet loss concealment and jitter, bridges SIP and PSTN into the same room abstraction, and forwards media to the media frontend. Using a managed SFU rather than terminating WebRTC ourselves is the single largest scope reduction available to this project. Section 2.8 explains why we use it as an SFU and not as an agent platform, which is a cost decision with a twentyfold impact.

**Media Frontend (`raya-mf`)** is the heart of the real-time plane and the one wholly new service on the hot path. Written in Go, one goroutine set per session, it maintains the frame clock, decodes and resamples audio, drives the Voice Engine Interface, tracks exactly how much assistant audio the user actually heard, enforces barge-in and issues truncation, forks the input track to the prosody sidecar, mirrors control events to the application server, and manages engine lifecycle including snapshot, handoff and compaction cutover. Detailed in Parts IV and V.

**Voice Engine** is the swappable inference component. In production it is the OpenAI Realtime API; behind the same interface sit a cascade, an Azure-hosted variant, an open full-duplex research engine, and a benchmark harness. It is defined entirely by the contract in Part III and by nothing else. Detailed in Part V.

**Prosody Sidecar** is a small CPU model that consumes a fork of the user's input track and emits energy, pitch, speech-rate, hesitation and affect estimates. It exists because the Realtime API does not expose the paralinguistic signal — the model perceives it internally but does not surface it to us — and the delegation payload is materially better with it than without. It is entirely off the critical path: if it stalls or dies, the conversation is unaffected and prosody fields simply report unknown. Detailed in Part V.

**Application Server (`raya-api`)** is the existing NestJS service on Cloud Run. It receives delegation requests, runs the Raya Orchestrator with full context assembly and tool execution, returns results and speaking guidance, reconstructs discrete turns from continuous speech, enforces the permission gate, maintains the undo ledger, meters voice spend against the per-user ceiling, and persists the conversation. It gains new modules but does not change deployment shape, and critically, it never sees an audio frame. Detailed in Parts VI, VII, VIII and X.

**Reasoning Delegate** is a registry of text models consumed through Western inference providers, selected per request by intent, with the conversational prefix held in the provider's prompt cache so that each call bills only the delta. Detailed in Part VI.

## 2.5 The boundary invariants

These are the rules that make the architecture work. They should be enforced in code review, in continuous integration, and in runtime assertions — not left as intentions.

1. **No blocking input or output on the media path.** `raya-mf` performs no synchronous database access, no HTTP call awaiting a business response, and no unbounded channel send on any code path reachable from frame handling. Every outbound interaction with the application server is fire-and-forget or deadline-bounded with a defined behaviour on expiry.

2. **The output clock is owned by the media frontend, not by the engine.** A frame is emitted every period regardless of whether the engine produced one. Engine underrun produces silence and a telemetry event, never a stall.

3. **Delegation is cancellable and always has a deadline.** Every delegation carries an explicit deadline. Expiry produces a defined conversational outcome, never a hang. A superseded delegation — the user moved on — is cancelled, and its cost is recorded as waste so the speculation rate can be tuned against real numbers.

4. **The application server is never in the audio path.** It receives events describing audio and returns text and structured directives. It never receives, produces, or forwards audio frames. This is what keeps it a stateless, autoscaling, scale-to-zero service.

5. **Playout accounting is authoritative for truncation.** The number of milliseconds reported to the engine on interruption is derived from measured playout, never estimated from generation time. An architecture that guesses here will drift, and the drift is invisible until a user is told something they never heard.

6. **Session state lives in exactly two places, plus one recovery buffer.** Ephemeral real-time state — engine handle, frame clock, playout cursor — lives in the media frontend and dies with it. Durable state — transcript, memories, actions, audit, spend — lives in Postgres, written asynchronously. The one permitted intermediate is the rolling recovery snapshot in Redis described in Section 4.9, which is write-only from the media frontend, read only on reconnect, and expires on a short timer. It is a buffer rather than a source of truth, and nothing on the hot path ever reads it. There is no other location and no shared mutable state between planes.

7. **Every mutating action passes the permission gate on the asynchronous plane.** The voice model can request an action. It cannot perform one. No exceptions, no fast paths, no "read-only enough" shortcuts.

8. **Every voice-minute is metered against a per-user ceiling before it is spent.** Admission control and mid-session enforcement both read the same ceiling. An architecture in which cost is discovered at the end of the month is not a controlled architecture.

9. **The engine is addressed only through the Voice Engine Interface.** No component outside the engine adapter may contain model-specific or vendor-specific logic. If supporting a new engine requires editing `raya-mf` outside its adapter package, the interface is wrong and gets fixed rather than bypassed.

## 2.6 Life of a conversation

The following walkthrough is normative; the numbered stages are referenced by later parts.

**Session establishment.** The client requests a session from `raya-api`, which authenticates the user, checks tier entitlement and remaining voice spend against the ceiling, selects an engine profile by policy, mints a LiveKit token scoped to a single room, mints a short-lived ephemeral credential for the Realtime API, and returns connection parameters. Concurrently and without blocking the client, it warms the reasoning delegate by issuing a priming call that establishes the cached prefix — system prompt, user memories, active goals, plan titles, grounded financial summary — so that the first real delegation pays cache-hit pricing and cache-warm latency rather than cold prefill. The client connects to LiveKit and publishes its track. `raya-mf` is dispatched to the room, opens the engine session, and starts the frame clock. Target: **first audio frame processed within 800 ms of the user's tap**, budgeted hop by hop in Part IV.

**Steady state.** Every twenty milliseconds the client emits an Opus frame. LiveKit forwards it. `raya-mf` decodes, resamples, forks a copy to the prosody sidecar, and hands the frame to the engine on schedule. The engine consumes user audio continuously and emits assistant audio when it is speaking. `raya-mf` publishes emitted audio back through LiveKit and advances the playout cursor as frames are actually delivered. In parallel and off the hot path, control events — partial transcript, speech boundaries, prosody samples, delegation intent — are mirrored to `raya-api`.

**Barge-in.** The engine reports user speech onset during its own output. `raya-mf` immediately stops publishing queued assistant audio, computes how many milliseconds of the current assistant utterance actually reached the user's ears from the playout cursor, issues truncation to the engine with that exact figure, publishes a discontinuity marker, and notifies `raya-api` so the transcript reconstructor marks the assistant message truncated at the same offset. Target: **Raya becomes inaudible to the user within 100 ms of speech onset, and the engine's context is corrected within one frame period of that**.

**Delegation.** The engine signals that it needs help, either by calling a registered function or by the orchestrator inferring the need from the transcript stream. `raya-mf` forwards the request with the recent conversational window and the current prosodic annotation. Meanwhile the voice model keeps the exchange alive under the narration ladder in Part VI. `raya-api` runs the orchestrator — context assembly, tool calls, permission gate — and returns a compact result plus speaking guidance, which `raya-mf` injects into the engine's context. Target: **useful content returned within 1.2 s at p50 and 2.5 s at p95**, with the narration ladder covering the remainder and speculative delegation frequently making the wait zero.

**Compaction and handoff.** Realtime sessions have a hard duration ceiling and a context ceiling, so handoff is a requirement rather than an optimization. As either limit approaches, the system opens a replacement session, prefills it with a compacted semantic snapshot, and cuts over between frames. The user hears nothing. Compaction is also a memory-formation event: the summarization pass writes durable structured memories into Raya's memory store rather than discarding them, which is a direct improvement on the summarize-and-discard approach OpenAI describes. Detailed in Part V.

**Termination.** On hangup, timeout, or ceiling exhaustion, `raya-mf` drains the engine, closes the session, and flushes final events. `raya-api` finalizes the authoritative transcript, commits pending memories, closes the billing record, decrements the spend ledger, and writes the session audit entry.

## 2.7 Deployment topology

| Component | Platform | Region at launch | Scaling unit | Statefulness |
| :--- | :--- | :--- | :--- | :--- |
| Clients | Web, iOS, Android, desktop, SIP | — | — | Session-local |
| SFU | LiveKit Cloud, region-pinned `us` | US | Managed | Per-room |
| `raya-mf` | Cloud Run, CPU always allocated | `us-central1` | Concurrent sessions | Session-affine, ephemeral |
| Prosody sidecar | Cloud Run, separate service | `us-central1` | Analysis windows per second | Stateless per window |
| Voice engine | OpenAI Realtime API | US | Vendor-managed | Vendor session |
| `raya-api` | Cloud Run (existing) | `us-central1` | Requests | Stateless |
| Reasoning delegate | Fireworks / DeepInfra / Azure AI Foundry | US | Requests | Prefix-cache affine |
| Postgres / Redis | Cloud SQL / Memorystore | `us-central1` | — | Durable |

Three observations about this table drive Part IV and the risk register.

The media frontend can live on Cloud Run *because* we no longer colocate inference. Version 0.1 of this document placed it on GKE alongside GPUs, which was correct when the model was ours to host and is now unnecessary complexity. Cloud Run with CPU always allocated and a session-dispatch worker pattern hosts long-lived WebRTC participants perfectly well, at a fraction of the operational burden of a GKE node pool. The one real constraint is Cloud Run's sixty-minute ceiling on a single request, which means a session exceeding an hour must hand off to a fresh instance. Since Realtime API sessions have their own duration ceiling and we are building handoff regardless, this constraint costs us nothing we were not already paying.

**LiveKit Cloud has no Canadian region.** Region pinning supports `us`, `eu`, `asia`, `india`, `me`, `africa`, `aus`, `il`, `sa` and `uk`, and agent deployment is narrower still at `us-east`, `eu-central` and `ap-south` only. Canada appears in LiveKit's documentation solely in the static-IP firewall table, which is a network artifact rather than a residency guarantee. Combined with the Realtime API being US-served, this settles the launch residency posture: voice is processed in the United States, and Part IX develops the PIPEDA analysis, the Law 25 transfer assessment, and the disclosure language that makes that lawful and honest rather than merely convenient.

The delegate is deliberately spread across three providers. That is not indecision; it is the mechanism that keeps the registry in Part VI real. A registry with one provider in it is a dependency wearing a registry's clothing.

## 2.8 Two structural infrastructure decisions

Two decisions in the deployment shape have disproportionate cost consequences, and both should be made deliberately at the start rather than discovered later.

**Replace the Serverless VPC connector with Direct VPC egress.** The existing backend reaches private resources through a Serverless VPC Access connector, which is billed as underlying Compute Engine instances that run continuously at a minimum instance count whether or not any traffic flows. Google's own comparison documents Direct VPC egress as lower latency, higher throughput, faster to scale, and carrying no VM charge at all — you pay egress at the same rate and nothing else. For a service that will now hold long-lived media sessions, the latency argument matters as much as the cost one. This change is independent of voice and should be made regardless.

**Keep the media frontend as our own process joining the room as an ordinary participant, not as a registered LiveKit Agent.** LiveKit meters agent sessions at one cent per minute and ordinary participant minutes at five hundredths of a cent — a twentyfold difference for functionally identical media handling. At a thousand subscribers on the usage assumptions in Part X, that is roughly nine hundred dollars a month against roughly sixty-six. The Agents framework buys job dispatch, worker registration and a Python-first developer experience, none of which we need: our media frontend is Go, its dispatch is a Redis-backed worker pool we control, and its lifecycle is bound to Cloud Run rather than to LiveKit's scheduler. We therefore use LiveKit strictly as an SFU — the thing it is uniquely good at and the thing we genuinely cannot build — and keep the agent process on our own infrastructure. This also has the pleasant side effect of making the eventual move to a self-hosted or Canadian SFU a transport swap rather than a rewrite.

## 2.9 What we take from OpenAI, where we improve, and where we cannot compete

Honesty in this table is worth more than advocacy. A CTO reading it should be able to see exactly which claims are structural and which are aspirational.

### Adopted unchanged

| Design element | Why |
| :--- | :--- |
| Two-plane separation | The central insight, and it is correct |
| Media frontend in Go | Their published result was that Go's p95 matched their previous Python p50 |
| Asynchronous delegation off the media path | The only way to have both responsiveness and intelligence |
| Stateful session lifecycle with warm handoff | Required by session ceilings, and the substrate for compaction |
| Dual transcript views, speculative and authoritative | Correct separation of what the user sees from what the system commits |
| Shadow traffic for production validation | Their post identifies the observability gaps; we design them out from the start |

### Where our design is better

| Design element | GPT-Live | Raya Voice | Why it is a real advantage |
| :--- | :--- | :--- | :--- |
| Model coupling | Welded to a model they own | Interface-defined, swappable by database write | Their architecture cannot outlive their model. Ours can move to Azure, to an open full-duplex model, or to a Canadian host without a rewrite |
| Financial grounding | None | Plaid-sourced balances, transactions and liabilities behind every answer | This is the product. A general assistant cannot see the user's money and never will |
| Memory on compaction | Summarize and discard | Summarize into durable structured memory | Raya already has a memory system; compaction becomes productive rather than lossy, and the memory survives the session |
| Action capability | Cannot mutate the user's world | Full tool catalog behind a permission gate with an undo ledger | Creating a goal, adjusting a plan, or moving a milestone by voice, reversibly, is a capability they structurally do not have |
| Delegation economics | Frontier pricing per hop | ~$0.0005 per voice-minute on cached prefixes | Two orders of magnitude cheaper, which is what makes speculative delegation affordable |
| Delegation trigger | Reactive on request | Reactive plus speculative on hint | Because the delegate is nearly free, we can start the work before the model asks and frequently have the answer waiting |
| Reasoning tier | One frontier model | Registry routed by intent across economy, standard and premium | Cheap questions do not pay premium prices, and the premium tier is available when the question deserves it |
| Delegation payload | Text | Text plus paralinguistic annotation from the prosody sidecar | We recover the affective channel the vendor perceives but does not expose |
| Narration during delegation | "briefly keep the exchange moving" | Specified latency-adaptive ladder | Underspecified in their account, and it is a product surface rather than an implementation detail |
| Cross-surface continuity | Voice is its own surface | Voice and text share one thread, one memory, one set of plan objects | A conversation started by voice continues by typing against the same state |
| Authorization | Not applicable | Four-tier gate with voice-specific confirmation and speaker verification | We are a fintech and they are not; this is a requirement, not a feature |
| Auditability | Not discussed | Every action carries a permission decision, an audit entry and a reversal path | Table stakes for financial software |
| Capacity model | Concurrent sessions | Concurrent sessions and a per-user dollar ceiling | We do not have their balance sheet, so cost control is an architectural component rather than a finance report |

### Where we cannot compete, and accept it

| Design element | GPT-Live | Raya Voice | Consequence |
| :--- | :--- | :--- | :--- |
| Model-internal control | Own the model; control stateful inference, compaction internals, warm handoff at the KV-cache level | Vendor-controlled | Our handoff is semantic rather than acoustic: a snapshot reconstitutes the conversation's meaning, not its exact internal state |
| Latency floor | Colocated inference, own transport stack | Public API plus a network hop | We pay tens of milliseconds we cannot recover. Part IV budgets it honestly |
| Transport optimization | WARP and Instant Connect | Standard WebRTC over a managed SFU | Deferred to Phase 4 at the earliest; the drafts are individual and partly expired |
| Voice identity | Own the voices | OpenAI preset at launch | Raya will not have a distinctive voice in v1. Part V specifies two routes to reclaiming it |
| True full-duplex behaviour | Native | Semantic endpointing plus native interruption | No mid-sentence backchannelling. Section 3.6 keeps the door open |
| Data residency | Not our concern | US processing at launch | Requires disclosure, a transfer assessment, and a stated roadmap. Part IX |

The honest summary is that we are not building a better voice model, and the document should not pretend otherwise. We are building a better *financial companion that speaks*. The comparison that matters is not Raya against GPT-Live; it is Raya against a general assistant that cannot see your bank account, cannot change your plan, and forgets you between conversations.

---

# Part III: The Voice Engine Interface

## 3.1 Why this is the center of the document

If this specification gets one thing right, it should be this part.

We are about to build a system whose most important component we do not own, cannot inspect, cannot fix, and cannot price. That is an entirely reasonable trade in August 2026 — the OpenAI Realtime API is meaningfully the best thing available and building an equivalent is not a rational use of our engineering — but it is only reasonable if the dependency is *contained*. A codebase in which `openai` appears in three hundred files has made a permanent decision. A codebase in which it appears in one adapter package has made a reversible one.

The landscape justifies the caution. The open full-duplex frontier is moving on a scale of weeks: the strongest architecture is Lychee-FD, an ACL 2026 Outstanding Paper from HIT-Shenzhen and Tencent PCG under Apache 2.0, which beats prior state of the art by 28.5% on FullDuplexBench 1.5 and is a university artifact with no production hardening. The most reusable conversion recipe is BayLing-Duplex, which turns an ordinary autoregressive model full-duplex with four added tokens and 400K samples. The strongest Chinese omni models of 2026 are API-only with no weights released. Azure hosts the same OpenAI realtime models in regions OpenAI does not offer directly, with custom voice support OpenAI does not offer at all. Any of these could become the right answer inside a year.

So we do not choose once. We define the contract, we implement it several times, and we select at runtime by policy.

The interface must satisfy four requirements simultaneously, and the tension between them is what makes it interesting. It must be **narrow enough** that a new engine is a week of work rather than a quarter. It must be **expressive enough** to carry native speech-to-speech semantics that a cascade does not have, without forcing the cascade to fake them. It must **not leak** — no vendor-specific or model-specific concept anywhere in its vocabulary. And it must support **stateful lifecycle** operations, because snapshot, prefill and cutover are the mechanism behind compaction, session-ceiling handoff, and failure recovery alike.

## 3.2 The contract

The interface is defined in Go, in `raya-mf`, because the media frontend is the only component that talks to engines.

```go
package engine

// Engine is a stateless factory. Implementations are registered at startup
// and selected per session by policy. One Engine may vend many Sessions.
type Engine interface {
    // Descriptor reports static capabilities. Never varies for a given build.
    Descriptor() Descriptor

    // Open acquires inference capacity and returns a live Session.
    // Must honour the context deadline; a slow Open is a failed Open.
    Open(ctx context.Context, cfg SessionConfig) (Session, error)

    // Health reports readiness for admission control and draining.
    Health(ctx context.Context) HealthReport
}

// Session is one live conversation bound to one inference context.
// All methods are safe for concurrent use. No method may block longer
// than the frame period except Snapshot, Prefill and Close.
type Session interface {
    // ---- Real-time plane: must never block ----

    // PushAudio submits exactly one frame of user audio on the wall clock.
    // Frames arrive on a fixed cadence (default 20 ms). Implementations
    // must accept every frame; internal drop policy is the engine's choice
    // but must be reported via Stats.
    PushAudio(frame AudioFrame) error

    // Audio yields assistant audio frames. The channel produces at the
    // frame cadence, emitting silence frames when the model is not
    // speaking, so the consumer's clock never starves. Engines backed by
    // a network socket absorb jitter internally and underrun into silence
    // rather than stalling.
    Audio() <-chan AudioFrame

    // Events yields control-plane signals: transcripts, speech boundaries,
    // prosody, delegation intent, engine diagnostics. Buffered; the engine
    // drops the oldest event rather than blocking if the consumer stalls.
    Events() <-chan Event

    // Interrupt forces immediate cessation of assistant speech and corrects
    // the engine's belief about what the user heard. heardMillis is the
    // measured playout duration of the interrupted utterance, not an
    // estimate derived from generation time. Idempotent.
    Interrupt(reason InterruptReason, heardMillis int) error

    // ---- Async plane: may block, always deadline-bounded ----

    // Inject inserts out-of-band content into the model's context without
    // producing audio: delegation results, tool outputs, speaking guidance,
    // policy directives. This is the sole channel by which the asynchronous
    // plane influences the conversation.
    Inject(ctx context.Context, item ContextItem) error

    // Snapshot produces a portable, engine-agnostic representation of the
    // conversation sufficient to reconstitute state on another instance or
    // another engine entirely. Runs concurrently with live inference and
    // must not perturb it. See §3.3 on semantic vs acoustic fidelity.
    Snapshot(ctx context.Context, opts SnapshotOptions) (*Snapshot, error)

    // Prefill loads a Snapshot into a freshly opened Session and returns
    // when the session is ready to receive audio. Used for handoff,
    // compaction cutover, session-ceiling rollover, and reconnect recovery.
    Prefill(ctx context.Context, snap *Snapshot) error

    // Stats reports live per-session telemetry for SLO measurement and
    // for the spend meter in Part X.
    Stats() SessionStats

    // Close releases inference capacity. Drains within the grace period.
    Close(ctx context.Context) error
}
```

Four properties of this contract deserve emphasis, because they are the ones that are easy to get wrong and expensive to fix later.

`Audio()` **emits silence rather than emitting nothing.** A channel that goes quiet when the model is not speaking forces the consumer to invent its own clock and reconcile two timelines, which is precisely the class of bug that produces intermittent, unreproducible audible glitches. By requiring a frame every period regardless of content, the media frontend's output loop becomes a single unconditional read at a fixed rate. Network-backed engines must synthesize this silence and absorb their own jitter; cascade engines must synthesize it during synthesis gaps. That is the correct place for the complexity to live, because it is the only place that knows what "late" means for that engine.

`Interrupt()` **takes a measured number, not a flag.** This is the barge-in bookkeeping made structural. An interface whose interrupt method took no argument would permit an implementation that guesses, and a guess here desynchronizes the model's context from reality in a way that is invisible in testing and corrosive in production. Requiring the caller to supply measured playout duration means the interface itself refuses to let the mistake be made quietly. Engines that cannot accept a truncation offset must say so in their descriptor, and the conformance suite tests the resulting behaviour rather than trusting it.

`Inject()` **is the only inbound channel from the asynchronous plane.** Delegation results, tool outputs, speaking guidance, and policy directives all arrive through one method with one deadline and one failure mode. Every alternative we considered — a side channel for tools, a separate guidance path, direct orchestrator access to the engine socket — reintroduced exactly the coupling this architecture exists to prevent.

`Inject()` **is append-only, and there is no method to amend or remove an item.** This is the fourth property and it is the one most likely to be violated by a careful engineer, because violating it looks like good hygiene. When a balance injected six turns ago is superseded by a refreshed figure, the instinct is to correct the original — rewrite it in place, or drop it and re-inject the new value where it belongs. **Both forfeit the cached-input rate on every token after the edit point**, because cache hits require the vendor to have seen identical content in an identical position, and neither raises an error. The session simply becomes several times more expensive with nothing in the logs to say so.

**The correct action is to append a new item carrying `Supersedes: []string{oldID}`.** The stale figure stays in context, costing the handful of tokens it already cost, and the appended correction instructs the model which value is live. Expiry works the same way: a `TTL` elapsing appends an invalidation rather than removing the item, which is why the field is documented as it is. The trade is explicit and lopsided — appending a correction costs perhaps twenty tokens, while rewriting to remove those same twenty tokens forfeits the discount on the entire accumulated conversation after them.

The interface enforces this by omission. There is no `Amend`, no `Remove`, and no mutable handle to an injected item, so an implementation that wants to edit history has to reach around the contract to do it, which is visible in review in a way that a well-intentioned in-place correction is not. `Supersedes` is where the intent belongs, and Section 5.8 treats holding this line as one of the two structural cost levers.

## 3.3 Snapshot fidelity: semantic, not acoustic

Version 0.1 of this document assumed we would own the model and could therefore snapshot at the level of the inference state itself, transferring a KV cache between instances and cutting over with no loss whatsoever. Buying the engine forfeits that, and the document should be honest about what replaces it.

A `Snapshot` is a semantic reconstitution: the ordered conversation items with their text, the tool calls and their results, the injected context still within its lifetime, the compacted summary of everything older, and the durable memory references. Prefilling it into a new session produces a model that knows everything the previous one knew and can continue the conversation coherently. What it does not reproduce is the previous session's internal acoustic conditioning — the model's accumulated sense of this speaker's voice and pacing. In practice the observable effect is small and confined to the first few seconds after cutover, but it is real, and Section 3.8 measures it rather than assuming it away.

Two consequences follow. Handoff should be scheduled at a natural boundary wherever possible — after an assistant utterance completes rather than mid-word — and the conformance suite's handoff test measures both the acoustic seam and the semantic retention, with separate thresholds. And because the snapshot is engine-agnostic text rather than engine-specific state, it can be prefilled into a *different* engine than it came from. That is what makes mid-session degradation to the cascade possible, and it is a capability the acoustic approach would not have given us.

## 3.4 Types

```go
type AudioFrame struct {
    PCM        []int16   // mono, signed 16-bit
    SampleRate int       // see Descriptor; typically 24000 both directions
    Seq        uint64    // monotonic, gap-free; gaps indicate loss
    Timestamp  time.Time // media clock, not wall clock
    Silence    bool      // hint: frame is known-silent, may skip processing
}

type Event struct {
    Type      EventType
    Timestamp time.Time
    Seq       uint64

    // Populated according to Type
    Transcript *TranscriptEvent
    Speech     *SpeechEvent
    Prosody    *ProsodyEvent
    Delegation *DelegationEvent
    Diagnostic *DiagnosticEvent
}

type EventType string

const (
    // Transcript
    EventTranscriptPartial EventType = "transcript.partial" // revisable
    EventTranscriptFinal   EventType = "transcript.final"   // committed

    // Speech boundaries — the raw signal for turn reconstruction
    EventUserSpeechStart      EventType = "speech.user.start"
    EventUserSpeechEnd        EventType = "speech.user.end"
    EventAssistantSpeechStart EventType = "speech.assistant.start"
    EventAssistantSpeechEnd   EventType = "speech.assistant.end"
    EventAssistantTruncated   EventType = "speech.assistant.truncated"
    EventOverlapStart         EventType = "speech.overlap.start"
    EventBackchannel          EventType = "speech.backchannel" // "mm-hm"; not a turn

    // Paralinguistic — from the engine where available, else the sidecar
    EventProsody EventType = "prosody.sample"

    // Delegation — the model asking for help
    EventDelegationRequest EventType = "delegation.request"
    EventDelegationHint    EventType = "delegation.hint" // speculative; cancellable

    // Engine health
    EventContextPressure EventType = "engine.context_pressure"
    EventSessionExpiring EventType = "engine.session_expiring" // handoff trigger
    EventDegraded        EventType = "engine.degraded"
    EventError           EventType = "engine.error"
)

type TranscriptEvent struct {
    Speaker    Speaker // SpeakerUser | SpeakerAssistant
    Text       string
    Confidence float32
    StartTime  time.Duration // offset from session start
    EndTime    time.Duration
    Stability  float32 // 0..1; probability this text will not be revised
}

// ProsodyEvent carries what the transcript cannot. Emitted on change,
// not per frame. Sources are the engine where it exposes the signal and
// the prosody sidecar otherwise. Fields that cannot be measured report
// Unknown rather than a default, so that consumers can tell the
// difference between "neutral" and "we do not know".
type ProsodyEvent struct {
    Speaker    Speaker
    Source     ProsodySource // SourceEngine | SourceSidecar
    Energy     float32       // normalized loudness
    PitchMean  float32       // Hz, 0 if unknown
    PitchVar   float32       // expressiveness proxy
    SpeechRate float32       // syllables per second estimate
    Hesitation float32       // 0..1; disfluency density
    Affect     AffectLabel   // AffectUnknown when unsupported
    AffectConf float32
}

// DelegationEvent is the voice model asking the asynchronous plane for help.
type DelegationEvent struct {
    RequestID   string
    Intent      string        // model's own characterization of the need
    Query       string        // natural-language formulation
    Urgency     Urgency       // drives the narration ladder in Part VI
    Speculative bool          // true for hints; cancellable without penalty
    Window      []Utterance   // recent conversational context
    Prosody     *ProsodyEvent // affective state at request time
}

// ContextItem is the only inbound influence from the asynchronous plane.
// Items are append-only for the life of a session: see §3.2 on why a
// correction is an append and never an edit.
type ContextItem struct {
    ID       string        // stable, caller-assigned; the target of Supersedes
    Kind     ContextKind
    Text     string
    Priority Priority      // controls insertion urgency
    TTL      time.Duration // on expiry, an invalidation is appended — never removed
    Supersedes []string    // IDs this item replaces; corrections use this, not mutation
    Meta     map[string]string
}

type ContextKind string

const (
    ContextDelegationResult ContextKind = "delegation.result"
    ContextToolResult       ContextKind = "tool.result"
    ContextGuidance         ContextKind = "guidance"       // how to say it
    ContextPolicy           ContextKind = "policy"         // what not to say
    ContextGroundingFact    ContextKind = "grounding.fact" // financial fact
    ContextUserVisibleState ContextKind = "ui.state"       // what is on screen
)
```

## 3.5 Capability negotiation

Engines differ in what they can actually do, and the media frontend must adapt rather than assume. The descriptor makes those differences explicit and machine-readable, so that policy selection, degradation logic, spend metering, and the conformance suite all read from one source of truth.

```go
type Descriptor struct {
    ID      string // "openai-realtime", "azure-voice-live", "cascade-v1", ...
    Version string
    Kind    EngineKind // KindSpeechToSpeech | KindFullDuplex | KindCascade

    // Audio
    InputSampleRate  int
    OutputSampleRate int
    FramePeriod      time.Duration // 20 ms default

    // Conversational capability
    NativeEndpointing  bool // server-side semantic VAD; false ⇒ mf runs endpointing
    NativeBargeIn      bool // model stops itself on user speech
    AcceptsTruncation  bool // honours a measured heardMillis on Interrupt
    NativeBackchannel  bool // can emit "mm-hm" during user speech
    NativeOverlap      bool // can speak while the user speaks
    RequiresTurnSignal bool // needs an explicit end-of-turn

    // Uplink gating (§4.10)
    RequiresContinuousInput bool          // true ⇒ send comfort noise, gating saves nothing
    EndpointSilence         time.Duration // engine's end-of-turn silence threshold; gate hangover = this + 700ms

    // Delegation
    NativeToolCalling bool // exposes function calling in-session
    NativeDelegation  bool // emits delegation intent without a tool schema

    // Signals
    EmitsTranscript bool
    EmitsProsody    bool
    ProsodyFields   []string

    // Voice identity
    Voices          []string // preset identifiers
    SupportsCustomVoice bool

    // Lifecycle
    SupportsSnapshot   bool
    SnapshotFidelity   Fidelity // FidelitySemantic | FidelityAcoustic
    SupportsPrefill    bool
    MaxContextTokens   int
    MaxSessionDuration time.Duration // drives EventSessionExpiring

    // Operations
    Locale         []string
    ResidencyZone  string  // "ca" | "us" | "eu" | "offshore"
    DataRetention  string   // "zdr" | "30d" | "vendor-default"
    CostPerMinute  float64 // fully loaded, for admission, tiering and metering
    MaxConcurrent  int     // per replica or per vendor quota
}
```

Several of these fields are load-bearing rather than informational.

`AcceptsTruncation` is the field that makes barge-in bookkeeping enforceable. An engine that reports false gets a media-frontend-side compensation path and a permanent telemetry flag, and it is not eligible for production tiers.

`RequiresTurnSignal` lets a half-duplex or cascade engine live behind this interface honestly. When true, the media frontend runs the endpointing stack from Part IV and synthesizes the boundary. The rest of the system is unaffected, and telemetry distinguishes the two cases so we can measure exactly what the degraded path costs.

`RequiresContinuousInput` and `EndpointSilence` are what let the uplink gate in Section 4.10 be safe across engines rather than tuned for one. The gate derives its hangover from `EndpointSilence` instead of a constant, so an engine that needs longer silence to commit a turn automatically gets a longer hangover rather than a hung conversation; an engine that declares neither is gated conservatively at 1,500 ms. `RequiresContinuousInput` marks the engines where gating saves nothing, so the cost model does not assume the production path's economics everywhere.

`ResidencyZone` and `DataRetention` are enforced, not advisory. Admission control refuses to place a session on an engine whose zone or retention posture violates the user's policy. This is how a benchmark engine can exist in the codebase as a measurement target while being structurally unreachable by a production session.

`CostPerMinute` feeds both admission control and the live spend meter in Part X. It is a declared property of the engine rather than a constant in billing code, which means that changing engine and changing the cost model are the same action and cannot drift apart.

## 3.6 Planned implementations

Six implementations are specified. One ships in Phase 1, one in Phase 2, and the rest exist to keep the interface honest and to give us somewhere to go.

**`openai-realtime` — the production engine.** `gpt-realtime-2.1` with native audio output over the Realtime API, on every paid tier. Reports native endpointing, native barge-in, truncation support, native tool calling, semantic snapshot fidelity, US residency, and a preset voice list. This is the best conversational voice experience purchasable in August 2026 and there is no serious argument for shipping anything else first. Its known constraints are that it exposes no prosody events, which the sidecar compensates for; that it offers presets only, which Part V addresses; that it enforces a session ceiling, which makes handoff mandatory rather than optional; and that its data retention default requires an explicit zero-retention agreement before production financial conversations run through it, which Part IX makes a launch gate.

**`cascade-v1` — the cost floor and the bottom of the degradation ladder.** Composes streaming recognition, the reasoning delegate, and streaming synthesis behind the same interface, with the media frontend supplying endpointing. Every component is independently strong: Qwen3-ASR-0.6B streams natively from a dynamic attention window at roughly 92 ms to first token, and Qwen3-TTS-12Hz-0.6B produces a first packet in roughly 97 ms at low concurrency. Reports `NativeBargeIn: false`, `RequiresTurnSignal: true`, `EmitsProsody: false`, and a cost per minute roughly an order of magnitude below the production engine. Its purpose is threefold: it is what runs when the Realtime API is degraded or unreachable, it is the number every vendor-price increase gets measured against, and it is the engine that makes a Canadian-residency deployment possible on short notice because every component can be self-hosted. It must be maintained at production quality permanently rather than allowed to rot.

**`azure-voice-live` — the residency and voice-identity option.** The same OpenAI realtime models served through Azure AI Foundry's Voice Live API, which offers regional control OpenAI does not and custom neural voice support OpenAI does not. This is simultaneously the most credible path to Canadian processing and the most credible path to Raya having her own voice, which is why it is specified now rather than later even though its pricing and Canadian region availability both require verification before it can be relied upon. Part V treats verifying those two facts as a Phase 0 spike, because the answer changes the residency roadmap and the voice-identity plan at once.

**`fullduplex-v1` — the open frontier.** Lychee-FD as primary candidate, with Fun-Audio-Chat-Duplex, BayLing-Duplex and Moshi as fallbacks, served on vLLM with a `token2wav` vocoder. Reports native backchannel and overlap, which no other engine here can. It is not a launch candidate — the intelligence gap in Section 1.5 is disqualifying for financial conversation today — but it is the only path to conversational behaviour the vendor cannot sell us, and having it behind the interface means adoption is a config change on the day the gap closes. Its first engineering spike is verifying that vLLM-Omni's realtime path actually implements interruption during generation, which a reviewer on the streaming-input pull request has questioned.

**`dashscope-realtime` — benchmark harness, never production.** Alibaba's `qwen3.5-omni-plus-realtime`. Pinned to `ResidencyZone: "offshore"` and structurally unreachable by production sessions. It exists to give us a second reference ceiling to measure against, so that "OpenAI is the best" remains a measured claim rather than an assumption we stopped testing.

**`raya-fd` — the research track.** Our own full-duplex model, produced by applying the BayLing-Duplex conversion recipe to a base model chosen for financial reasoning rather than inherited. Specified in Part XIV. It is a research bet, it is not on the critical path, and the document is explicit that it may never ship.

## 3.7 Engine selection policy

Selection happens once at session open and can be revised mid-session only through the handoff mechanism. It is a pure function of inputs all available before the first frame.

```go
type SelectionInput struct {
    UserID          string
    Tier            PlanTier       // basic | plus | pro
    ResidencyPolicy string         // "ca" | "us" | "eu"
    RemainingSpend  Micros         // from the per-user ceiling in Part X
    Locale          string
    Client          ClientKind     // web | ios | android | desktop | sip
    Experiment      *ExperimentArm // shadow and A/B assignment
    EngineHealth    HealthSnapshot // live vendor and pool health
    Override        *string        // runtime pin for incident response
}
```

The resolution order is deliberate. An explicit runtime override wins, because incident response must not require a deploy. Residency and retention policy then filter the candidate set to compliant engines, and this filter is a hard constraint rather than a preference. An experiment assignment applies next, for shadow and A/B work. Otherwise every tier resolves to `openai-realtime`, because Part X's conclusion is that the flagship engine belongs on every paid tier and that differentiation happens through allowance and capability rather than through model quality. Finally, if the selected engine is unhealthy or the user's remaining spend cannot fund it, the ladder in Part XII degrades to the next viable option and records the demotion as a service-level event rather than swallowing it.

Consistent with the hot-swap convention already established in `Raya-Technical-Architecture.md` §5.6, the entire policy lives in `AppRuntimeSetting` under key `raya_voice_engine_routing` and is changeable at runtime without redeployment. Changing the voice model in production is a database write. That sentence is the whole point of Part III.

## 3.8 The conformance suite

An interface that is not enforced becomes a suggestion. Every engine must pass an automated conformance suite before it is eligible for any traffic, and the suite runs in continuous integration against every engine on every change. This is the mechanism that makes "swappable" true rather than aspirational, and it is the reason a vendor change is a week rather than a quarter.

The suite is organized around the properties the rest of the system depends on.

**Clock conformance.** Given a synthetic sixty-second input at exact cadence, the engine must emit exactly the expected number of output frames, with inter-frame delta at p99 within two milliseconds of the frame period and zero gaps. For network-backed engines this tests jitter absorption and underrun-into-silence rather than the vendor's own timing, which is the correct thing to test because it is the thing we control.

**Barge-in latency.** With user speech injected during assistant output, the engine must cease output within one hundred milliseconds at p95. Engines reporting `NativeBargeIn: false` are tested against the media frontend's safety net and must meet the same number end to end.

**Truncation accuracy.** After an interruption, the engine's belief about what it said must match measured playout within one frame period. This is tested by interrupting at a known offset, then asking the model in a follow-up turn to repeat what it had just said, and asserting that the boundary falls where the audio actually stopped. It is the single most important test in the suite, because it is the failure that degrades silently.

**Interrupt correctness.** After `Interrupt`, no further audio may be emitted from the interrupted utterance and the engine must remain able to resume normal operation. This is the specific defect suspected in vLLM-Omni's realtime path and the reason `fullduplex-v1` cannot be trusted until it passes.

**Injection latency and honesty.** Content injected via `Inject` must be reflected in generated speech within a bounded window, and an item whose lifetime has expired must never be spoken. A model that narrates a stale balance is worse than one that says nothing, and this is a financial-correctness test disguised as a latency test.

**Supersession correctness and cache preservation.** Two assertions on one scenario: inject a figure, converse for several turns, then supersede it with `Supersedes`. The engine must speak only the corrected value — the honesty half — **and the session's cached-input ratio must not fall across the supersession boundary**, which is the cost half. An implementation that satisfies correctness by rewriting history passes every other test in this suite while silently multiplying the cost of the session, so the cache assertion is the only thing standing between a clean-looking implementation and an invoice nobody can explain. The same scenario is run for `TTL` expiry, which must append an invalidation rather than remove the expired item.

**Snapshot fidelity.** Snapshot at turn N, prefill into a new session, continue. The conversation must remain coherent, must retain named entities and numeric facts from before the boundary, and must not repeat itself. Scored against a golden conversation set by a judge model with a fixed rubric and a hard floor. Cross-engine prefill — snapshot from `openai-realtime`, prefill into `cascade-v1` — is tested separately, because it is the mechanism behind mid-session degradation.

**Handoff seam.** Under a forced cutover mid-session, output audio must be gap-free and phase-continuous, measured by signal analysis on the recording rather than by listening. Semantic retention across the seam is scored separately, per Section 3.3.

**Load behaviour.** At the engine's declared `MaxConcurrent`, every preceding assertion must still hold. Declared concurrency that fails this test is corrected in the descriptor, which automatically corrects admission control — the descriptor is the source of truth, so fixing the number fixes the system.

**Degradation honesty.** Under induced pressure, whether GPU contention for self-hosted engines or injected latency and error rates for vendor engines, the engine must emit `EventDegraded` before its frame timing violates the clock assertion. An engine that degrades silently is unusable, because the ladder in Part XII cannot act on a signal it never receives.

**Cost declaration accuracy.** Measured spend over a fixed corpus must match `CostPerMinute` within five percent. An engine whose declared cost is wrong will silently break the entitlement model, and the entitlement model is what makes the flagship affordable on a $25 tier.

**Gate safety.** With the uplink gate enabled at its configured hangover, the engine must commit every turn in the corpus — zero hangs — and word-onset recognition must be indistinguishable from the ungated run. The corpus in Appendix C is the right instrument for this because it already contains the two patterns that break gating: the numeric retrieval pause, where a user goes quiet mid-thought while recalling a figure, and emotional disclosure, where the pause before the difficult sentence is long and must not be treated as the end of a turn. A gate configuration that passes every other test and fails this one is a configuration that makes Raya interrupt people at their most vulnerable moment, which is why it is a conformance gate rather than a tuning preference.

The suite runs against a fixed corpus of recorded sessions covering the conversation patterns that actually break voice systems: numeric retrieval pauses, mid-sentence self-correction, emotional disclosure, rapid-fire questions, background speech from a second person, and code-switching. That corpus is a deliverable in its own right and is specified in Appendix C.

---

# Part IV: The Media Plane

## 4.1 What this plane is responsible for

The media plane moves audio between a human ear and a model, on a schedule, without ever being late. That is its entire job, and the discipline of this part is refusing to give it any other one.

It spans four things: the client, the transport, the SFU, and the media frontend. Three of those four we largely do not write. The fourth, `raya-mf`, is the only wholly new service on the hot path, and it is small on purpose. If it grows past a few thousand lines it has almost certainly absorbed responsibility that belongs on the asynchronous plane.

## 4.2 Transport: why WebRTC over a managed SFU

Three transports were considered seriously.

**Raw WebSocket carrying PCM or Opus** is the simplest to implement and the easiest to reason about, and it is what most realtime voice demos use. It is wrong for production because it runs over TCP. A single lost packet stalls the entire stream until retransmission completes, which on a mobile network is exactly the moment you cannot afford a stall. Head-of-line blocking turns a 2% loss rate into audible dropouts rather than into imperceptible concealment. WebSocket remains the right transport between `raya-mf` and the engine, where both endpoints are in datacentres, and the wrong one to the user's phone.

**WebRTC terminated by us** gives the correct network behaviour: UDP, packet loss concealment, adaptive jitter buffering, congestion control that degrades bitrate rather than timing, and mature echo cancellation in every browser. It also means owning ICE, TURN relays, DTLS, SRTP, simulcast negotiation, and a decade of accumulated NAT-traversal edge cases. OpenAI owns their WebRTC stack because at their scale the marginal optimization is worth a team. At our scale it would consume the team.

**WebRTC terminated by a managed SFU** gives the network behaviour without the ownership, and that is what we do. LiveKit Cloud handles ICE, DTLS, SRTP, congestion control, loss concealment, jitter, and — significantly for us — bridges SIP and PSTN into the identical room abstraction, so a phone call and a browser session are the same code path in `raya-mf`. This is the single largest scope reduction available to this project.

The cost of the managed choice is a dependency and a hop. The dependency is contained by Section 2.8's decision to use LiveKit as an SFU only, which keeps a future move to self-hosted LiveKit or another SFU a transport-adapter change. The hop is roughly fifteen milliseconds each way and is budgeted honestly in Section 4.8.

## 4.3 Clients

The client is deliberately thin. It captures, encodes, publishes, subscribes, decodes, plays, and reports. It does not decide anything about the conversation.

**Capture and encode.** Mono, 48 kHz capture, encoded as Opus in 20 ms frames at 24–32 kbps with discontinuous transmission disabled. Discontinuous transmission saves bandwidth by suppressing silence, which is exactly wrong for us: the engine's endpointing is conditioned on continuous audio, and suppressed silence is indistinguishable from a network stall.

**Echo cancellation is non-negotiable and belongs on the client.** Without it, Raya hears herself through the user's speakers and the engine's endpointing fires on her own voice. Browsers provide it through `getUserMedia` constraints; iOS and Android provide it through the platform voice-processing audio unit. The client must verify it is actually active rather than merely requested, and report the result in session telemetry, because a device where echo cancellation silently failed produces a session that is broken in a way that looks like a model problem.

**Wake word, where the tier permits it,** runs entirely on device. No audio leaves the device before the wake word fires. This is both a privacy property we will state publicly and a cost property: ambient listening that streamed continuously to a paid API would be unaffordable at any subscription price.

**Playout reporting is a first-class client responsibility.** The client reports its playout position and jitter buffer depth on the data channel at a low rate, and flushes its buffer immediately on receiving a discontinuity marker. Section 4.6 explains why this matters more than it looks.

**Rendering** is driven by the speculative transcript feed described in Part VII, not by the authoritative one. The user sees words appear as they are recognized, with unstable text visually distinguished from stable text, and the authoritative record reconciles behind them.

## 4.4 The media frontend: process model

`raya-mf` is a Go service on Cloud Run with CPU always allocated, two vCPU, and a request concurrency of twenty-five sessions per instance.

Session dispatch works by holding a request open. `raya-api` issues an HTTP request to `raya-mf` naming the room, the engine profile, the session configuration and the credentials; `raya-mf` joins the room as an ordinary participant and holds the request open for the life of the session. This maps a session onto Cloud Run's billing and lifecycle model exactly: the instance stays warm while sessions are live and scales on concurrency. It does not scale to zero, because the session-establishment budget in Section 4.8 allocates only 150 ms to dispatch and room join and a cold start would consume several times that; a minimum instance count of one is held permanently and is the small standing charge that buys the latency target. It also means a session cannot outlive Cloud Run's sixty-minute request ceiling, which is fine, because the engine's own session ceiling is shorter and handoff exists regardless.

Per session, `raya-mf` runs a small fixed set of goroutines: an inbound loop reading decoded frames from the SFU, an outbound loop writing frames to the SFU on the frame clock, an engine reader draining the engine's audio and event channels, an event mirror shipping control events to `raya-api`, and a supervisor owning lifecycle and handoff. Communication between them is over buffered channels with defined overflow behaviour. Nothing in this set performs blocking input or output, and a linter rule enforces that the packages implementing them may not import the HTTP client or the database driver.

The service is horizontally scaled and session-affine but holds no durable state. An instance dying kills its sessions; those sessions reconnect through the recovery path in Section 4.9 and are prefilled from the last snapshot. There is no session migration between instances outside that path, because building one would mean building distributed state, and distributed state on the real-time plane is how you get a system that is fast except when it is not.

## 4.5 The frame clock

The output loop is the heart of the service and it is deliberately trivial:

```go
ticker := time.NewTicker(20 * time.Millisecond)
for {
    select {
    case <-ticker.C:
        frame := s.nextOutboundFrame() // never blocks; returns silence on underrun
        s.track.WriteSample(frame)
        s.playout.Advance(frame)
    case <-ctx.Done():
        return
    }
}
```

Every property that matters is visible in that loop. The clock is ours, not the engine's. `nextOutboundFrame` is total — it always returns a frame, drawing from the engine's buffer when one is available and synthesizing silence when it is not, and recording an underrun event either way. And playout advances in lockstep with what is actually written, which is what makes Section 4.6 possible.

Between the engine socket and this loop sits a small adaptive buffer, defaulting to sixty milliseconds and widening under measured jitter to a ceiling of one hundred and twenty. Widening it trades responsiveness for smoothness, and the trade is made on measured vendor jitter rather than on a fixed guess. Underruns are counted, exposed as a service-level indicator, and are the earliest warning that the vendor is degrading — usually visible several minutes before error rates move.

## 4.6 Playout accounting and barge-in bookkeeping

This section describes the correctness property most integrations get wrong, and it is the reason the interface in Part III takes a measured number rather than a flag.

When the user interrupts, three quantities diverge. The engine has *generated* some amount of assistant audio. `raya-mf` has *published* some smaller amount, because generation runs ahead of the clock. And the user has *heard* a smaller amount still, because published frames sit in network flight and then in the client's jitter buffer before reaching a speaker. The gap between generated and heard is routinely two hundred milliseconds and can exceed four hundred on a poor connection — easily a full clause of speech.

If the engine's context retains the whole generated utterance, the model now believes it told the user something the user never heard. Every subsequent turn is grounded in that false premise. The user asks "what did you say about the car payment?" and the model, believing it already explained, answers as though repeating itself. The failure is quiet, it never raises an error, and it is close to impossible to diagnose from logs unless you were already looking for it.

The correction has three parts and all three are required.

**Detect locally, not remotely.** `raya-mf` runs a lightweight energy-and-spectral voice activity detector on the inbound track continuously, independent of the engine. When it fires during assistant speech, the outbound loop stops publishing immediately — typically twenty milliseconds after onset — rather than waiting for the vendor's own speech-start event to make the round trip. The vendor event still arrives and is still used, as confirmation and as the authoritative boundary for the transcript, but it is not on the critical path for stopping.

**Flush the client.** Stopping publication does not stop playback, because the client is still holding buffered audio. `raya-mf` sends a discontinuity marker on the data channel and the client drops its jitter buffer contents on receipt. Without this, the user continues hearing Raya for the depth of their buffer after interrupting, which is the single most common reason barge-in "feels broken" in otherwise well-built systems.

**Report the measured number.** The playout cursor, advanced frame by frame in the output loop and corrected against the client's periodic playout reports, yields the exact number of milliseconds of the current assistant utterance that reached the user. That number, not an estimate, is passed to `Interrupt` and forwarded to the engine as a truncation offset. It is simultaneously sent to `raya-api`, which marks the assistant turn truncated at the same offset so that the stored transcript and the model's context agree.

The service objective is stated at the ear rather than at the wire, because the wire is not where the user is. **Raya must become inaudible to the user within one hundred milliseconds of speech onset at p95**, and that figure has to absorb all three steps: local detection and cessation of publication, which runs at roughly twenty to thirty milliseconds; the discontinuity marker's flight to the client, which is one one-way trip; and the client's buffer drop, which is immediate on receipt. Measuring only the moment `raya-mf` stops publishing would produce a number that looks excellent while the user is still listening to a sentence they tried to interrupt, and that gap is precisely the thing that makes barge-in feel broken in systems whose dashboards say it is fine.

Measured at the ear, one hundred milliseconds is a harder target than the same number measured at the wire, and the document should be read as having chosen the harder one deliberately. If measurement in Phase 0 shows it is not reachable, the honest move is to raise the number rather than to move the measurement point back to the wire. A target that is met by measuring the wrong thing is not a target.

The second objective is that the truncation offset reported to the engine falls within one frame period of measured playout. This one is tested directly in the conformance suite rather than only monitored, because it is the one that fails silently.

## 4.7 The endpointing safety net

The production engine performs its own semantic endpointing, so the media frontend does not need to. But `cascade-v1` does need it, `fullduplex-v1` needs it during evaluation, and any future engine reporting `RequiresTurnSignal: true` will need it. The endpointing stack therefore exists as an optional component that the media frontend activates from the descriptor.

It is a two-signal design rather than a threshold ladder. A voice activity detector supplies the acoustic signal, and a small classifier over the partial transcript supplies a completion probability — is this utterance syntactically and semantically finished, or does it end mid-constituent. The turn ends when both agree, with an acoustic-only fallback at a generous two seconds so the system cannot hang on a classifier that never commits.

This is strictly worse than the production engine's native endpointing, and the document should not pretend otherwise. It exists so that the degraded path is degraded rather than broken, and the telemetry distinguishes sessions running on it so that we can measure exactly what a fallback session costs the user in experience.

## 4.8 The latency budget

Two budgets matter and they are measured separately.

**Session establishment**, from the user's tap to the first frame of their audio reaching the engine. Target 800 ms at p95.

| Hop | Budget | Notes |
| :--- | ---: | :--- |
| Client to `raya-api`, auth, entitlement, spend check | 120 ms | Cached entitlement; a database read here would blow the budget |
| LiveKit token mint and engine credential mint | 30 ms | Both are local signing operations |
| ICE, DTLS handshake, first media | 250 ms | Dominated by round trips; the largest single item |
| `raya-mf` dispatch and room join | 150 ms | Warm instance assumed; cold start is handled by min-instances |
| Realtime API session open and configuration | 200 ms | Vendor-controlled |
| First frame captured, encoded, forwarded, decoded | 40 ms | |
| **Total** | **790 ms** | 10 ms of slack, which is honest rather than comfortable |

Delegate warming runs concurrently with all of this and must not appear in the budget. If it ever blocks session establishment, the boundary has been violated.

**Response latency**, from the user finishing speaking to the first assistant audio reaching their ear. Target 600 ms at p50 and 1000 ms at p95.

| Hop | p50 | Notes |
| :--- | ---: | :--- |
| Capture, encode, client to SFU | 40 ms | Includes one frame of encoder latency |
| SFU forward to `raya-mf` | 15 ms | Same-region |
| Decode, resample, fork to sidecar, push | 5 ms | |
| `raya-mf` to Realtime API | 25 ms | Same-region, WebSocket |
| Endpointing decision and generation to first audio | 350 ms | Vendor-controlled; the dominant term |
| Realtime API to `raya-mf` | 25 ms | |
| Adaptive buffer and publish | 60 ms | Tunable; the one term we trade deliberately |
| SFU to client | 15 ms | |
| Client jitter buffer and playout | 60 ms | Browser-controlled |
| **Total** | **595 ms** | |

Roughly three-fifths of that budget is the vendor's and roughly one-fifth is buffering we chose. That is a materially better position than the 1.5 to 2.5 seconds a cascade produces, and it is a materially worse position than OpenAI's own product achieves with colocated inference and their own transport. Both halves of that sentence belong in the document.

## 4.9 Reconnection, network change, and recovery

Mobile users change networks mid-sentence. The system must treat that as ordinary rather than exceptional.

WebRTC ICE restart handles the common case — a Wi-Fi to cellular handoff — with a brief interruption and no session teardown, because the SFU and the room survive. The engine session is untouched, because it lives between `raya-mf` and the vendor and knows nothing about the user's network. This is a quiet benefit of putting the media frontend in the middle rather than connecting the client directly to the vendor, and it is a sufficient reason not to use the Realtime API's direct-to-client WebRTC mode however convenient that would be.

A longer disconnection, beyond roughly fifteen seconds, ends the media session. `raya-mf` snapshots the engine session, holds the snapshot in Redis against the session identifier for ten minutes, and closes. When the client returns, `raya-api` recognizes the resumable session, dispatches a fresh `raya-mf` worker, and prefills from the snapshot. The user resumes a conversation that remembers them rather than starting over, which for a financial conversation in progress is the difference between an annoyance and a lost session.

An instance failure is handled by the same path, with the snapshot taken opportunistically on a rolling basis rather than at failure time. The rolling snapshot interval is thirty seconds, which bounds worst-case loss to thirty seconds of conversation and costs one asynchronous serialization per interval.

The failure the recovery path cannot repair is a vendor outage, and that is Part XII's subject.

## 4.10 Uplink gating: not paying for silence

The Realtime API bills audio by the token, not by the wall clock, which means **every frame of silence we forward is purchased**. A session in which someone thinks for twenty seconds, takes a sip of coffee, or leaves the microphone open while the model is speaking is a session in which we are paying for audio that carries no information. This is the largest piece of unforced cost in the system and it is invisible in any per-minute figure, including the ones in Section 5.6.

**The distinction that makes this safe to do is between deciding when a turn ends and deciding what to transmit.** Turn detection is a quality property, it belongs to the engine, and Section 5.1 is right that we should not tune it. Uplink gating is a transport property, it belongs to the media frontend, and the engine cannot observe it provided the gate never withholds audio the engine needs. Conflating the two is what makes "reduce voice cost" sound like "make Raya interrupt people," and they are not the same change.

**The gate is asymmetric by construction, because the two failure directions are not symmetric.** Opening late clips the onset of a word, which is a transcription error and therefore a product defect. Closing late costs a fraction of a cent. So the gate opens on the first frame of energy above the noise floor and closes only after a hangover window, and every parameter is biased toward transmitting.

Two mechanisms make it correct rather than merely cheap.

**A rolling pre-roll buffer of 300 ms is transmitted ahead of the gate opening.** `raya-mf` already holds the raw input track and already runs a 20 ms frame clock, so it retains the most recent fifteen frames at all times. When the gate opens, those frames are flushed upstream before the live ones. Without this the gate would systematically remove word onsets — the plosive at the start of "budget" — and degrade recognition in a way that would be blamed on the model.

**The hangover must exceed the engine's own end-of-turn silence threshold, with margin.** This is the correctness constraint that a naive implementation gets wrong and it deserves stating plainly: the engine decides the user has finished speaking *by hearing silence*. If the gate closes before the engine has received enough silence to endpoint, the engine never commits the turn and the conversation hangs. The hangover is therefore configured from the engine descriptor rather than as a constant, at the declared silence threshold plus 700 ms. An engine that does not declare one gets a conservative 1,500 ms.

The saving therefore does not come from the pauses inside speech, which are correctly purchased and which the hangover deliberately protects. It comes from the long tail: the twenty-second think, the interruption from a family member, the period after the engine has already endpointed and is generating its reply, and the session left open on a desk. Those are where minutes leak, and they are exactly the intervals where nothing is lost by staying quiet.

**Engines that require a continuous input stream declare it.** `RequiresContinuousInput` is added to the capability descriptor in Section 3.5. An engine that sets it receives comfort noise at the frame clock rather than nothing, and admission control records that the gating saving does not apply to it, so the cost model stays honest across engines rather than assuming the production path's economics everywhere.

**Session parking is the second-order case, and its benefit is capacity rather than tokens.** When the gate has been closed for ninety seconds, the session is a candidate for parking: `raya-mf` snapshots it, closes the vendor session, and holds the snapshot exactly as Section 4.9 does for a network drop, reopening on the next speech through the handoff path in Section 5.2. An idle Realtime session accrues no token cost, so parking saves little directly. What it saves is the transport line, the Cloud Run slot, and one of the twenty-five session slots on a `raya-mf` instance — and it creates a natural moment to compact before reopening, which cuts the history re-billed on the next turn. Park on idle, and the concurrency ceiling in Section 5.6 of the accounting model moves outward at no product cost.

**Metering is unaffected and this should be a deliberate decision rather than an accident.** Tier allowances in Part X are denominated in wall-clock voice minutes because that is what a user experiences and can reason about; gating changes what we pay, not what we charge. The gap between the two is margin, and it widens with every silent second we decline to purchase. The spend meter in Section 10.4 must therefore track both figures separately — billed minutes and purchased tokens — or the accuracy indicator in Section 11.2 will drift the moment gating ships.

---

# Part V: The Inference Plane

## 5.1 Session configuration

A Realtime session is opened by `raya-mf` through the `openai-realtime` adapter and configured once at open. The configuration is derived from the session profile that `raya-api` supplied, and the adapter is the only code in the system permitted to know the vendor's field names.

The parts of that configuration that carry design weight are worth stating explicitly.

**Modalities are audio and text together.** Text output is requested alongside audio not because we render it — the speculative transcript comes from the same stream — but because the text channel is what the turn reconstructor in Part VII consumes, and because it is materially cheaper to receive it than to transcribe the audio again.

**Server-side semantic endpointing is enabled and left alone.** The temptation to tune its aggressiveness will arise the first time a tester is interrupted, and it should be resisted until there is measured data from the corpus in Appendix C. The whole argument of Part I is that thresholds chosen in advance are the problem; replacing the vendor's learned endpointing with our own constants would reintroduce it. **This prohibition covers when a turn ends, not what we transmit** — the uplink gate in Section 4.10 reduces purchased audio without touching the endpointing decision, and the two must not be conflated when someone is asked to reduce voice cost.

**The system instruction is short and behavioural, not encyclopaedic, and it carries a hard budget of 600 tokens.** It establishes Raya's voice persona, the investment-advice boundary as a hard refusal, the delegation protocol, and the narration policy. It does not contain financial data, user memories, or tool documentation. Everything specific arrives through `Inject` at the moment it is relevant, because **anything placed in the system instruction is re-billed on every turn for the life of the session and cannot be revised**. The budget is asserted in CI against the tokenizer rather than trusted to review, because instruction files grow by one well-intentioned clause at a time and nothing about that growth is visible until the invoice arrives. Raising the ceiling is a decision with a cost attached, and the assertion is what forces it to be made deliberately.

**A deliberately small function catalog is registered in-session.** The voice model does not get Raya's full tool registry. It gets one delegation function and a handful of high-frequency read shortcuts. Part VI develops the reasoning, but the short version is that a large in-session tool catalog costs tokens on every turn, degrades selection accuracy, and duplicates a routing decision the orchestrator already makes better.

**Voice, output format, and input format** are set from the descriptor rather than hardcoded, which is what allows the same adapter to serve the Azure variant in Section 5.5 without branching.

## 5.2 Why handoff is mandatory

Realtime sessions end. They end at a duration ceiling, and they end when the accumulated context reaches its limit, and both ceilings are shorter than a Raya conversation can plausibly run. A user working through a budget with Raya for forty minutes will cross at least one of them.

This is the point where buying the engine costs us something real. OpenAI's own account describes warm handoff at the level of inference state: a replacement instance is prefilled, runs in parallel until it has caught up, and takes over between frames with nothing lost. We cannot do that, because we do not have access to the inference state. What we have is the semantic snapshot from Section 3.3, and a handoff built on it is genuinely lossier.

The design therefore concentrates on making the loss small and putting it where it will not be noticed.

**Handoff is anticipated, never reactive.** The adapter emits `EventSessionExpiring` when either ceiling is within a configured margin — twenty percent of the context limit, or three minutes of the duration limit. The supervisor then waits for a natural boundary: the end of an assistant utterance, followed by user speech, is ideal, because the replacement session's first act is to listen rather than to speak, and its lack of acoustic conditioning on the previous audio is least visible when it has not yet said anything.

**The replacement is warmed before the cutover, not during it.** The supervisor opens the new session, prefills the compacted snapshot, and waits for it to report ready, all while the current session continues serving. Only then does the outbound loop switch its source. The switch itself is a pointer swap between frames and produces no gap, which is why the conformance suite tests the acoustic seam separately from the semantic retention: the seam should be perfect and the retention will not be.

**If the natural boundary does not arrive before the hard ceiling,** the supervisor forces the cutover and accepts a mid-utterance seam. This is rare and it is logged as a service-level event, because a rising rate of forced cutovers means the anticipation margin is too small.

## 5.3 Compaction is a cost control and a memory event

Compaction exists in OpenAI's design to fit a conversation into a context window. In ours it does that, and it does two more things that make it one of the more valuable mechanisms in the system.

**It controls cost, because realtime pricing compounds.** A realtime session bills the accumulated conversation as input on every turn. Turn one bills a short history; turn forty bills everything that came before it. Absent caching this grows quadratically with session length, and even with the cached-input discount that makes it tractable, the cost of a voice-minute is not constant — the thirtieth minute of a session costs meaningfully more than the third. This is the single most important thing to understand about realtime economics and it is invisible in any headline per-minute figure, including the ones in this document.

The direct consequence is that compaction should be more aggressive than context pressure alone would justify. Compacting at sixty percent of the context ceiling rather than at ninety costs a little fidelity and saves a large fraction of the compounding, and for long sessions it is the difference between a tier allowance that holds and one that does not.

**The threshold is the mechanism, but it should not be the target.** A percentage of the context ceiling is a proxy for what we actually care about, which is that a minute of conversation costs about the same in the fortieth minute as in the fourth. The governing metric is therefore **tokens per session-minute, measured by session-length decile** (Section 11.2), and the compaction threshold is whatever holds that curve flat. Tuning the threshold directly invites optimising a number nobody is paying, and it hides the compounding behind a setting that looks reasonable.

**It forms memory, because the discarded detail goes somewhere.** OpenAI summarizes and discards. Raya already has a memory store, a fact extraction pipeline, and a retrieval layer, so the summarization pass has somewhere to put what it removes. Compaction runs on the asynchronous plane as an orchestrator call that produces two outputs: a compact conversational summary that is prefilled into the replacement session, and a set of typed memory records — facts, preferences, commitments, emotional context — that are written to the memory store and are available to every future conversation on any surface.

This inverts the usual relationship between the two mechanisms. Aggressive compaction is normally a reluctant trade against quality. Here it is *how memory gets made*, so compacting more often makes Raya know the user better rather than worse. It is the clearest example in this document of an advantage that comes from being a product rather than a platform.

The memory-forming pass is subject to the same permission and privacy rules as any other write, and Part IX specifies what may not be retained regardless of how useful it would be.

## 5.4 The prosody sidecar

The Realtime API's model perceives prosody — that is intrinsic to a native speech-to-speech architecture and it is a large part of why the interaction feels attentive. What it does not do is expose that perception to us as a signal we can route anywhere else. The model's understanding of how the user sounded stays inside the model.

For the conversational surface this is fine; the model is the thing that needs it. For delegation it is a real loss. A reasoning delegate deciding how to answer "can I afford to leave my job" benefits enormously from knowing whether the question was asked lightly or with a shake in the voice, and the transcript is identical either way. Part I's complaint about the cascade destroying the paralinguistic channel applies, in attenuated form, to our own delegation boundary.

The sidecar recovers it. Because the media frontend holds the raw input track, it can fork a copy to a small emotion-and-paralinguistics recognizer of the SenseVoice class, which returns `ProsodyEvent` samples that annotate every delegation payload and are stored against the transcript for later analysis.

**It runs as a separate Cloud Run service, not inside `raya-mf`, and this is a hard boundary rather than a deployment preference.** A model of that class is hundreds of millions of parameters and consumes real CPU on every inference. Placing it in the same process as the frame clock would put an unbounded, garbage-collecting, CPU-hungry workload directly alongside a loop whose entire correctness property is that it never misses a twenty-millisecond deadline, and at twenty-five sessions per instance on two vCPU it would not fit in any case. The media frontend therefore accumulates a rolling analysis window — one second of audio, evaluated at roughly one hertz rather than per frame — and ships it to the sidecar service on a fire-and-forget call. Batching this way also happens to be what the model wants, since affect is not measurable on a twenty-millisecond frame.

Three further constraints keep it from becoming a liability. It is strictly off the critical path: the window handoff is a buffered channel send with a full-buffer drop policy, and a sidecar that stalls, crashes, or is scaled to zero affects nothing but the completeness of prosody data. It reports `AffectUnknown` rather than a default when confidence is low, so that a consumer can distinguish "neutral" from "we do not know" — a distinction that matters when the downstream decision is whether to soften an answer. And its output is advisory to the delegate rather than authoritative: prosody may shape *how* Raya answers and must never change *what* is true about the user's money.

This is a capability OpenAI's product does not have, obtained cheaply because we control the transport. It is worth noting as one of the few places where being the integrator rather than the vendor is an advantage.

## 5.5 Voice identity

Raya launches with an OpenAI preset voice. She will not sound distinctive in version one, and every person who hears her and has used ChatGPT's voice mode will recognize it. This is a real cost to a brand whose entire proposition is a relationship with a particular presence, and the document records it as a known deficit with a plan rather than as an accepted permanent state.

Three routes exist and they are not equally good.

**Azure Voice Live is the strong route.** Microsoft serves the same OpenAI realtime models through Azure AI Foundry, with regional control OpenAI does not offer and custom neural voice support OpenAI does not offer at all. If the pricing is within a reasonable multiple and a Canadian or at least a North American data-zone region is available, this single change delivers both Raya's own voice and a substantial improvement in the residency posture, and it costs us an adapter rather than an architecture. It is specified as `azure-voice-live` in Section 3.6 precisely so that adopting it is a config change. Verifying its pricing, its region availability, its custom-voice onboarding requirements and its latency against the direct OpenAI path is a Phase 0 spike and one of the highest-value pieces of research in the plan.

**The hybrid split is the weak route.** Run the Realtime API in audio-in, text-out mode and synthesize Raya's voice ourselves with a cloned or designed voice. This gets a distinctive voice today, from any vendor, with full control. It also gives back most of what Part I said made native speech-to-speech better: the model's output prosody is discarded and replaced by a synthesizer's guess, so the emotional register of Raya's speech becomes a function of a text-to-speech model that cannot hear the user. Barge-in bookkeeping gets substantially harder, because the truncation offset now has to be computed against our synthesizer's playout and then translated back into the model's text timeline. Cost goes up rather than down. The route is documented in Appendix E for completeness and it is not recommended.

**Accepting the preset permanently is the third route** and it is a legitimate product decision if the other two prove expensive. Voice identity matters less than voice *behaviour*: users form attachments to how something responds to them far more than to its timbre. Raya's distinctiveness at launch comes from what she knows, what she remembers, and what she is willing to do, and those are not purchasable from a vendor.

## 5.6 Cost mechanics of a realtime session

The per-minute figures used throughout this document decompose into three layers.

| Layer | Per voice-minute | Notes |
| :--- | ---: | :--- |
| Realtime model, `gpt-realtime-2.1` | ~$0.054 | Audio in and out plus re-billed cached history; rises with session length |
| Transport | ~$0.0025 | LiveKit participant minutes plus Cloud Run for `raya-mf` and the sidecar |
| Reasoning delegate | ~$0.0005 | Roughly 1.33 calls per minute on a cached prefix |
| **All-in** | **~$0.057** | |

Three observations govern how these numbers should be treated.

The realtime layer dominates by an order of magnitude, so effort spent optimizing transport or delegation is effort misspent. **Four optimizations move the dominant term** — the instruction budget, cache discipline, uplink gating and compaction aggressiveness — and Section 5.8 consolidates them into a sequenced programme with the two risk-free ones first.

The figure is an average across a session-length distribution, not a constant. It should be re-derived from measured sessions during alpha rather than trusted, and Appendix D specifies the session simulator that produces it. If the measured average diverges from this figure by more than fifteen percent, the tier allowances in Part X move rather than the architecture.

The delegate being two orders of magnitude cheaper than the voice model is what licenses everything in Part VI. At half a tenth of a cent per minute, being wrong about whether a delegation was needed costs essentially nothing, and that is an unusual freedom.

## 5.7 Vendor risk and the exit plan

We have made our most important component someone else's. The risks are concrete and each has a specific response.

**Price increase.** The response is `cascade-v1`, which is maintained at production quality permanently and costs roughly a tenth as much per minute. It is worse, and having it means a price change is a product decision rather than an emergency. The conformance suite's cost-declaration test keeps its economics honest.

**Capability regression or deprecation.** Model versions are pinned explicitly, never floating. A vendor deprecation notice starts a migration with a known deadline rather than a surprise.

**Outage.** Part XII specifies the ladder. The short version is that a cross-engine snapshot prefill lets a live session degrade to the cascade mid-conversation rather than dropping, which is a capability the semantic-snapshot design gave us as a side effect.

**Policy change on data handling.** A zero-retention agreement is a launch gate in Part IX, not a nice-to-have, and the engine descriptor's `DataRetention` field is enforced by admission control. If the vendor's posture changes, the enforcement point already exists.

**Strategic conflict.** OpenAI may ship a personal finance assistant. This is the risk with no technical mitigation, and the honest response is that our defensibility was never the voice model. It is the bank connection, the memory, the action layer and the audit trail, none of which a horizontal assistant is positioned to build.

## 5.8 The token efficiency programme

Sections 5.1, 5.3, 6.5 and 4.10 each specify a mechanism that reduces what a voice-minute costs. They are written where they belong architecturally, which means nobody reading any one of them sees the size of the opportunity or the order in which the work should be done. This section is the consolidated view, and it exists because "reduce voice cost" is the kind of instruction that gets executed badly when it arrives without a definition of done.

**The realtime layer is 95% of the per-minute cost** — $0.054 of $0.057, per Section 5.6 — so this programme is the only cost work on the voice path worth staffing. Transport and delegation optimisation are rounding errors and should be declined.

**The prize, and the floor.** At 5,000 subscribers the blended voice spend is roughly **$27,000 a month**: 231 minutes of blended cap allowance, 30% utilisation, at about eight cents a minute. A 10% improvement is **$2,700 a month, roughly $32,000 a year**, and first-pass gains in this area are usually larger than 10%. Separately and much smaller, `Eden-Accounting-and-Unit-Economics.md` §5.7a records that a **1.0% reduction in Pro's worst-case delivery cost** — under 2% of its voice line — turns the one negative cell in the financial model positive. That cell is worth at most $131 a month and is not the reason to do this work; it is a threshold this programme clears incidentally on its first day.

### The four levers, in the order they should be pulled

| # | Lever | Mechanism | Risk to product | Sequence |
|---|---|---|---|---|
| 1 | **Instruction budget** | 600-token ceiling on the system instruction, asserted in CI (§5.1) | **None** — structural | Do first |
| 2 | **Cache discipline** | Byte-stable prefix ordering so cached-input rates apply (§6.5, extended below) | **None** — structural | Do first |
| 3 | **Uplink gating** | Stop transmitting audio during long silence, with pre-roll and hangover (§4.10) | **Real** — clipped onsets, hung turns | Behind measurement |
| 4 | **Compaction budget** | Compact on a token-per-session-minute target rather than on context pressure (§5.3) | **Real** — Raya forgets | Behind measurement |

**The first two are free and should ship before anyone argues about the others.** A token ceiling and a stable prefix ordering cost a day of work between them, carry no product risk, and cannot degrade an experience because they change nothing a user can perceive. They are also the levers most likely to be quietly undone later, which is why both are specified as automated assertions rather than as conventions.

**Cache discipline extends to the realtime session, not just the delegate.** Section 6.5 establishes the warm prefix for delegation and the discipline that the prefix must be immutable for the life of the session. The same rule governs the Realtime session's own accumulated context: cached-input rates apply only to content the vendor has seen in exactly the same position, so anything that rewrites earlier context — re-injecting a refreshed balance ahead of existing history, reordering injected material, regenerating the instruction — silently forfeits the discount on everything after the edit and surfaces no error. **Injected content is therefore append-only within a session**, corrections are expressed through `ContextItem.Supersedes` rather than by mutation, and `TTL` expiry appends an invalidation rather than removing the item. Section 3.2 specifies the mechanism and Section 3.8 asserts it, because this is the single most expensive mistake available in this part of the system precisely because it looks like tidiness.

**The second two are tuning, and tuning against production data rather than intuition.** Both change what Raya hears or remembers, both have a setting that saves money and ruins the product, and neither has a correct value that can be derived in advance. They ship behind the measurement in Section 11.2 and move in increments.

### The risk, stated plainly

**Two of these four levers can damage the product if they are done carelessly, and the damage is of a kind that does not raise an error.**

**Trim the conversation history too aggressively and Raya starts forgetting what someone told her ten minutes ago.** That is precisely the failure that makes an assistant feel stupid, and it is worse for Eden than for a general assistant because the forgotten thing is likely to be something personal that the user found difficult to say. Section 5.3's argument that aggressive compaction *forms memory* rather than destroying it holds only while the memory extraction pass is actually capturing what the summary drops. If extraction quality falls behind compaction aggressiveness, the mechanism inverts from an advantage into the most damaging bug in the system, and it will present as "Raya seems less attentive lately" rather than as an incident.

**Tune the silence handling too aggressively and she cuts people off mid-sentence**, or worse, stops responding because the engine never received the silence it needed to close the turn. For a product built on emotional steadiness, being interrupted while working up to saying something hard is a worse outcome than any margin gain is worth. A person deciding whether to admit how much debt they are carrying pauses before they say it, and that pause is the moment the gate must not close.

**So this is careful tuning with quality checks, not a switch to flip.** The correct framing is ongoing cost work with a permanent owner and a measurement cadence, not a one-week optimisation sprint that is declared done. Neither lever 3 nor lever 4 ships without the corresponding quality indicator in Section 11.2 already reporting, and both move in increments with a rollback that is one config change rather than one deploy.

**The governing rule when the two are in tension: the quality indicator wins.** If gating or compaction improves cost while moving semantic retention, truncation accuracy, or word-onset recognition outside their objectives, the setting reverts and the saving is forgone. A cheaper Raya who feels less present is not a cheaper Raya; she is a different and worse product that happens to have a better gross margin, and the tier allowances in Part X exist so that cost can be controlled by what we sell rather than by degrading what we deliver.

---

# Part VI: The Delegation Plane

## 6.1 What delegation is for

The voice model is fast, present, and ignorant. The delegate is slower, absent from the conversation, and knows everything. Delegation is the mechanism that lets a user experience the first while receiving the second, and getting it right is what separates a voice interface from a voice product.

The contract is narrow by design. The voice model may ask a question. It may not decide what is true, execute a tool, mutate anything, or reason about the user's money. The delegate answers, and the answer arrives as injected context that the voice model renders in its own voice. Everything that could be wrong about a number is decided on the asynchronous plane, where it can be checked, audited and reversed.

## 6.2 Data classes

Every delegation carries a data class, and the class determines which providers may serve it. This exists because a registry that routes purely on capability will eventually send a user's transaction history to whichever host was cheapest that week.

**Class A — no user data.** Narration phrasing, intent classification over redacted text, formatting decisions, tone selection. Nothing identifying and nothing financial crosses the wire. Any registry provider may serve Class A.

**Class B — user data.** Balances, transactions, goals, plan contents, memories, anything derived from a Plaid connection or written by the user. Only providers with a signed data processing agreement and contractual zero data retention may serve Class B. Part IX makes that verification a gate rather than a preference.

The class is assigned by the orchestrator from the request payload, not declared by the caller, because a caller that can declare its own class will eventually declare wrongly.

## 6.3 The reasoning registry

Four entries, selected per request by intent and filtered by data class. All are OpenAI wire-compatible, so a registry entry is a base URL, a model string, and a set of capability flags.

| Tier | Model | Provider | In / cached / out per 1M | Data class | Used for |
| :--- | :--- | :--- | ---: | :--- | :--- |
| Economy | `deepseek-v4-flash` | Fireworks, US-pinned | $0.14 / $0.028 / $0.28 | A, and B on verification | The voice-path default. Classification, entity extraction, retrieval formulation, single-tool lookups, narration guidance |
| Standard | `MiniMax-M2.7` | Fireworks or Together, US | $0.30 / $0.06 / $1.20 | A, and B on verification | Multi-tool orchestration, transaction analysis, comparative questions |
| Standard, verified | `glm-5.1` | DeepInfra, US | $1.05 / $0.205 / $3.50 | A and B | The Class B default until other providers are verified. MIT weights, top-decile agentic scores, documented zero retention with SOC 2 and ISO 27001 |
| Premium | `deepseek-v4-pro` | Azure AI Foundry, Data Zone | $1.74 / $0.145 / $3.48 | A and B | Off-path work: plan drafting, scenario modelling, multi-step agentic tasks. Never called from the voice path |

Two properties of this table matter more than the specific models in it.

**Provider is a separate axis from model.** The same model served by different hosts differs by an order of magnitude in latency, and by a factor of two in price. GLM-5.1 measures 0.23 seconds to first token on Friendli and 9.50 seconds on the vendor's own endpoint. Treating "which model" and "which host" as one decision would make that variance invisible.

**Every entry is replaceable and none is load-bearing.** The registry lives in `AppRuntimeSetting` alongside the engine routing policy, and adding a model is a row rather than a deploy. The specific names in this table will be stale within two quarters and that is expected.

## 6.4 Two findings that constrain how the delegate is called

**Reasoning mode destroys time-to-first-token.** DeepSeek V4-Flash measures 1.21 seconds to first token with thinking disabled and 13.72 seconds at high reasoning effort, on the same endpoint, with the same input. Every model in the registry ships with thinking enabled by default. Anything on the voice path must therefore run with reasoning explicitly disabled, and this is a hard rule rather than a tuning preference. Work that genuinely requires deliberation runs off the voice path against the premium tier, with the narration ladder covering the gap and the result frequently arriving as an injected update rather than as an answer to a waiting question.

**Never call a vendor's own endpoint from the voice path.** The latency spread across hosts is larger than the spread across models. Registry entries name a Western host with measured time-to-first-token, and a vendor-direct endpoint may appear in the registry only as a Class A fallback.

## 6.5 The warm prefix

The delegate's cost advantage comes almost entirely from prompt caching, and prompt caching only pays if the prefix is genuinely stable.

At session establishment, `raya-api` issues a priming call that establishes the cached prefix: the Raya system prompt, the user's durable memories, active goals, plan titles, and a grounded financial summary. This runs concurrently with session setup and must never block it. Every subsequent delegation in that session reuses the prefix and bills only the conversational delta at the cache-hit rate, which on the economy tier is $0.028 per million against $0.14 — a factor of five, and against DeepSeek's vendor-direct cached rate of $0.0028, a factor of fifty.

The prefix must therefore be treated as immutable for the life of the session. Anything that changes mid-conversation — a balance that just refreshed, a goal the user created two turns ago — goes in the delta, not the prefix. An implementation that rebuilds the prefix when state changes will silently lose the cache and multiply delegate cost by five without any error surfacing. A cache-hit-rate metric is a required service-level indicator for exactly this reason, and a sustained drop below eighty percent is an alert.

## 6.6 Reactive and speculative delegation

Reactive delegation is the obvious mechanism: the voice model calls the delegation function, the orchestrator answers, the result is injected. It is correct and it is what runs most of the time.

Speculative delegation is the interesting one, and it exists because our delegate costs half a tenth of a cent per voice-minute. At that price, being wrong is nearly free, which makes it rational to start work before anyone has asked for it.

The trigger is a hint rather than a request. The orchestrator watches the partial transcript stream and fires a speculative delegation when the conversation makes a particular need likely: a named entity that resolves to an account or a merchant, an interrogative opening about a quantity, a reference to a time period, a prosodic marker of concern paired with a financial noun. Each hint carries `Speculative: true`, and the resulting work is cancellable without penalty.

Three rules keep this from becoming a cost leak or a correctness hazard.

**A speculative result is injected only if the model actually asks.** Otherwise it expires unheard. Injecting unrequested answers would produce a Raya who volunteers numbers nobody wanted, which is both irritating and a privacy problem when someone else is in the room.

**Supersession cancels.** When the conversation moves past the hint, the in-flight call is cancelled and its cost is recorded as waste. Waste is a tracked metric, not an accepted invisible loss.

**Speculative spend is capped as a fraction of delegate spend,** defaulting to forty percent, enforced per session. Above the cap, speculation stops and the session falls back to purely reactive behaviour for its remainder.

The payoff is that a meaningful fraction of delegations complete before they are requested, which converts a 1.2-second p50 into an immediate answer. There is also a second-order benefit: a speculative call warms the provider's cache for the reactive call that may follow, so even a wasted speculation makes the next real one faster.

OpenAI's published design is reactive only. This is the clearest example in the document of an architectural advantage that follows directly from a cost structure rather than from cleverness.

## 6.7 The narration ladder

When delegation is slow, something has to happen in the conversation. OpenAI's account says the model "briefly keeps the exchange moving," which is correct and underspecified. Narration is a product surface and it deserves a specification.

The ladder is latency-adaptive. Each rung is reachable from the one before without contradiction, so a delegation that escalates through all of them produces a coherent stretch of speech rather than a sequence of unrelated fillers.

| Elapsed | Behaviour |
| :--- | :--- |
| 0–400 ms | Say nothing. This is within human conversational range and filling it makes Raya sound nervous |
| 400–1200 ms | A minimal acknowledgement in Raya's own words. Not a fixed phrase — a fixed phrase becomes a tic within a week |
| 1200–2500 ms | A substantive holding statement that names what is being fetched. "Let me pull last month's card statements" tells the user the request was understood, which is most of what the anxiety of waiting is about |
| 2500–5000 ms | A progress statement with an honest cause where one is known, plus an offer to continue. "The bank connection is being slow — want to keep going and I'll bring it up when it lands?" |
| Beyond 5000 ms | Abandon gracefully and move the work asynchronous. "I can't get to it right now. I'll put it in your thread so it's there when you look." The delegation continues and its result is written to the thread |

Two invariants govern every rung. **Narration may never assert content it does not have** — no "it looks like you spent about four hundred" while the query is still running, because a guess spoken in Raya's voice is indistinguishable from a fact to the person listening. And **the ladder is driven by measured elapsed time, not by predicted latency**, because a prediction that is wrong in the optimistic direction produces exactly the silence it was meant to prevent.

The guidance for each rung is generated by the economy tier as a Class A request, so it adapts to the conversation rather than reading from a phrase list, and it costs essentially nothing.

## 6.8 Deadlines, failure, and honesty

Every delegation carries an explicit deadline derived from its urgency. Expiry produces a defined conversational outcome and never a hang.

A delegation that fails — provider error, tool failure, permission denial, timeout — produces an injected context item describing the failure in terms Raya can speak, not an error code. The distinction matters: "I can't reach your bank right now" is a sentence a person can respond to, and a silent absence is not. Part XII specifies the retry and fallback behaviour, including cross-provider retry, which is straightforward here precisely because every registry entry speaks the same wire protocol.

The one failure mode with no acceptable graceful degradation is a wrong number stated confidently. Where the orchestrator cannot ground an answer in retrieved data, the injected result says so explicitly and the policy directive forbids the voice model from filling the gap. Raya saying "I am not sure, let me check properly" is a good outcome. Raya inventing a balance is not a degraded outcome; it is a product failure and Part IX treats it as a safety issue rather than a quality one.

---

# Part VII: Turn Reconstruction and the Transcript

## 7.1 Continuous speech does not have turns

Everything downstream of voice — the memory pipeline, the thread UI, the audit log, the evaluation harness, the billing record — is built on the assumption that a conversation is a sequence of discrete messages with an author, a body and an order. Continuous speech provides none of those. It provides overlapping streams, revisable partial transcripts, utterances that are abandoned halfway, backchannels that are not turns, and assistant speech that was cut off before the user heard it.

Turn reconstruction is the component that converts one into the other. It runs entirely on the asynchronous plane, it is allowed to be slow, and it is the sole authority on what the conversation *was*.

## 7.2 Two views, deliberately

The system maintains two transcripts and does not attempt to reconcile them in real time.

The **speculative view** is what the user sees. It is assembled from partial transcript events as they arrive, updates optimistically, and revises in place when the recognizer changes its mind. It is fast, it is wrong sometimes, and being wrong is acceptable because the user is watching their own words appear and can see the correction happen. Unstable text is rendered visually distinct from stable text so that revision reads as the system thinking rather than as the system malfunctioning.

The **authoritative view** is what the system believes. It is assembled from final transcript events, speech boundary events, truncation offsets and delegation records, it lags the conversation by a second or two, and it is the only view that memory formation, audit, billing and evaluation are permitted to read. Nothing consumes the speculative view except the screen.

Keeping these separate is what allows the interface to feel immediate without the record being unreliable. Systems that maintain one view end up either rendering slowly or storing guesses, and storing guesses in a financial product is the worse of the two failures.

## 7.3 Reconstruction

The reconstructor consumes the event stream and maintains a small state machine per speaker.

A user turn opens on `speech.user.start` and closes on `speech.user.end`, with the body assembled from final transcript events falling within the interval. An assistant turn opens on `speech.assistant.start` and closes on either `speech.assistant.end` or `speech.assistant.truncated`.

Four rules resolve the cases that make this non-trivial.

**Backchannels are not turns.** A `speech.backchannel` event annotates the surrounding turn rather than opening one. A transcript in which "mm-hm" appears as its own message is unreadable and pollutes every downstream consumer.

**Overlap is recorded, not flattened.** When `speech.overlap.start` fires, both turns retain their true timestamps and the overlap interval is stored as metadata. The thread UI renders them sequentially because a chat interface has no way to show simultaneity, but the underlying record does not lie about it, and the evaluation harness in Part XI reads the true timing.

**Truncated assistant turns store what was heard, not what was generated.** The truncation offset from Section 4.6 determines where the stored body ends, and the discarded remainder is retained in a separate field for debugging rather than in the message body. This is what keeps the stored transcript in agreement with the model's own corrected context. If these two ever disagree, the memory pipeline will form memories about things the user never heard, and that is a class of error that compounds silently across sessions.

**Abandoned utterances are marked, not deleted.** A user who starts a sentence, stops, and starts a different one produces two turns, the first flagged abandoned. Memory formation ignores abandoned turns; evaluation does not, because abandonment rate is a quality signal.

## 7.4 Storage

Voice conversations reuse the existing `RayaThread` and `RayaMessage` tables rather than introducing a parallel schema. A voice message is a message with a channel discriminator, timing metadata, and references to its audio artefacts where retention policy permits them. This is deliberate: a user who speaks to Raya on Monday and types to her on Tuesday is in one conversation, and building a separate voice thread would make cross-surface continuity a synchronization problem instead of a non-issue.

The additions to the message record are a channel field, start and end offsets against the session clock, a truncation offset where applicable, an overlap interval where applicable, a prosody summary, and a reference to the delegation records that informed the turn. The delegation records themselves are stored separately and carry their own latency, cost, provider and cache-hit metrics, which is what makes Part X's economics measurable rather than modelled.

Audio retention is governed by Part IX and defaults to not retaining audio at all.

---

# Part VIII: The Raya Action Layer

## 8.1 The voice model cannot act

The single most important sentence in this part: **the voice model may request an action and may never perform one.** Every mutation crosses the asynchronous boundary, passes the permission gate, executes in the orchestrator, and returns as a result. There is no fast path, no read-only exemption, and no category of action considered harmless enough to skip the gate.

This is not defensive engineering for its own sake. A speech-to-speech model in a room with a television, a second person, or a poor microphone will occasionally hear things that were not said. In a general assistant that produces an amusing non-sequitur. In a product connected to someone's financial life it produces a change they did not ask for, and the only structural defence is that the model is never the thing that makes the change.

## 8.2 The four-tier gate

`Raya-Technical-Architecture.md` §6 defines a three-tier permission model for text. Voice adds a fourth tier and voice-specific rules for the existing ones, because the absence of a screen changes what confirmation means.

**Tier 0 — Read.** Balances, transactions, goals, plans, calculations, search. Executes without confirmation. The overwhelming majority of voice traffic is here, and it should feel frictionless.

**Tier 1 — Reversible write.** Categorizing a transaction, renaming a goal, adding a note, adjusting a non-binding target. Executes immediately, is announced in the response rather than confirmed in advance, is written to the undo ledger, and is reversible by voice for the remainder of the session and by screen for the whole of the ledger's retention window. Asking permission before every small change makes a companion exhausting; making every small change reversible achieves the same safety with none of the friction.

**Tier 2 — Consequential write.** Changing a plan's structure, altering a contribution schedule, modifying a budget envelope, anything a user would be unhappy to discover unannounced. Requires explicit confirmation before execution. Voice confirmation is permitted subject to Section 8.3, and the confirmation must restate the action in specific terms — the amount, the target, the effective date — rather than asking "shall I go ahead?", because a user who mis-heard the proposal will agree to the wrong thing with equal enthusiasm.

**Tier 3 — External or irreversible.** Anything that touches a third party, moves money, changes a credential, alters a Plaid connection, or cannot be undone by us. **Never confirmable by voice.** Raya may stage the action and explain it, and the user must complete it on screen. This tier exists because the failure modes of voice — mishearing, bystanders, replayed audio, an unattended device — are all survivable when the worst outcome is a reversible edit and none of them are survivable when the worst outcome is a transfer.

## 8.3 When voice confirmation is allowed

Tier 2 confirmation by voice requires three conditions simultaneously, and the absence of any one demotes the action to on-screen confirmation.

The session must be **foreground and attended** — the client reports that the application is in the foreground with the screen on, which is a weak signal but a real one, and it distinguishes a deliberate conversation from an ambient session running in a pocket.

**Speaker verification must pass.** A voiceprint enrolled at setup is checked against the confirming utterance. This is not authentication in the security sense and the document should not overclaim it: voiceprints are spoofable, and the check exists to defend against the realistic threat, which is a housemate or a child in the room rather than an attacker with a recording. Tier 3 is where the real defence lives.

**The confirmation must be responsive rather than volunteered.** A "yes" arriving within a bounded window after Raya's specific restatement counts. A "yes" arriving in the middle of unrelated speech does not, no matter how clearly it was heard.

Ambient and wake-word sessions are held to a stricter standard: on those, Tier 2 also requires on-screen confirmation, because the whole premise of ambient listening is that the user was not paying attention when the session started.

## 8.4 The undo ledger

Every Tier 1 and Tier 2 action writes an inverse operation to a per-user ledger at the moment it executes. The ledger stores the action, its parameters, the inverse operation, the session and turn that produced it, and the permission decision that allowed it.

"Raya, undo that" resolves to the most recent reversible action in the current session and executes its inverse, and Raya states what she reversed rather than merely confirming. Undo by screen reaches further back, bounded by a retention window rather than by the session.

The ledger is not primarily a convenience feature. It is what makes Tier 1 safe enough to execute without confirmation, and Tier 1 executing without confirmation is what makes voice feel like talking to someone competent rather than filling in a form. The whole friction budget of the interaction depends on reversibility being real, which means the inverse operations must be tested as rigorously as the forward ones. An undo that silently fails is worse than no undo, because the user has already been told the change was reversible.

## 8.5 Two tool catalogs

The voice model gets a small in-session function catalog. The orchestrator holds the full registry.

The in-session catalog contains one delegation function and a handful of very high-frequency Tier 0 reads where the round trip through the orchestrator would be pure latency for no benefit. Everything else routes through delegation. Three reasons: a large in-session catalog costs tokens on every turn in a context that is re-billed as it grows, tool selection accuracy degrades as the catalog widens, and the orchestrator already performs routing with far more context than the voice model has.

The consequence worth noting is that adding a capability to Raya generally requires no change to the voice layer at all. A new tool is registered in the orchestrator and becomes reachable by voice immediately, because the voice model was only ever asking a question.

## 8.6 Cross-surface continuity

A conversation that begins by voice continues by typing, against the same thread, the same memory, and the same plan objects. Actions taken by voice appear in the activity feed with the same shape as actions taken on screen, distinguished by channel rather than segregated by it. A staged Tier 3 action initiated by voice appears as a pending item the user can complete later.

This is unglamorous and it is one of the more durable advantages in the document. A general voice assistant is a surface; Raya's voice is a modality on a product that already has state. The work required to make that true is mostly the work of *not* building a parallel voice system, which is why the schema decision in Section 7.4 and the tool decision in Section 8.5 both matter more than they appear to.

---

# Part IX: Safety, Privacy and Data Residency

## 9.1 What is different about voice

Text is private by default and deliberate by default. Voice is neither. It is overheard by people who are not the user, it is misheard by the system, it happens while the user is driving or cooking or lying in the dark, and it invites action without a screen to check. Every safety property Raya already has needs re-examining under those conditions, and several need mechanisms that text never required.

This part is not a compliance appendix. Three of its provisions are launch gates.

## 9.2 The investment advice boundary

Raya does not give investment advice. In text this is enforced through the system prompt, the tool registry, and the orchestrator's output review. In voice it needs all of that plus a fourth layer, because voice output is generated by a model we do not control and cannot inspect mid-generation.

The enforcement is layered deliberately. The voice model's system instruction states the boundary as a hard refusal with examples, which handles the overwhelming majority of cases. Any delegation whose intent classifier flags advice-adjacent content returns a `ContextPolicy` item that constrains what the model may say, injected before the answer rather than after it. The orchestrator refuses to ground answers it should not ground, so the model has nothing specific to be wrong with. And the authoritative transcript is scanned asynchronously for boundary violations, feeding both an alerting path and the evaluation corpus.

The fourth layer is the one that matters most in practice, because it is the only one that tells us when the first three failed. A boundary that is enforced but not measured is a boundary that erodes.

## 9.3 Who is speaking, and who is listening

Two distinct problems hide under "voice security," and conflating them produces bad design.

**Who is speaking** is the authorization question, and Part VIII answers it: voiceprint verification gates Tier 2 confirmation, and Tier 3 is never confirmable by voice at all. The document is deliberately modest about what voiceprints achieve. They are a reasonable defence against a housemate, a child, or a colleague, and they are not a defence against a determined attacker with a recording. The architecture is designed so that voiceprint failure is survivable, which is the only honest way to use a spoofable signal.

**Who is listening** is the disclosure question and it has no technical solution. Raya will state balances aloud in rooms containing other people, and the user is the only party who knows whether that is acceptable. The design gives them control rather than pretending to make the judgement for them: a per-session discretion mode that suppresses specific figures in favour of qualitative statements, a persistent preference for users who are usually not alone, and a default on ambient sessions of qualitative-first, because ambient sessions are exactly the ones where the user was not thinking about who was in the room.

## 9.4 Ambient listening

Ambient listening is a Pro-tier capability and it is the highest-risk surface in the product. Four constraints are non-negotiable.

Wake-word detection runs **entirely on device**, and no audio leaves the device before the wake word fires. This is a public claim and it must be literally true, including in the buffer that provides pre-roll context.

There is an **unmistakable indication** that a session is live, at the operating-system level where the platform provides one and in the application where it does not. A user must never be uncertain whether Raya is listening.

**Ambient sessions are demoted for authorization.** Tier 2 requires on-screen confirmation, and discretion mode defaults on.

**Ambient sessions are subject to the same spend ceiling** as any other, and the ceiling is checked at wake rather than only at session start, so an ambient session cannot quietly consume a month's allowance.

## 9.5 Data residency: the legal position

Voice audio at launch is processed in the United States by OpenAI, and transported through LiveKit Cloud's US region. Neither vendor offers Canadian processing for this workload: LiveKit's region pinning covers ten regions and Canada is not among them, and the Realtime API is US-served. This is a constraint we discovered rather than chose, and the question is whether it is lawful and whether it is right.

**PIPEDA permits it with disclosure.** Canadian federal privacy law does not require personal information to remain in Canada. It requires that an organization transferring personal information to a third party for processing use contractual or other means to provide a comparable level of protection, and that individuals be notified that their information may be processed in a foreign jurisdiction and may be accessible to that jurisdiction's authorities. The Office of the Privacy Commissioner has addressed this directly in the financial context and did not find cross-border processing objectionable in itself. Our obligations are therefore a data processing agreement with meaningful protections, and plain-language disclosure that is actually findable rather than buried.

**Quebec's Law 25 requires an assessment, not a prohibition.** Before communicating personal information outside Quebec, an organization must conduct and document a privacy impact assessment considering the sensitivity of the information, the purposes, the protections including contractual ones, and the legal regime of the destination. This is a document we must produce and maintain, not a barrier. Financial information is sensitive, which raises the standard of the assessment rather than changing the answer.

**OSFI B-13 does not apply to us.** It governs federally regulated financial institutions. Eden is not one. It may become relevant if we ever partner with one, and designing as though it might is prudent, but citing it as a binding constraint today would be wrong.

The conclusion is that US processing is lawful, that it requires three artefacts — a data processing agreement with zero data retention, a documented Law 25 transfer assessment, and honest disclosure in the privacy policy and at the point of enabling voice — and that all three are launch gates rather than follow-up work.

**The path to Canadian processing is nevertheless kept open and named.** Two routes exist. Azure Voice Live, per Section 5.5, may offer a Canadian or North American data zone for the same models, which would resolve residency and voice identity together. And `cascade-v1` is entirely self-hostable, which means a Canadian deployment is achievable on short notice at a quality cost we have already measured. The commitment in the document is not that we will be Canadian-resident at launch; it is that we will never be in a position where becoming Canadian-resident requires a rewrite.

## 9.6 Retention

**Audio is not retained by default.** Frames are processed and discarded. The authoritative transcript is retained under the existing thread retention policy, and audio artefacts are stored only where the user has explicitly opted in for a specific purpose, such as contributing to the evaluation corpus.

**Voiceprints are stored as templates, never as audio**, in a separate store with its own access control, and are deleted with the account.

**Prosody data is retained in summary form** against the transcript and not as raw acoustic features, because raw features are re-identifying and their analytical value does not justify the exposure.

**The compaction memory pass is bounded by policy.** It may write facts, preferences, commitments and emotional context. It may not write inferred health conditions, inferred immigration status, inferred sexual orientation, or anything else in a special category, regardless of how clearly the conversation implied it and how useful it would be. This rule lives in the memory formation prompt and is tested against an adversarial corpus, because a memory system that is good at inference is a memory system that will infer things it should not.

**Zero data retention with the model vendors is a gate.** No production financial conversation runs through a provider without a contractual zero-retention posture, and the engine and registry descriptors carry a `DataRetention` field that admission control enforces. DeepInfra's posture is documented; OpenAI's, Fireworks' and Together's require confirmation before those paths carry Class B traffic.

## 9.7 Launch gates

Three items in this part block launch rather than following it. A signed data processing agreement with zero data retention covering every provider that will see Class B data. A completed and documented Law 25 transfer assessment. And disclosure language, reviewed, that appears both in the privacy policy and at the moment a user first enables voice — not only in the policy, because nobody reads the policy and the point is that the user actually knows.

---

# Part X: Tiering, Entitlement and Unit Economics

The live model behind this part is `docs/models/raya-pricing-model.canvas.tsx`. Numbers here are the August 2026 snapshot; the canvas is the thing to re-run when an input changes.

## 10.1 The principle

**The same voice engine runs on every paid tier.** Tiers differ in how much Raya a subscriber gets and in what she is permitted to do. They never differ in how good she is.

This is a product decision with a financial justification rather than the reverse. Raya's warmth, her restraint at the advice boundary, and her instruction-following are what people are paying for, and a subscriber on the entry tier meeting a duller Raya than one on the top tier is a churn event dressed up as segmentation. The flagship costs about $0.057 per voice-minute against about $0.023 for the mini variant. On a 60-minute Basic allowance fully consumed that is a difference of roughly two dollars a month, against a tier that contributes about twelve at expected usage. Buying the consistency is the cheapest brand insurance available.

Differentiation happens on capability, which is where it belongs. Basic subscribers converse freely and read everything; mutations are staged and confirmed on screen. Plus adds the wake word, spoken confirmation for reversible actions, cross-session memory and longer sessions. Pro adds ambient listening, full action parity, an inbound number, priority handling and the longest retention.

## 10.2 Cost per voice-minute

| Layer | Per minute | Share |
| :--- | ---: | ---: |
| Realtime model, `gpt-realtime-2.1` | $0.0540 | 95% |
| Transport — LiveKit participant minutes, Cloud Run for `raya-mf` and the sidecar | $0.0025 | 4% |
| Reasoning delegate — ~1.33 calls per minute on a cached prefix | $0.0005 | 1% |
| **All-in** | **$0.0570** | |

The concentration in the top line is the operative fact. Ninety-five percent of voice cost is a vendor invoice we do not control, which means the only meaningful cost levers are session length, compaction aggressiveness per Section 5.3, and the engine choice itself. Optimizing transport or delegation is optimizing four percent.

## 10.3 Tiers

Prices in Canadian dollars, costs in US dollars at 1.37 CAD/USD, contribution at the 30% utilisation typical of voice products.

| Tier | CAD/mo | Annual | Voice allowance | Spend ceiling | Revenue | Contribution at 30% | Margin | Contribution at full allowance | Margin |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Basic | $25 | $275 | 60 min | $3.93 | $18.25 | $11.84 | 65% | $8.01 | 44% |
| Plus | $49 | $539 | 240 min | $15.73 | $35.77 | $27.11 | 76% | $13.54 | 38% |
| Pro | $99 | $1,089 | 600 min | $39.33 | $72.26 | $53.26 | 74% | $19.36 | 27% |
| Pro Max — later | $249 | $2,739 | 1,500 min soft | $98.33 | $181.75 | $138.78 | 76% | $59.43 | 33% |

Contribution is net of the voice cost, Plaid, text AI, support, and Stripe at 3.6% plus CA$0.30 — the 3.6% being card processing at 2.9% plus Stripe Billing's 0.7% on recurring revenue, which is the fee most models forget. The Pro Max row uses estimated text-AI and support figures, since that tier is not in the live model, and **its pricing is provisional pending its own margin review** rather than settled the way the three launch tiers are.

**The allowances above were reduced from an earlier draft of 120 / 400 / 1,000 / 2,500 minutes.** The original ladder grew faster than the prices did, and the consequence was visible in the right-hand column: margin under full consumption fell from 56% on Basic to 28% on Pro Max, which meant the upper tiers were quietly carrying the usage risk for the whole product. The reduced ladder now holds full-consumption margin between roughly 44% on Basic and 27% on Pro, and it flattens the inversion rather than eliminating it. The allowances themselves are cost-derived and were not touched by the repricing; what changed underneath them is the revenue line. **Prices were reset so that every Eden tier sits below every ChatGPT tier that carries Plaid-connected personal finance** — ChatGPT Plus is CAD $27.40 and ChatGPT Pro is CAD $137 — because the entry point into a household's financial life cannot cost more than the general-purpose assistant the household already pays for. Thinner full-consumption margin is the deliberate price of being the cheapest serious option in the category, accepted with the tail risk understood rather than discovered later. The company's profitability floor moved with the prices and is now per tier rather than universal: **$4 on Basic, $6 on Plus and $10 on Pro, measured at the expected 30% utilisation** rather than at full consumption, which is the honest reading of a business where average behaviour pays for the tail. The earlier Basic breakeven counts — roughly eighteen hundred and fifty subscribers at expected usage and twenty-seven hundred and twenty-five at full consumption — were computed against the $38 price and need recomputation at $25 before they are quoted again. The full limit schedule, including bank connections, daily caps and abuse ceilings, lives in `Eden-Accounting-and-Unit-Economics.md` §4.2, which is the governing document for anything with a dollar sign in it.

The right-hand pair is the one to check the design against, because it is what happens when a subscriber consumes every minute they were promised rather than the 30% a typical one will. Every tier stays positive on contribution under full consumption, but no tier is comfortable there any longer: Basic holds 44%, Plus falls to 38%, and Pro compresses to 27%, which is the thinnest margin anywhere in the schedule. That is stated plainly because it is the number that governs how much of the allowance can be advertised without hedging, and because a 27% floor leaves little room for a vendor price increase to be absorbed silently. The residual compression toward the top is deliberate and bounded: Pro Max still carries the most usage risk, which remains a reason to defer it until the top-tier tail is observed rather than guessed, and its price is provisional until that review happens.

The spend ceiling adds one more layer of protection beneath these figures. Because it sits fifteen percent above the modelled allowance, it binds only if cost per minute runs at the top of that variance band, and in that stressed case contribution falls to $7.71, $11.50, $14.23 and $46.60 respectively. All four remain positive, which is the property that matters: there is no combination of full consumption and adverse cost within the modelled band that makes a subscriber unprofitable. The margin left over on Pro in that case is slim enough that it should be treated as the binding constraint on any future allowance increase.

Annual billing is priced at **eleven months for twelve**, an 8.3% discount, and the reason it is not the more familiar two months is worth recording here because it is a voice-economics finding rather than a pricing preference. The right-hand column above is the governing test: Eden bills no overage, so the price must survive a subscriber who consumes every minute. A two-month discount removes $4.17 of monthly revenue from Basic and $8.17 from Plus, and neither tier carries that much headroom over its per-tier net profit floor at full consumption. One month free clears the floor on Plus and Pro and leaves Basic short only at low subscriber counts, which is a scale problem rather than a pricing one. The derivation is in `Eden-Accounting-and-Unit-Economics.md` §5.7.

The smaller discount loses none of what annual billing is actually for. It still buys cash in advance, one payment charge instead of twelve, and a year in which churn cannot occur — and that middle item matters more than it first appears, because a card that only faces one authorisation a year is a card that fails eleven fewer times. Most of the churn that annual billing prevents is involuntary rather than voluntary. For a bootstrapped company with a refundable SR&ED cycle, that is worth considerably more than the discount costs.

Pro Max is specified but not launched. Add it when the top-tier usage tail is visible in real data, not before, because a fourth tier introduced without evidence mostly cannibalises the third.

## 10.4 The spend ceiling

The allowance a subscriber sees is minutes. The limit the system enforces is dollars.

This is the mechanism that makes a flagship model affordable on a $25 tier, and it is the reason the tail risk in Section 10.3 is bounded rather than open-ended. A minute-based limit is a proxy that breaks whenever cost per minute moves — a vendor price change, an unusually long session with heavy history re-billing, a shift in the session-length distribution. A dollar limit is the thing we actually care about, and it survives all three.

**The ceiling is derived from the allowance, never chosen independently of it.** It is the advertised minutes multiplied by the engine's declared `CostPerMinute` and then by a variance margin of 1.15. Getting this relationship wrong in either direction is a product failure rather than an accounting one. A ceiling below the allowance means we cut subscribers off before they have used what they paid for, which is the worst possible way to discover a modelling error. A ceiling far above it means the ceiling is not doing its job. Setting it fifteen percent above the modelled allowance means it binds only when a session genuinely costs more per minute than the model predicts — the tail case it exists for — and never in ordinary use. Because both inputs are declared properties rather than constants, changing the engine or the allowance recomputes the ceiling automatically, which is what stops the three numbers from drifting apart the way the two figures in the note below already did.

Enforcement lives in the existing `RetentionPolicyService`, extended with a voice spend ledger, and it operates at three points. **At admission**, a session is refused if remaining spend cannot fund a minimum viable session. **During the session**, the meter is decremented from `SessionStats` against the engine's declared `CostPerMinute`, and crossing the ceiling triggers a graceful wind-down: Raya says she is out of voice time for the month and offers to continue in text. **At compaction and handoff**, the projected cost of the remaining session is re-evaluated, because that is where long sessions become expensive.

The user never sees a dollar figure. They see a minutes allowance and a quiet indicator that appears only near the limit. A product whose purpose is relieving money anxiety should not put a meter in front of the person using it.

Note that this supersedes the conflicting figures in `Raya-Technical-Architecture.md` §5.7 and in `retention-policy.service.ts`. There should be one ceiling, expressed in one unit, read by one service.

## 10.5 The trial

With no freemium plan, the trial does the work a free tier would have done, so it should be generous in capability and short in duration.

Three days, card required, cancellable at any time, with full Plus-level capability including the wake word and twenty voice minutes. The point is to let someone feel the actual product rather than a deliberately crippled version of it. A trial costs roughly $3.05 CAD all-in, of which the Plaid connection is about two thirds — a bank Item is billed for the whole month regardless of how few days the trial runs, so trial cost is dominated by a fixed charge that three days does almost nothing to reduce. At the 40–60% conversion a card-gated trial should produce, that puts trial cost per acquired subscriber around six dollars, which is cheap enough that generosity in capability remains the right default even though the window is short.

Three days rather than fourteen is a deliberate trade. A short window concentrates the decision while intent is still high and removes the long dormant middle of a two-week trial where most abandonment silently happens. It costs some depth of evaluation, and the mitigation is onboarding: the first session has to reach a real, personal financial insight, because there is no second week in which to recover a weak first impression.

## 10.5.1 What happens after the trial, and after cancellation

An expired or cancelled subscriber drops to **read-only against our own cached snapshot** — balances, history and past Raya conversations all remain visible; no voice, no AI, no new syncs. **Thirty days later the Plaid Item is removed.**

The Item removal is the part that matters financially and it is easy to get wrong. Plaid bills the Transactions subscription monthly for as long as a valid access token exists, whether or not a single API call is made against it. A read-only state that leaves the connection alive is therefore not a free state — it is the full bank-data subscription, paid indefinitely, for data nobody is reading. Left unaddressed across a thousand lapsed subscribers that is a five-figure annual charge for nothing.

Read-only is still the right default over a hard lockout, because it keeps the value the subscriber built visible to them and their history intact, which is what makes return likely. Removing the Item at day thirty preserves that benefit and ends the bleed; a returning subscriber pays a single re-link of about thirty seconds. Full reasoning and figures in `Eden-Accounting-and-Unit-Economics.md` §3.3.

## 10.6 The operating cost base

Voice is one line in a larger bill, and the tier prices have to carry all of it. The table below is monthly operating cost excluding voice and text inference, split into two blocks because the two blocks behave differently and must not be added to the contribution figures in the same way.

The first block scales linearly with subscribers and is **already netted out of the contribution figures in Section 10.3**. It is reproduced here for visibility, not to be subtracted a second time.

| Per-subscriber line | 100 subs | 1,000 subs | 10,000 subs |
| :--- | ---: | ---: | ---: |
| Plaid | $85 | $850 | $8,500 |
| Stripe — 2.9% processing plus 0.7% Billing plus CA$0.30 | $165 | $1,654 | $16,537 |
| **Subtotal** | **$250** | **$2,504** | **$25,037** |

The second block is platform cost that does not scale one-for-one with subscribers. This is the block that contribution must cover, alongside salaries.

| Platform line | 100 subs | 1,000 subs | 10,000 subs |
| :--- | ---: | ---: | ---: |
| Google Cloud — Run, SQL, Redis, registry, secrets, observability, egress | $60 | $150 | $1,050 |
| LiveKit Cloud — SFU, participant minutes | $50 | $66 | $630 |
| Vercel | $20 | $24 | $60 |
| Stripe Tax | $0 | $120 | $270 |
| Resend, Sentry, PostHog, tooling | $0 | $79 | $324 |
| **Subtotal** | **$130** | **$439** | **$2,334** |
| **Combined total** | **~$380** | **~$2,943** | **~$27,371** |
| **Combined per subscriber** | **$3.80** | **$2.94** | **$2.74** |

Three things follow. **Google Cloud is not the cost problem** — it is a twentieth of the combined bill at a thousand subscribers, and effort spent optimizing it is misallocated. **Plaid and Stripe dominate**, running from roughly two-thirds of the bill at a hundred subscribers to over ninety percent at ten thousand; both are the largest levers available and both become negotiable at thresholds we will reach, Plaid at around $2,000 a month of spend and Stripe at around CA$80,000 a month of volume. And **the LiveKit line is small only because of the decision in Section 2.8** — metered as Agent sessions rather than participant minutes it would be roughly $900 at a thousand subscribers instead of $66, which would make it the second-largest platform line rather than a rounding error.

At a thousand subscribers on the 35% Basic / 50% Plus / 15% Pro mix, the model produces roughly **$48,100 of monthly revenue** and a gross margin of **61%** after voice, Plaid, Stripe and platform. Against a small team at $18,000 a month, breakeven falls at about **615 subscribers**; against the $27,500 lean operating base that the accounting model actually carries, it is about **940**, rising to roughly **1,130** once the phased compliance programme is included. The earlier estimate of 600 subscribers in this section was computed on the previous price schedule and no longer holds. `Eden-Accounting-and-Unit-Economics.md` §6 governs.

## 10.7 Tax position

Three facts materially change the picture for an Ontario CCPC and belong in any financial plan built on this document.

Ontario cut its small business rate to 2.2% effective 1 July 2026, giving a **combined federal and provincial rate of 11.2%** on the first $500,000 of active business income.

**SR&ED returns roughly 55 cents on every dollar of Canadian employee engineering salary** — the federal 35% refundable credit on salary grossed up by the 55% proxy overhead, plus Ontario's 8% refundable OITC, less tax on the credits in the following year. Canadian arm's-length contractors return roughly 29 cents; offshore contractors return nothing. This is a concrete argument for employing engineers in Canada, and the experimental work in this document — voice latency engineering, engine conformance, model routing — is far more defensible as experimental development than routine feature work is.

**HST is a pass-through rather than a cost**, provided we register and claim input tax credits on Google Cloud, Vercel, Plaid, Stripe and the rest. Registering voluntarily before the $30,000 threshold is worth more than the filing burden costs, precisely because the input tax credits on infrastructure are substantial. The federal digital services tax was retroactively repealed in March 2026 and is not a consideration.

At a thousand subscribers the combination produces a net monthly result in the region of $17,400 after tax and credit accrual, against roughly $12,400 pre-tax — the credits being larger than the tax. That figure assumes about 65% of the $18,000 team cost is qualifying Canadian engineering salary, which is the assumption most worth checking with an accountant before it is relied upon, because the whole of the swing from $12,400 to $17,400 rests on it.

## 10.8 What alpha must measure

Four numbers in this part are modelled rather than observed, and each one moves the tier design if it is wrong.

**Utilisation.** Thirty percent is an industry heuristic, not an Eden observation, and it drives everything. Measure the distribution, not the mean, because the tail is what the spend ceiling exists for.

**Cost per voice-minute against session length.** Section 5.3 predicts that it rises. Measure the curve and set compaction aggressiveness from it.

**Purchased audio ratio.** How much of a session's wall-clock time is actually transmitted upstream. This is the input to Section 5.8's gating estimate and it is entirely unmeasured today — the $32,000-a-year figure rests on an assumption about how much of a voice session is silence, and alpha is where that assumption becomes an observation. Measure it before building the gate, because it also determines whether the gate is worth building.

**Plaid cost per subscriber.** Plaid publishes no per-product pricing; $0.85 is built from third-party ranges and is the single largest unverified number in the model.

**Delegation rate and speculation waste.** These determine whether the delegate remains a rounding error or becomes a line item, and whether the speculation cap is set correctly.

---

# Part XI: Observability, Evaluation and Validation

## 11.1 Why voice is hard to measure

A text system either returned the right answer or it did not, and you can tell from the log. A voice system can return a perfect answer while feeling terrible, and it can feel excellent while quietly desynchronizing its own context. The failures that matter most here are the ones that produce no error: an interruption that arrives 300 ms late, a truncation offset that drifts, a narration rung that fires early, a handoff that loses a name.

OpenAI's published account is candid that their observability lagged their system and that this cost them. We have the advantage of knowing that in advance, so instrumentation is specified alongside the components rather than after them.

## 11.2 Service level indicators

Every one of these is measured per session, aggregated per engine, and broken out by client type, because a SIP call and a browser session fail differently.

| Indicator | Objective | Why it matters |
| :--- | :--- | :--- |
| Session establishment, tap to first frame | p95 ≤ 800 ms | The first impression, and the only latency the user attributes entirely to us |
| Response latency, user stop to first audio at ear | p50 ≤ 600 ms, p95 ≤ 1000 ms | The core experience metric |
| Barge-in cessation, speech onset to inaudible at the ear | p95 ≤ 100 ms | Below this, interruption feels responsive; above it, broken. Measured at the ear, per Section 4.6, not at the point publication stops |
| Truncation accuracy | p99 within one frame period of measured playout | The silent failure from Section 4.6 |
| Frame underrun rate | < 0.1% of frames | Earliest indicator of vendor degradation, usually minutes ahead of error rates |
| Delegation latency | p50 ≤ 1.2 s, p95 ≤ 2.5 s | Determines how far up the narration ladder sessions climb |
| Delegate cache hit rate | ≥ 80% | A drop means the prefix is being rebuilt and cost has quintupled silently |
| Narration rung distribution | ≥ 70% of delegations resolve at rung 0 or 1 | Rising rungs mean the delegate is slowing before anything else shows it |
| Speculative hit rate and waste | Hit ≥ 35%, waste ≤ 65% of speculative spend | Tunes the speculation trigger against real behaviour. Expressed against speculative spend rather than total delegate spend, because the 40% cap in Section 6.6 makes the latter framing satisfiable by doing nothing |
| Handoff seam | Zero audible gaps; semantic retention above rubric floor | Handoff is mandatory, so its quality is not optional |
| Session drop rate | < 0.5% | Excludes deliberate ceiling wind-downs |
| Spend meter accuracy | Within 5% of invoiced cost | If this drifts, the entitlement model is fiction |
| **Purchased audio ratio** | Track, no objective at launch | Purchased input seconds ÷ wall-clock session seconds. The direct measure of what gating saves, and the number that tells us whether Section 5.8's $32K/year estimate was real |
| **Gate-induced onset loss** | **0 clipped onsets per 1,000 turns** | Word onsets lost to a late gate open. A hard gate on lever 3 — any non-zero reading reverts the setting |
| **Turn commit failures after gate close** | **0** | The hung-conversation failure from Section 4.10. Means the hangover is shorter than the engine's silence threshold |
| **Realtime cache hit rate** | ≥ 80% | The session-context analogue of the delegate indicator above. A drop means injected content is being rewritten rather than appended (Section 5.8) |
| **Tokens per session-minute, by session length decile** | Flat or declining across deciles | The governing metric for compaction (Section 5.3). A rising curve is the compounding that Section 5.6 warns is invisible in the headline rate |
| **Semantic retention across compaction** | Above rubric floor, **checked before any compaction change ships** | The "Raya forgot" failure. Lever 4's hard gate, and the reason compaction aggressiveness is not a free parameter |

Two of these deserve emphasis because they are unusual. **Underrun rate is a leading indicator** and should page before error rate does. **Narration rung distribution is a latency metric wearing a product costume** — it captures the user-visible consequence of delegate slowness in a way that a percentile on delegation latency does not.

## 11.3 Deterministic frame replay

The most valuable piece of test infrastructure in this document is the ability to replay a recorded session frame by frame, at exact original timing, through the entire media plane, and get the same result every time.

This is what makes voice bugs tractable. A barge-in that fired late in production becomes a test case rather than an anecdote. A truncation drift becomes a regression test. An engine change becomes a diff over a corpus rather than a listening session and a shrug.

The harness feeds recorded frames into `raya-mf` against a mock or real engine, captures the full event stream and the output audio, and asserts against both. It runs in continuous integration over the corpus in Appendix C, and every conformance assertion in Section 3.8 is expressed through it. Building it early is the difference between a system that can be changed confidently and one that cannot.

## 11.4 Shadow traffic

Before any engine change reaches a user, it runs against real sessions in shadow: the production engine serves the conversation, and the candidate engine receives the identical input stream while its output is discarded. This gives us latency, cost, transcript quality and event-stream behaviour on real traffic with no user exposure.

Shadow is where the second reference ceiling earns its place. Running `dashscope-realtime` in shadow — never in production, per its residency pin — keeps "OpenAI is the best available" a measured claim rather than an assumption we stopped checking. Running `cascade-v1` continuously in shadow keeps the degradation path honest, because a fallback that is never exercised is a fallback that will fail when it is needed.

## 11.5 Evaluation

Automated indicators cover whether the system is working. They do not cover whether the conversation was any good, and for a companion product that is the more important question.

Evaluation runs against the corpus with a judge model and fixed rubrics, scoring dimensions that map to what actually goes wrong: whether Raya interrupted the user inappropriately, whether she waited too long, whether she asserted a number she did not have, whether her tone matched the emotional register of the conversation, whether the response would have been better as a question, whether the advice boundary held. Each dimension has a floor, and a regression below the floor blocks release regardless of what the latency numbers say.

Human evaluation is scheduled rather than ad hoc. A weekly sample of real sessions, listened to by someone on the team, catches the class of problem that judge models systematically miss — a Raya who is technically correct and subtly grating, or who has developed a verbal tic from a narration prompt that seemed fine in isolation.

---

# Part XII: The Failure Ladder

## 12.1 The principle

**Degrade in the conversation, never in silence.** Every failure mode in this system resolves to something Raya can say, because a user who hears an explanation can respond to it and a user who hears nothing assumes the product is broken.

The corollary is that dropping a session is the last resort rather than the default error path. The architecture provides three mechanisms that make this achievable: the semantic snapshot, which can be prefilled into a different engine than it came from; the registry, whose entries all speak one wire protocol; and the narration ladder, which already has a vocabulary for "this is taking longer than it should."

## 12.2 The ladder

| Rung | Condition | Behaviour | User experience |
| :--- | :--- | :--- | :--- |
| 0 | Healthy | Flagship engine, full capability | Normal |
| 1 | Delegate slow or a provider erroring | Cross-provider retry within the registry tier; narration ladder covers the gap | Slightly slower answers |
| 2 | Delegate tier unavailable | Fall back to the economy tier for Class B work on a verified provider; reduce speculation to zero | Answers are shallower; Raya asks more clarifying questions |
| 3 | Voice engine degraded — rising underruns, elevated latency | Widen the adaptive buffer, compact more aggressively, disable speculative delegation to reduce load | Marginally less responsive |
| 4 | Voice engine failing or unreachable | Snapshot the session, prefill into `cascade-v1`, continue mid-conversation | Raya sounds different and responds more slowly; the conversation survives |
| 5 | Cascade also unavailable | End the voice session with an explanation and hand off to text in the same thread with full context | "I'm having trouble with voice right now — I've put us back in the chat and I still have everything we talked about" |
| 6 | Total failure | Session ends with an explicit message; no silent drop | The user knows what happened |

Rung 4 is the one the architecture was designed to make possible, and it is worth naming what it costs. A mid-conversation cutover to the cascade loses the acoustic conditioning, changes the voice, and roughly triples response latency. It is a bad experience. It is a dramatically better experience than a dropped call in the middle of a conversation about whether someone can afford to leave their job.

## 12.3 Circuit breakers

Three breakers protect the system from failures that would otherwise cascade.

**Per-provider breakers on the registry** open on error rate or latency and route to the next entry in the tier. Because every entry speaks the same protocol, this is a base URL change rather than a code path.

**A global voice admission breaker** stops new session establishment while allowing existing sessions to continue. This is the correct response to vendor capacity problems: degrading everyone is worse than admitting fewer people, and a user who cannot start a session and is told why is in a much better position than a user whose session collapses mid-sentence.

**A spend breaker** halts voice admission when aggregate spend exceeds a daily ceiling. This exists because the per-user ceiling in Part X protects against one abusive account and does not protect against a pricing change, a runaway retry loop, or a metering bug affecting everyone at once.

## 12.4 Failures with no graceful path

Two things must not degrade, and both are treated as correctness rather than availability.

**A stated number must be grounded.** If the orchestrator cannot ground an answer, the injected result says so and policy forbids the model filling the gap. There is no degraded mode in which Raya estimates a balance.

**A Tier 3 action must never execute on a voice confirmation.** No load condition, no degradation rung, no fallback path may relax this. If the on-screen confirmation surface is unavailable, the action does not happen.

---

# Part XIII: The Build Plan

## 13.1 Sequencing principle

Build the plane before the product. The riskiest and least reversible parts of this system are the media plane and the engine interface, and both are cheapest to get wrong early. Actions, memory, tiers and ambient listening are additive; a media plane with a broken clock is a rewrite.

The second principle is that every phase ends with something a person can talk to. A phase whose deliverable is a component rather than an experience produces integration debt that surfaces at the worst possible time.

## 13.2 Phase 0 — Spikes and gates

**Three weeks. Nothing is committed to until these resolve.**

Four spikes, each of which can change the architecture.

**Realtime API characterization.** Measure end-to-end response latency, truncation behaviour under interruption, session duration and context ceilings, cost against session length, and the actual shape of the event stream. Every number in Parts IV, V and X is currently derived rather than observed, and this spike replaces them. Deliverable: a measured latency and cost profile, and a decision on compaction aggressiveness.

**Azure Voice Live evaluation.** Pricing, region availability, custom neural voice onboarding, and latency against the direct OpenAI path. This is the highest-leverage research in the plan because a favourable answer resolves voice identity and data residency simultaneously.

**Legal gates.** Data processing agreements with zero data retention from OpenAI and from every registry provider intended to carry Class B traffic; the Law 25 transfer assessment; disclosure language drafted and reviewed. These are on the critical path, they involve parties outside the team, and starting them late is the most common way a launch date slips for reasons nobody wrote down.

**Cost model validation.** Build the session simulator in Appendix D and reconcile it against the measured profile from the first spike.

*Exit criteria: measured cost per voice-minute within 15% of the model, a written Azure recommendation, and signed data processing agreements or a documented plan to obtain them.*

## 13.3 Phase 1 — The vertical slice

**Six to eight weeks. One engine, one client, no actions.**

Deliver a conversation. A user on the web client can talk to Raya continuously, interrupt her, be understood, and receive grounded answers about their money. Nothing is mutable, there are no tiers, and there is no ambient listening.

The work is `raya-mf` in Go with the frame clock, jitter absorption and playout accounting; the Voice Engine Interface and the `openai-realtime` adapter; LiveKit integration as SFU with the participant-not-agent pattern; the delegation path with the reactive half only, the warm prefix and the narration ladder; turn reconstruction and the dual transcript; and the deterministic replay harness, which is built in this phase rather than later because everything after it depends on being able to test.

*Exit criteria: response latency p50 under 700 ms — deliberately looser than the 600 ms objective in Section 4.8, because the adaptive buffer is untuned at this stage and tightening it is Phase 3 work; barge-in cessation p95 under 100 ms; truncation accuracy within one frame period at p99; the replay harness running in continuous integration; twenty internal users having held real conversations.*

The truncation criterion is the one to hold firm on. It is the failure that is cheapest to fix now and most expensive to discover later.

## 13.4 Phase 2 — The product

**Six to eight weeks. Actions, memory, tiers, trial.**

The action layer with the four-tier gate, voiceprint enrolment and verification, and the undo ledger. Compaction as memory formation, and the handoff machinery it depends on. The spend ceiling and its enforcement at all three points. Tier entitlement and the trial. `cascade-v1` built and passing conformance, because the degradation ladder is not optional and a fallback built under pressure is not a fallback. iOS and Android clients. The evaluation harness and rubrics.

*Exit criteria: every conformance test passing on both engines; cross-engine snapshot prefill demonstrated on a live session; the undo ledger tested against every reversible action; spend meter accuracy within 5% of invoice; alpha with fifty external users.*

## 13.5 Phase 3 — Hardening

**Six weeks. Degradation, observability, ambient, telephony.**

The full failure ladder with circuit breakers. Complete observability against the indicators in Part XI. Shadow traffic infrastructure. Ambient listening with its four constraints. SIP and PSTN. Load testing to the concurrency target. Security review of the voice attack surface specifically — replay, bystander, spoofing, and the ambient session lifecycle.

*Exit criteria: every service level objective met under load; a rung-4 mid-session degradation to the cascade demonstrated on a live conversation; the security review closed; beta.*

## 13.6 Phase 4 — Optionality

**Ongoing, prioritised by what Phase 0 found.**

Azure Voice Live adoption if the spike was favourable, delivering Raya's own voice and improved residency. A Canadian residency path if it becomes a commercial requirement. Transport optimization if measurement shows it is worth it, which it currently does not.

## 13.7 Staffing

| Role | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
| :--- | :--- | :--- | :--- | :--- |
| Media engineer, Go | 0.5 | 1.0 | 0.5 | 0.5 |
| Backend engineer, NestJS | 0.5 | 1.0 | 1.0 | 0.5 |
| Client engineer | — | 0.5 | 1.0 | 0.5 |
| ML and evaluation | 0.5 | 0.5 | 0.5 | 0.5 |
| Infrastructure | 0.25 | 0.25 | 0.25 | 0.5 |
| Design | 0.25 | 0.25 | 0.5 | 0.25 |
| Legal and compliance | 0.5 | — | 0.25 | 0.25 |

The media engineer is the hard hire. This is a role that needs someone who has debugged a jitter buffer, and the field of people who have is small. Identify them during Phase 0.

---

# Part XIV: The Research Track

## 14.1 Why have one at all

We buy the voice model, and everything in this document is designed so that buying it is reversible. A research track exists to make that reversibility real rather than theoretical, and to give us a position if the vendor relationship becomes untenable on price, policy, capability or strategy.

It is explicitly not on the critical path. Nothing in Parts I through XIII depends on it. It may never ship, and the document says so plainly so that nobody plans around it.

## 14.2 Three threads

**Full-duplex evaluation.** Keep `fullduplex-v1` current with the open frontier and run it continuously in shadow. Lychee-FD today, whatever supersedes it tomorrow. The measurement that matters is not whether it is as good as the vendor engine — it is not — but the *rate at which the gap is closing*, because that rate is what tells us when to reconsider. The first task remains verifying that vLLM-Omni's realtime path actually implements interruption during generation.

**`raya-fd`.** Apply the BayLing-Duplex conversion recipe — four added tokens, block-wise channel interleaving, roughly 400K samples — to a base model chosen for financial reasoning rather than inherited from whatever the original authors used. The interesting claim in that work is that the converted model *improved* on question-answering relative to its turn-based parent, which if it holds against a stronger base is the most direct attack on the intelligence gap in Section 1.5. This is a genuine research bet with a real chance of producing nothing.

**Domain adaptation of the delegate.** Cheaper, likelier to pay off, and less glamorous. Fine-tune an economy-tier model on Raya's actual delegation traffic — the queries, the tool selections, the grounded answers — and measure whether a small specialized model beats a large general one on our distribution. If it does, the delegate line in Part X goes to near zero and speculative delegation becomes free rather than cheap.

## 14.3 What would make us switch

Stating the trigger conditions in advance prevents the decision being made by inertia in either direction.

We move off the vendor engine if measured conversational quality on our own corpus comes within a defined margin and cost is materially lower; or if a residency requirement becomes binding and Azure cannot satisfy it; or if vendor pricing moves such that the tier model in Part X no longer holds; or if the vendor's data handling posture changes in a way our privacy commitments cannot accommodate.

We do not move for a benchmark result, for a licence preference, or because self-hosting feels more sovereign. The conformance suite and the shadow harness exist to make that a measured decision rather than an argument.

---

# Part XV: Risk Register

| # | Risk | Likelihood | Impact | Response |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Truncation accounting implemented incorrectly and the defect ships | High | High | Conformance test in Phase 1 exit criteria; it is the single named gate |
| 2 | Measured cost per voice-minute materially exceeds the model | Medium | High | Phase 0 measurement before commitment; allowances move, not the architecture |
| 3 | Vendor price increase | Medium | High | `cascade-v1` maintained at production quality; conformance suite keeps its economics honest |
| 4 | Vendor outage during a live conversation | Medium | Medium | Rung 4 cross-engine degradation; demonstrated in Phase 3 |
| 5 | Data processing agreements with zero retention not obtainable in time | Medium | High | Started in Phase 0 as a critical-path item; the alternative is `cascade-v1` self-hosted |
| 6 | Delegate cache invalidated by an implementation that rebuilds the prefix | Medium | Medium | Cache hit rate is a service level indicator with an alert below 80% |
| 7 | Media engineer not hired | Medium | High | Identify during Phase 0; the schedule assumes the role is filled by Phase 1 |
| 8 | Voice identity absence damages the brand | Medium | Medium | Azure spike in Phase 0; accept the preset if it fails |
| 9 | Utilisation materially exceeds 30% | Medium | Medium | Spend ceiling bounds the loss; allowances adjust |
| 10 | Ambient listening incident — bystander hears financial detail | Low | High | Discretion mode default on, demoted authorization, on-device wake word |
| 11 | Plaid cost materially exceeds $0.85 per subscriber | Medium | Medium | Largest unverified number in the model; negotiate at $2,000 monthly spend |
| 12 | OpenAI ships a competing personal finance assistant | Low | High | No technical mitigation; defensibility is the bank connection, memory, actions and audit trail |
| 13 | Cloud Run 60-minute ceiling interacts badly with long sessions | Low | Medium | Handoff exists regardless; test explicitly with a 90-minute session |
| 14 | Judge-model evaluation drifts and stops catching regressions | Medium | Medium | Scheduled weekly human listening sample |

---

# Appendices

## Appendix A — Wire formats

Three protocols are specified in full in the implementation repository and summarized here.

**`raya-mf` to `raya-api` control events.** A unidirectional, at-most-once event stream over HTTP/2, carrying the `Event` types from Section 3.4 with session and turn identifiers. Lossy by design: the receiver reconstructs from what arrives and the sender never blocks or retries on the media path. Sequence numbers allow gap detection so that reconstruction can mark a turn incomplete rather than silently wrong.

**`raya-api` to `raya-mf` injection.** A deadline-bounded request carrying `ContextItem`, returning acknowledgement only. The response never carries conversational content, because content flowing backward through this channel would make the application server part of the response path.

**Client data channel.** Bidirectional, low rate, carrying playout position and jitter buffer depth from the client, and discontinuity markers, discretion-mode state and transcript stability hints from the server. Explicitly not a fallback audio path.

## Appendix B — Schema additions

Additions to `RayaMessage`: channel discriminator, session identifier, start and end offsets against the session clock, truncation offset, overlap interval, abandoned flag, prosody summary, and delegation record references.

New `VoiceSession`: user, tier, engine identifier and version, start and end, total minutes, metered spend, handoff count, degradation events, client type, residency zone, and termination reason.

New `DelegationRecord`: session, turn, tier, provider, model, data class, speculative flag, latency, input and cached and output tokens, cost, cache hit, outcome, and cancellation reason.

New `UndoLedgerEntry`: user, session, turn, action, parameters, inverse operation, permission tier, permission decision, executed timestamp, and reversed timestamp.

New `VoiceSpendLedger`: user, period, ceiling, consumed, and the reservation records that make mid-session enforcement correct under concurrency.

## Appendix C — The evaluation corpus

A fixed set of recorded sessions, consented and where necessary synthesized, covering the patterns that break voice systems: numeric retrieval pauses; mid-sentence self-correction of amounts; emotional disclosure with long silences; rapid-fire questions with no gaps; a second speaker in the room; code-switching mid-sentence; poor acoustics and low bandwidth; deliberate barge-in at varied offsets including mid-word; abandoned utterances; and adversarial attempts at the advice boundary and at Tier 3 actions by voice.

Each session carries reference annotations: true turn boundaries, true transcripts, the correct grounded answer where one exists, and the expected permission outcome. The corpus is a deliverable with an owner, and it grows from production sessions under explicit opt-in.

## Appendix D — Cost model derivation

The session simulator reproduces a realtime session's token accounting turn by turn — fresh audio input, re-billed cached history, text output, audio output — across a distribution of session lengths and turn densities, and produces the cost-per-minute curve that Section 5.6 summarizes as a single number. It is the artefact that turns "about $0.057" into something that can be checked against an invoice. It lives alongside the pricing canvas and is re-run whenever vendor pricing changes.

## Appendix E — The hybrid split, documented and rejected

Running the Realtime API in audio-in, text-out mode and synthesizing Raya's voice ourselves is recorded here so that the reasoning is not relitigated.

It delivers a distinctive voice immediately and from any vendor. It costs: the model's output prosody is discarded and replaced by a synthesizer that cannot hear the user, so emotional register degrades precisely in the conversations where it matters most; barge-in bookkeeping becomes substantially harder, because the truncation offset must be computed against our synthesizer's playout and translated back into the model's text timeline; and the total cost per minute rises. Azure Voice Live achieves the same goal without any of these costs if its pricing and regions permit, which is why Section 5.5 prefers it and why this route is documented rather than planned.

## Appendix F — Glossary

**Barge-in** — the user beginning to speak while the assistant is speaking, and the assistant stopping.
**Cascade** — a voice system composed of separate recognition, reasoning and synthesis stages.
**Class A / Class B** — delegation data classes; B carries user data and requires a zero-retention provider.
**Compaction** — summarizing conversation history to fit a context ceiling; in this system, also a memory-formation and cost-control event.
**Delegation** — the voice model asking the asynchronous plane for reasoning, grounding or tool execution.
**Full duplex** — modelling both audio channels simultaneously, permitting genuine overlap and backchannelling.
**Handoff** — moving a live conversation to a new inference session without the user noticing.
**Narration ladder** — the latency-adaptive behaviour that keeps a conversation alive while delegation runs.
**Playout cursor** — the measured count of assistant audio that actually reached the user.
**Prosody sidecar** — the off-path model recovering paralinguistic signal the vendor does not expose.
**Speculative delegation** — starting delegation on a hint rather than a request, cancellable without penalty.
**Spend ceiling** — the per-user monthly voice cost limit, enforced in dollars and presented as minutes, derived from the advertised allowance rather than set independently of it.
**Truncation offset** — the number of milliseconds of an interrupted utterance the user actually heard.
**Two-plane architecture** — the separation of a fixed-schedule media path from everything else.
**Voice Engine Interface** — the contract that makes the voice model a swappable part.

---

*End of specification.*
