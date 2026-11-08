# Ka Settings — Spec

Status: draft · Reference: Arc Settings window (screenshots 2026-11-08)

## Problem

Ka runs one manager process (UI, Space↔Profile bindings) and one worker per
Profile. Zen's `about:preferences` only sees the worker it runs in, so it
cannot show or change app-wide state (Profiles, bindings, shortcuts) and it
mixes app-wide and per-Profile options in one page.

## Goal

Split settings the way Arc does:

| Scope | Owner | Surface |
|---|---|---|
| App-wide (Profiles, Space bindings, shortcuts, links, appearance) | manager | Ka Settings window |
| Per-Profile (search, downloads, passwords, privacy, site data) | that Profile's worker | Zen `about:preferences` in that worker |

## Window

- A separate native-style window, opened by `Cmd+,` and the app menu
  "Settings…"; one instance, re-focused if already open.
- Toolbar of icon tabs (Arc style). Title = selected tab name.
- Opening it never creates a browsing tab and never touches a worker unless a
  per-Profile link is clicked.

## Phase 1 — Profiles tab (ship first)

Left list: every Ka Profile, each with "N Spaces" (count of Spaces bound to it,
"no Spaces" when 0). `+` creates a Profile; `−` deletes one.

Right pane for the selected Profile:
- Name (rename in place).
- Spaces bound to it (read-only list; rebinding stays in the Space menu).
- Links that open the Profile's own Zen settings in its worker, selected
  in the current window:
  - Search → `about:preferences#search`
  - Downloads / General → `about:preferences#general`
  - Privacy, passwords, site data → `about:preferences#privacy`
  - Sync / account → `about:preferences#sync`

Delete rules:
- The last Profile cannot be deleted.
- A Profile with bound Spaces asks which Profile those Spaces move to.
- Deleting stops its worker first, then removes the profile directory.
  Confirmation states that its data is gone for good.

## Phase 2 — General / Advanced

Only options Ka already has or that are one pref away:
- Restore previous session on launch.
- Warn before quitting.
- Default browser check (off by default; workers never prompt — see `390dab95`).

## Phase 3 — Shortcuts

Searchable list of Zen keyboard shortcuts (reuse Zen's existing shortcut
store), editable, with "Reset all".

## Out of scope (until the feature exists)

Max/AI, Little Arc, Peek, Boosts, Icon picker, account/membership page,
sound/haptics.

## Routing rules

- `Cmd+,` and menu "Settings…" open the Ka Settings window (not
  `about:preferences`).
- Any `about:preferences*` load started in the manager (links, extensions,
  `openPreferences(pane)`) opens in the worker bound to the current Space and
  is selected there (current behavior, keep it).
- Pages inside a worker's `about:preferences` that edit app-wide state
  (Zen workspaces, Profiles) are hidden in workers.

## Acceptance (live, on Ka.app)

1. `Cmd+,` in any Space opens the Ka Settings window; a second `Cmd+,`
   focuses it.
2. Profiles tab lists every Profile with correct Space counts.
3. Create, rename, delete a Profile; delete with bound Spaces moves them to the
   chosen Profile; the worker is gone and the bindings survive restart.
4. "Search" on Profile P opens P's `about:preferences#search` in P's worker;
   changing the engine there does not change another Profile's.
5. Real `profiles.ini` of Zen is not touched (read-only check).
6. `test_zen_manager_mode.py` gains one check per acceptance item that can be
   automated; all existing checks still pass.

## Open questions

- Window technology: XUL dialog in the manager (fast, themed with Zen) vs a
  native AppKit panel. Default: XUL dialog.
- Should Space→Profile rebinding also live in Settings, or only in the Space
  menu? Default: Space menu only.
