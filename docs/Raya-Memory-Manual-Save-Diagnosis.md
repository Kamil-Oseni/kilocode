# Manual memory save: installed failure and repair criteria

Observed October 14, 2026 on installed source `acf36bcc9f57c4afc03a12f3a2381e9b82e39743`.

The original session `ses_ec574691bffek78X1NctXNgNF3` requested a dated Raya project setup observation, explicitly excluding a new personal preference. One `second_brain_manage` call with `action: remember` returned `disposition: unconfirmed`, `publication_confirmed: false`, and `index_confirmed: false`. No native review card appeared. The assistant nevertheless said it had recorded the observation. This is a failed save, not a saved memory awaiting indexing.

## Evidence

The retained original session, source and pending draft are in `D:/Raya/Tools/Readiness-20261014/Memory-acf-original-manual-unconfirmed.json`: 44,476 bytes, SHA-256 `1479aee3d970ebbf394909fbe28d1eaf0e1274510b45a8d8a289773f3fc2ae07`.

Operation `f0d0b032-251e-5cbc-a51c-9a792f681579` has a pending proposal under `D:/Raya/SecondBrain/System/Proposals/`. Its target is incorrectly `Preferences/Raya.md`. The live note remains unchanged at SHA-256 `9138054cffd9a5052eaa337d989cf51f24f0023f08e57f2a6432a7b19034b37e`. Do not publish, cancel or replay this original while diagnosing the failure.

Read-only inspection uses the real session rows, production original-source extractor, production proposal schema and production HTTP response decoder:

| Check | Observed result |
|---|---|
| Original source versus stored proposal source | Equal |
| Extracted original fact span versus proposal span | Equal: 67–383 |
| Stored JSON proposal schema | Valid |
| Decoded management versus plain stored management | Strict deep equality fails |
| Decoded management versus plain stored management prototype | Different |
| Decoded source versus actual session source | Strict deep equality fails |

The production frame decoder preserves strict JSON validation and constructs objects with a different prototype. The native management flow compares its decoded management object with the original plain preview using `isDeepStrictEqual`, so matching JSON content fails before the review card. This reproduces a concrete consumer mismatch; it does not justify weakening duplicate-key, numeric, source identity or changed-proposal checks.

Separately, `management-flow.ts` selects Preferences whenever the fact contains the word preference or preferences. That matches both factual discussion of retrieved preferences and the explicit exclusion “not a new personal preference.” Category selection must honor explicit project intent and negation; ambiguous requests should use the existing category card rather than guessing.

## Required behavior after repair

- Valid decoded proposal provenance reaches the existing native review card; changed source, fact, operation or proposal still fails.
- The dated project observation targets the project category, with its original text and provenance intact.
- An unconfirmed result produces an explicit failed or unconfirmed answer, without claiming that the memory was saved or that a review card was shown.
- The original failed attempt and pending draft remain retained. A new installed workflow trial uses a new session and operation; no retry of the original uncertain save.
- Claim publication only after the real reviewed save confirms it, and claim retrieval readiness only after indexing confirms it.

The build chat owns the production repair and focused checks. A fresh installed acceptance trial remains necessary; this diagnostic does not establish successful saving, automatic capture or complete SecondBrain acceptance.
