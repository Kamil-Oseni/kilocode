# Browser identity and authentication

Raya assigns each canonical workspace directory its own internal browser profile. Worktrees are separate workspaces for this policy. Tabs opened for the same workspace share Chromium cookies and site storage. Four workspace browsers can be open at once, and closing a browser panel closes that panel's browser context.

The profile is an implementation detail rather than a selectable account product. Raya does not show profile IDs, saved-authentication pickers, capture controls or capture expiry state, and agents cannot call profile or authentication-capture tools. Older explicit authentication captures are not restored. On startup Raya removes an obsolete `active-auth.json` receipt without deleting ordinary Chromium state or blocking the browser because an old capture expired.

Normal persistent cookies and site storage follow Chromium's own persistence behavior and can survive an extension or browser-session restart. Session-only cookies can disappear. Raya does not copy, merge or replay cookies to reconstruct a login. A site remains the authority for whether its session is valid, so the agent must inspect fresh destination evidence before treating an account as signed in. Authentication values do not appear in ordinary tool results, smoke reports or Admin diagnostics.

A locked profile reports that Raya Browser is open in another window and asks the person to close it there before retrying. A missing Chrome installation asks the person to install Chrome for the current user. Other startup failures retain generic recovery copy and a visible retry action. Raya does not break another process's native Chromium lock.

Manual takeover remains explicit. Taking control cancels queued automation before dispatch where possible, the panel shows that the person is in control, and resuming returns control to the agent. Operations with an uncertain dispatched outcome are not repeated automatically.

Deleting an obsolete capture receipt removes only that obsolete receipt; it does not sign out a site or erase the persistent profile. Clearing site data or revoking a server session remains a site/browser action. Signing out on one device does not imply revocation on other devices.

The automated live acceptance uses real Chrome and a local authenticated HTTP site. It proves that persistent authentication survives a fresh Raya browser session, server-side expiry is visible through fresh destination evidence, a new sign-in recovers the session, manual takeover resumes explicitly, successful smoke evidence is retained and a deliberate HTTP health failure is reported rather than hidden.
