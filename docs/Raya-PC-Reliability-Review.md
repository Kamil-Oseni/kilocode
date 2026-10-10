# PC reliability review

Observed October 10, 2026. Evidence: [PC-Reliability-Review-20261010.json](D:/RayaBackups/PC-Reliability-Review-20261010.json). This was a read-only review; no VM start, power-setting change or launcher change was performed.

## Current behaviour

| Item | Observed configuration | Practical effect |
|---|---|---|
| Home Assistant VM | Powered off; 2,048 MiB RAM, two CPUs, UTC RTC | Off deliberately for Figma; do not restart until requested |
| Network | Bridged to Intel Wi-Fi 7 BE200 | Host Wi-Fi connectivity remains a dependency |
| Startup task | Enabled interactive logon trigger; 45-second delay; hidden PowerShell | Starts after Kamil signs in; does not provide service before login |
| Last scheduled run | October 7 at 17:01:50 local; result zero | Scheduler reports success; startup log records a start at 17:01:57 |
| Retry policy | Three retries one minute apart; duplicate instances ignored; three-minute execution limit | Handles some launch failures; does not establish dashboard readiness |
| Plugged-in power plan | Sleep after zero; hibernate after zero | Automatic inactivity sleep and hibernation are disabled on AC power |
| Battery power plan | Sleep after 600 seconds | Different from AC; configuration observation only |
| RGB bridge recovery | Disabled; main bridge task running | Historical temporary suppression remains; no lighting test performed |

## Earlier clock stalls

The reported guest console showed CPU RCU stalls, a possible timer issue and a systemd watchdog timeout. Those symptoms establish a guest stall, not its cause. Current VirtualBox logs have rotated to October 9–10 and do not establish the cause of the earlier event. The last seven days of Windows events include an October 4 unexpected shutdown and October 7 Explorer-initiated restarts; neither proves that saved-state clock drift caused the guest failure.

The current startup script at `D:/RayaBackups/HomeAssistant/Start-HomeAssistant.ps1` starts headless and returns successfully if the VM is already running. If it detects a saved state, it resumes that state and issues a VirtualBox reset. This is an existing clock-recovery workaround, not proof that the root cause is fixed. A reset is abrupt; avoid treating it as the normal shutdown procedure.

For planned VM shutdown, use an ACPI shutdown and wait for powered-off state. Avoid saving a running state merely to free RAM. When Home Assistant is requested again, start the powered-off VM normally. If the dashboard fails, retain guest console and current VBox logs before restart so future diagnosis has evidence from the actual failure.

## Remaining reliability work

- At the next requested start, verify VM boot and dashboard availability separately; a scheduler result of zero does not prove Home Assistant is ready.
- If service before Windows login is desired, design and qualify an unattended startup owner separately. Do not assume the current logon task supplies that behaviour.
- Replace or qualify the saved-state reset workaround during maintenance, preserving recovery material and observing guest shutdown and clock behaviour. Do not change it silently while the user is working.
- A host restart or manual sleep still interrupts the VM even though automatic AC inactivity sleep is disabled. These settings do not prove protection from crashes or power loss.

See [the recovery quickstart](./Raya-Recovery-Quickstart.md) for the verified backup inventory and restoration limits.
