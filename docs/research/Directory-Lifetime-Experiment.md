# Directory guard lifetime experiment

Author: ChatGPT — 2026-09-28 07:11 EDT (Toronto).

This private headless experiment investigates the lifetime requirement in [Directory-Launch-Contract.md](Directory-Launch-Contract.md). It does not change the shipped launch protocol or establish production readiness.

## Contract gap

The current native guardian keeps the Job handle itself. Normal stop and controller loss request Job termination and poll actual accounting until membership is empty. The corrected assigned-exception path also requests termination and observes empty accounting within the existing drainage bound; it emits exact drainage evidence and an unknown outcome rather than claiming successful work. Two actual adverse tests and the full launch suite passed (14 tests, 66 assertions). Ordinary assigned exceptions are therefore no longer the identified defect.

A drainage deadline without an empty observation, forced guardian death, or forced keeper death still lacks proof that directory protection remains held until descendant exit. Directory pins held only by the terminated guardian cannot establish that lifetime guarantee.

Microsoft documents external process termination as asynchronous: pending I/O must complete or cancel before exit. Job termination acts as termination of each member. Kill-on-last-Job-handle-close causes termination, but is not a demonstrated synchronous exit barrier. [TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess), [TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject), [CreateJobObjectW](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw).

A separate keeper can retain guards and a Job across controller/helper loss. Because its Job handle prevents last-handle-close termination, the keeper must explicitly detect loss, terminate, and drain. Forced keeper death remains an adverse case. Giving directory handles to the initial target is insufficient for arbitrary descendants: inheritance requires cooperating creation settings, and the original leader may exit before a child that did not inherit those handles. [Handle inheritance](https://learn.microsoft.com/en-us/windows/win32/sysinfo/handle-inheritance).

## Private fixture

`packages/core/native/kilocode/directory-lifetime-fixture.cpp` is separately compiled and never shipped. The focused test is enabled only by the absolute `RAYA_LIFETIME_EXPERIMENT` executable path on Windows.

The independent observer creates synthetic controller/helper processes. A keeper owns the only unnamed, non-inheritable kill-on-close Job and holds a delete-excluding directory handle plus a witness. The keeper creates a suspended leader, assigns it to the Job before resume, and the leader creates a descendant. The observer validates both exact PID/birth pairs with held process handles. It never owns a Job handle, including during keeper termination.

Five cases exercise normal stop, controller loss, helper loss, leader exit with a living descendant, and forced keeper termination. While interruption is occurring, the observer repeatedly attempts to rename the protected directory. After the first successful rename it records the release sample, immediately checks whether either exact known process remains unsignalled, and then creates a replacement directory. The keeper publishes actual empty accounting only while it still owns the Job. Every successful case ends by verifying all five exact known synthetic processes have exited before the test removes its exact disposable root.

Reports include rename attempts, first observed guard release, observed process exit times, immediate mutation overlap, and whether actual empty Job accounting was observed. Times use `GetTickCount64`; equal millisecond timestamps cannot establish event order. A zero overlap count means no overlap was observed for these two known processes. It is not a proof that no interval exists. A positive count is direct evidence that substitution became possible while a known process remained unsignalled.

For forced keeper termination, no surviving Job owner can query arbitrary membership. The test intentionally does not require an empty receipt or turn finite PID observations into an arbitrary descendant proof. Completion-port notification alone would also be insufficient: ordinary Job messages are not guaranteed. [Job objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

## Verification

The fixture compiled with MSVC C++20 `/W4 /WX`. An initial fixture-only wide-character narrowing warning was corrected before the successful build. All five actual cases ran on Windows: **5 tests passed, 49 assertions, 2.54 seconds**. These tests validate the reported observations; a passing observational test does not mean every candidate satisfies the launch contract.

| Case | Rename attempts | Live mutation observed | Empty Job accounting observed | Guard release sample | Leader exit sample | Descendant exit sample |
|---|---|---|---|---|---|---|
| Normal stop | 64 | 0 | Yes | 94570031 | 94570015 | 94570015 |
| Controller loss | 536 | 0 | Yes | 94570375 | 94570359 | 94570359 |
| Helper loss, keeper survives | 450 | 0 | Yes | 94570656 | 94570640 | 94570640 |
| Leader exits, descendant lives | 707 | 0 | Yes | 94570937 | 94570906 | 94570921 |
| Forced keeper death | 2 | **1** | **No** | 94571234 | 94571234 | 94571250 |

The forced-keeper case is a **failed lifetime candidate**, not an inconclusive success. After a successful directory rename, an immediate wait on at least one exact known process handle still returned unsignalled. The observer subsequently created the replacement directory. Its descendant PID was 20176 with creation time 134350674400782588; the leader PID was 17432 with creation time 134350674400260406. The observer held no Job handle, so this adverse result did not accidentally prevent kill-on-last-close. Both processes later exited, as did the controller, helper, and keeper, before the exact disposable root was removed.

The 16-millisecond difference between sampled release and descendant exit does not measure the exact interval; polling and clock granularity affect those values. The immediate post-rename unsignalled observation is the relevant direct evidence. Four keeper-survival cases observed actual empty accounting and no overlap for their known processes; they do not prove a universal guarantee.

## Limits and next decision

The keeper-survival cases support further research on that limited mechanism. Forced keeper termination exposed a real protection-release interval and still cannot certify arbitrary unknown descendant exit after the last Job handle disappears. The production contract remains unresolved: merely moving Job and pin ownership into another terminable userspace keeper is insufficient. Another mechanism must retain protection through actual drainage under that failure, or the contract cannot be claimed. The fixture does not cover launch namespace binding, acquisition races, recovery, user interfaces, or installed-host performance.
