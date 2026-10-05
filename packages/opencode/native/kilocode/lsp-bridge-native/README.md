# Fixed native Windows LSP bridge draft

Source-only and unaccepted. No compilation, packaging, native execution or Lua integration has occurred. The C# alternative remains a historical source draft; it must not be copied into the final package. Core/native5, generic Process/Archive and the current build scripts are unchanged.

The standalone C++ program uses only the selected MSVC static runtime and Windows system APIs (kernel32/bcrypt). It never runs a compiler, PowerShell, dotnet, downloaded runtime or self-extracting bootstrap at service startup. The proposed binary/PDB/source recipe is a selected installed-package binding, not independent attestation.

## Host boundary

The eventual Kilo-owned launcher must reserve admission and protect a new empty control directory with the exact current owner/System/Administrators DACL BEFORE launch or writes. It verifies the complete binary/recipe and canonical ordinary ancestors, retains actual bridge process/birth/image handles, and launches the fixed binary directly with exactly `--control <directory>` and three private pipes. The root, installed bridge, target and control leases persist through original retirement and final cleanup. Target/cwd/argv/env are host-selected, never renderer/model-selected. Native code validates ordinary canonical ancestry but does not itself certify the host's DACL or installed-package trust. Those integration checks remain required.

## Exact version 1 binary envelope

All integers are unsigned 32-bit little-endian. The first integer is body byte length, 1–65536. Exactly that many bytes follow; no buffering can consume subsequent LSP data. The body contains, in order:

1. Magic `0x31424c52` (ASCII RLB1), then version `1`.
2. Token string (32 lowercase hex) and target SHA256 string (64 lowercase hex).
3. Target and cwd strings (each at most 16384 UTF-8 bytes; canonical DOS path at most 4096 UTF-16 units).
4. Argument count (0–128), then that many strings (each at most 8192 UTF-8 bytes).
5. Environment pair count (0–128), then name/value strings for each pair (128/8192 UTF-8 bytes respectively).

Every string starts with its byte length. UTF-8 is strict and NUL is refused. Environment names are nonempty, contain no `=`, are unique under Windows ordinal case comparison, and the constructed UTF-16 environment block is at most 65536 bytes. Extra body bytes are refused. This is a fixed schema; it has no arbitrary key names, duplicate JSON keys or floating-point identity conversions. The next stdin byte is raw LSP input. Stdout is only original LSP output; separate bounded CreateNew `launch.json`/`result.json` files carry host correlation metadata. Arguments, environment and LSP content are absent from those records.

## Original lifetime

Before creating the target, a keeper owns the Job, six original pipe ends and three dedicated native pump threads/handles. The input writer moves to its thread before that thread starts, because immediate EOF may close it and Windows may reuse its numeric handle. That thread closes the genuine target stdin writer at parent EOF or terminal retirement, before root waiting can rely on target completion.

Target creation is suspended with exact HANDLE_LIST and creation-time JOB_LIST. The Job has no kill-on-close or breakaway flag. Root handles are installed without allocation immediately after CreateProcess. Birth and actual image come from those original handles; the pinned single-link image denies write/delete sharing. Post-create failures enter the same keeper and cannot dispose a suspended/live target. Ordinary resume failures retain ownership indefinitely.

After original root exit, only the original input thread is marked terminal and CancelSynchronousIo is requested. Checks occur before each read and between read/write. The exact thread is joined; repeated terminal input cancellation covers a race with ERROR_NOT_FOUND. Neither output reader is ever canceled. A failed parent sink is sticky while the reader keeps draining to real native EOF. Job active count zero and all original pump joins are required before resource release. EOF observations are recorded separately from joined-thread observations. Failure rows are bounded to 64 with an explicit overflow flag.

The bridge has no process/job termination, abort or retirement timeout. The future caller may observe a finite deadline while retaining original ownership and fencing new intake. Query/join/resume uncertainty keeps this keeper alive. Control publication occurs while its directory ancestry remains pinned; the final held bridge exit additionally proves final handle release. Plain control JSON does not independently authenticate native observations or establish full member identity completeness.

`result.json` includes only failures observed before its publication. Final ancestry/handle release happens afterwards; a later release failure remains sticky and yields a nonzero held bridge exit after settlement. The result file alone is neither a complete finalizer-error inventory nor successful closure proof. Hash/provider cleanup also retains original crypto handles and their backing memory until actual cleanup succeeds, even after a caller deadline.

## Acceptance pending

Compilation/types/recipe checks and genuine Windows regressions remain pending: enclosing Job compatibility, exact handle inheritance, startup/raw-byte preservation, real descendant-held stdout/stderr, input cancellation racing native calls, broken forwarding sinks, root nonzero, post-create publication failures, protected namespace checks and original handle cleanup. No actual third-party Lua, Linux/macOS family, arbitrary runtime cache, static manifest integration or full-profile capture claim is made.
