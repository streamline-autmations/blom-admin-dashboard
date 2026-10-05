# Preserve work on browser-tab return

Supabase can emit `SIGNED_IN` again on tab focus, and `TOKEN_REFRESHED` during normal
session renewal. Previously every event switched the entire Admin to a loading screen,
unmounting the routed page and discarding its local fields/items/filters.

`AuthContext` now revalidates an already-verified user in the background. Screens and
unsaved text remain mounted, including focus/caret. A temporary background profile lookup
failure does not erase work; all server endpoints still verify permissions per request.
Initial sign-in and account changes require fresh role validation. A confirmed non-admin
role or sign-out removes protected screens immediately. Validation versions prevent late
responses from restoring a signed-out user; concurrent checks for one user are coalesced.

This preserves work when switching browser tabs or minimising the window. It does not add
local-storage copies of every form, autosubmit edits, or guarantee recovery after an actual
reload, browser closure or operating-system tab discard.

Browser regression checks used the real AuthProvider and synthetic Supabase responses:
fill an invoice with items/quantity/customer details; emit same-user `SIGNED_IN`,
`TOKEN_REFRESHED` and `USER_UPDATED` during delayed role checks; change tabs and return;
simulate a profile-service failure; confirm the original input node/value/caret remains.
Also verify revoked roles remove the screen and a late role response after `SIGNED_OUT`
cannot restore access. No live invoice/database writes are needed for these checks.
See `tests/browser/README.md` for the repeatable local browser script.
