# Changelog

All notable changes to `@xyzensun/pi-sync` are documented here.

This package is forked from `@jachy/pi-git-sync` 0.7.1. For the upstream
history see <https://github.com/jachy-h/pi-git-sync>.

## [0.3.3] - 2026-09-23

### Changed

- Joining an existing repository no longer auto-applies the remote config.
- Previously, running `/pisync` on a new device cloned the repository and
  immediately applied the remote configuration to the local machine without
  asking. Setup now only clones and registers the repository, then returns a
  `first_pull_choice_required` result so the extension asks how to proceed:
  smart pull (remote wins conflicts, local-only files kept), overwrite local
  from remote (mirror, deletes local-only files), or skip for now. Headless
  sessions (`-p`, rpc, json) cannot ask, so they apply nothing and direct the
  user to a UI session. The empty-repository first-machine flow (capture and
  push local config) is unchanged.

## [0.3.2] - 2026-09-22

### Fixed

- Last-sync time is now shown in the local time zone. `state.json` stores
  `lastSyncedAt` as a UTC string (`new Date().toISOString()`), and the earlier
  rendering sliced off the first 16 characters, displaying UTC as if it were
  local time — off by 8 hours on a UTC+8 machine. Both the TUI panel status
  summary and the `/pisync` status line now format through a single helper that
  converts to the machine's time zone at minute precision; values that are not
  valid timestamps are passed through unchanged.

## [0.3.0] - 2026-09-11

### Added

- `/pisync` now opens a TUI panel in interactive sessions: a persistent status
  summary (branch, ahead/behind, pending changes, conflicts, autoSync) plus
  smart pull/push, two whole-machine alignment modes, diff and settings.
  Non-TUI sessions (`-p`, rpc, json) keep the previous dialog flow.
- Whole-machine alignment, panel-only and never exposed as a direct command:
  "overwrite local from remote" discards every un-pushed local change, and
  "overwrite remote from local" makes the repository match this machine,
  including deleting files only the repository has. Both list the exact paths
  they will discard before running, and their confirmation defaults to Cancel.
- `previewOverwrite` reports those losing paths; it fetches first so the list
  also covers remote changes not yet in the worktree.

### Changed

- Git conflicts are no longer resolved by pi-sync. Both the panel and
  `/pisync push` offer exactly two exits: hand the merge to the Pi agent, or
  stop and do it yourself. `Esc` is equivalent to the latter. This does not
  affect manual pull, whose remote-first behaviour is a three-way comparison
  verdict rather than a git merge.
- Whole-machine alignment deletes regardless of `delete: "none"`. That switch
  governs whether deletions propagate between machines; alignment is an
  explicit one-off request whose whole point is that both sides end up
  identical. Ordinary pull/push/apply still honour the setting.
- Panel actions are one-way and keep package approval, matching the menu
  wording. Direct commands remain zero-prompt.

### Fixed

- autoSync could bypass the file lock when its timer fired during a manual
  sync: the reentrancy flag is per-instance and the timer shares the instance
  with the command handler. Guarded in two places — the orchestration layer
  checks the flag, and the extension skips ticks while a command is in flight
  (including while a dialog or the panel is waiting on the user).

### Removed

- The per-file and bulk `ours`/`theirs` conflict resolver, along with its
  orchestration and system-layer modules.

## [0.2.0] - 2026-09-10

### Added

- `/pisync pull` and `/pisync push` direct commands for fast, near-zero-prompt
  operation: package approval is granted automatically, pull resolves
  conflicts remote-first, and push only stops for a genuine Git conflict.
  Both report an actionable message instead of throwing when the machine has
  not been initialized yet, and both work in non-interactive sessions.

### Fixed

- Backups are now capped at the 5 most recent. `cleanupOldBackups` existed but
  had no production caller, so `.pi-sync/backups/` grew without bound. Cleanup
  runs only after the new baseline is on disk, since every earlier failure
  path still needs those backups to roll back.

## [0.1.0] - 2026-09-09

First release under the `@xyzensun/pi-sync` name. The version number restarts
because this is a separate npm package, not a continuation of the upstream
release line.

### Added

- Adapter runtime for `special` files: `toRepository` / `toLocal` /
  `normalizeForComparison`, with user adapters loaded from a `./relative.js`
  path next to `pi-sync.json`. Missing directions fall back to direct bytes.
- Built-in `settings` adapter projecting `settings.json` onto a
  device-independent field whitelist, so machine-local keys never conflict.
- `autoSync` option for silent one-way pulls: the repository is authoritative,
  it only applies when the local side has no un-pushed drift, and it never pushes.
- Plugin self-exclusion: the extension's own install directory is removed
  before include parsing and can never be captured.

### Changed

- Manual pull is remote-first: on conflict the repository content wins and the
  un-pushed local change is discarded. Push conflicts still preserve the
  device recovery branch.
- `include` means byte-for-byte overwrite; adapters apply only to paths
  declared in `special`, `settings.json` included.

### Removed

- The upstream hard-deny blacklist and secret scanning. Whether a file is
  synchronized is decided entirely by the `include`/`exclude` manifest.

### Security

- User adapter paths are rejected at manifest load time when they contain
  `..` segments, so a synchronized `pi-sync.json` cannot make another device
  execute JavaScript from outside the config repository.
