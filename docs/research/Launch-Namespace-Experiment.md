# Private launch namespace experiment

ChatGPT, 2026-09-28 07:10 EDT (Toronto).

This experiment is not packaged and does not change the production launcher. Source: `packages/core/native/kilocode/launch-namespace-fixture.cpp`; test: `packages/core/test/kilocode/launch-namespace-experiment.test.ts`. Measurements below are from the installed Windows x64 host on 2026-09-28.

The fixture creates two independent directories below a fresh direct child of the temporary directory. It opens their physical identities while excluding delete sharing, then creates a fresh `RayaLaunch-{UUID}` local DOS device alias to A. It checks that the alias did not already exist, refuses LocalSystem execution, uses raw NT targets and suppresses system broadcasts. The alias is changed to B while the A pin remains open. It probes actual file opens and suspended `CreateProcessW` calls through three namespace spellings. A refused spelling is recorded with its actual Win32 error, never treated as successful launch evidence.

Each successful launch enters a kill-on-close Job before any resume. The fixture reads only the suspended child's PEB/process-parameters prefix, duplicates its current-directory handle, and queries that handle's physical file identity. An alias child never resumes, including when the observation is uncertain. Only separately authorized plain-path and volume-GUID positive controls may resume after the observed identity equals A. Those children independently open their actual current directory and write a binary physical-ID report into a unique fixture-owned nonce file. No environment, command output, remote memory contents, or user data are printed.

The current-directory member is an **unsupported x64 research layout**, not a supported Windows API contract. Bounded reads and native-x64 checks constrain the measurement; they do not make that layout suitable for production. If the handle becomes available on another host, independent post-resume controls must also pass. If a suspended child has no duplicable current-directory handle, that launch refuses resume and remains suspended until termination. The measurement suite continues to record file-resolution and creation-acceptance controls, but never converts unavailable child binding into a successful binding result.

The fixture also attempts exact removal of a nonexistent target and checks that the B definition remains intact. It then removes both owned alias definitions by exact target match and confirms the alias is absent. All removed-alias launch controls must refuse. RAII cleanup runs on ordinary failures. A separate cleanup invocation runs even if the test controller is terminated: it checks that every remaining definition is one of the two exact fixture-owned physical targets before removing it. An unexpected definition refuses cleanup and retains the disposable directory for diagnosis. No ordinary drive letter is changed. Closing a suspended child's sole Job handle tests controller-handle loss and verifies no nonce effect; it does not yet simulate abrupt controller process death.

The volume-GUID probes vary cwd, image, and both. Success for this dedicated native child establishes only that spelling's compatibility with that child and this host. It does not establish cmd, PowerShell, arbitrary application, SDK, or production shell compatibility. Production admission still needs a supported stable namespace and an actual suspended-child binding contract, with independent image/directory validation and adversarial controller-loss tests.

## Official API basis

- [DefineDosDeviceW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-definedosdevicew) describes local namespace ownership, raw targets, no-broadcast creation, and exact removal.
- [QueryDosDeviceW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-querydosdevicew) provides inspection of the one named alias and its definition stack.
- [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw) documents suspended creation and explicit image/cwd inputs; accepted namespace spellings are measured, not assumed.
- [Naming a Volume](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-volume) describes volume-GUID paths; the experiment obtains them from existing handles without changing mounts.
- [NtQueryInformationProcess](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess) and [PEB](https://learn.microsoft.com/en-us/windows/win32/api/winternl/ns-winternl-peb) explicitly warn that these internal structures/interfaces may change.

## Run

Compile the private fixture separately for x64 with Windows SDK headers and `advapi32.lib`; it must not be added to packaged helper builds. Set `RAYA_LAUNCH_NAMESPACE_EXPERIMENT` to that exact executable and run `bun test ./test/kilocode/launch-namespace-experiment.test.ts` from `packages/core` in the serialized native test slot. Without the explicit environment variable, the test is skipped.

## Results

Final MSVC `/std:c++20 /EHsc /O2 /Z7 /W4 /WX` compilation passed. An initial compilation caught a local shadow warning; renaming that local fixed it. The first actual run failed closed at the ordinary suspended control with invalid-handle error 6, before any alias creation. The final suite separates this real binding refusal from the remaining measurements and passed **1 test, 60 assertions, 44 native rows**. Its final test body, including native rescue, took approximately 434 ms; the Bun process completed in 1.69 seconds. No test retries or resume fallback were added.

| Control | Actual observation |
|---|---|
| `\\?\RayaLaunch-{UUID}\` | File opens observed A then B; suspended `CreateProcessW` accepted after remap |
| `\\.\RayaLaunch-{UUID}\` | File opens observed A then B; suspended `CreateProcessW` accepted after remap |
| `\\?\GLOBALROOT\??\RayaLaunch-{UUID}\` | File opens observed A then B; suspended `CreateProcessW` accepted after remap |
| Held physical A pin | A volume/file identity unchanged throughout alias remap |
| Nonmatching exact removal | Refused with error 2; B definition unchanged |
| Removed alias launch, all three forms | Refused with error 267 |
| Volume-GUID cwd, image, both | Suspended `CreateProcessW` accepted each form |
| Suspended cwd inspection, all eight children | Null handle, tag 0, aligned; duplication refused with error 6 |
| Native cancellation and Job-handle loss | Exact child process signaled gone; Job-empty checks passed where the Job handle remained available |
| Nonce effects and alias cleanup | Every attempted child remained suspended and produced no nonce; exact removal and external rescue confirmed alias absence |

Structural observations contained only null/tag/alignment booleans, string lengths, and Win32 error codes. Current-directory lengths were bounded even values from 104 to 220 bytes, with maximum 520 bytes. No remote strings, raw memory, environment, or physical path values were emitted. The null member is the observed state of the research layout, not proof of why Windows leaves it unavailable.

The experiment demonstrates a mutable name-to-directory mapping despite unchanged directory pins, and actual suspended-launch acceptance of those names. **It does not demonstrate the suspended child's physical cwd identity**, because the inspected handle is null. No positive control reached authorized resume, so independent child-reported cwd identity was not measured. The volume-GUID result establishes creation acceptance only, not child cwd identity or shell behavior. A production solution still needs supported actual binding evidence, namespace continuity through resumed execution, full ancestor/witness lifetime, and abrupt controller-process loss/restart coverage.
