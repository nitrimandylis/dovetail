# dovetail (`dt`)

A personal CLI for finding, backing up, and safely editing the configs and
dotfiles of apps and CLI tools. Single machine (this Mac), single user (Nick).
Built with Bun + TypeScript, zero dependencies, installed globally via
`bun run compile` so `dt` works from any shell.

## Why it exists

Lots of apps and CLIs keep a config somewhere — or don't — and there's no easy
way to know where. `dt find` answers that. Once found, configs get snapshotted
into a local git repo so any edit is undoable and nothing is ever lost.

## Core model: two-way snapshot store

Live files stay exactly where they are — never symlinked, never moved.
Tracked files are mirrored into `~/.dotfiles`, a local git repo:

```
~/.dotfiles/                git repo (local only, no remote)
  manifest.json             { "app": ["~/path", ...], ... }
  home/.zshrc               mirror of ~/.zshrc
  home/.config/nvim/...     mirror of ~/.config/nvim/...
```

Sync is two-directional:

- `dt backup` — live → store, then commit. A backup is a commit.
- `dt apply`  — store → live. Covers both "restore a backup" and
  "I hand-edited files in ~/.dotfiles, push them to the live locations."

Conflict rule: if a live file AND its store copy have both changed since the
last snapshot, `dt` refuses, shows the diff, and makes you pick a direction
explicitly (`dt backup <app>` or `dt apply <app> --force`). Neither direction
ever silently destroys the other side's changes.

## Commands

| Command | What it does |
|---|---|
| `dt find <app>` | Locate an app's config: probe conventional paths (`~/.config/<app>`, `~/.<app>rc`, `~/.<app>`, `~/Library/Application Support/<app>`, Preferences) and grep its man page / `--help` for a FILES section. |
| `dt scan` | Sweep the dotfile zones (`~/.config/*`, `~/.*` rc-style files) and auto-track everything that passes the guards (see Safety). `~/Library` is find-only. |
| `dt add <app> [paths…]` | Track an app manually — needed for anything outside the scan zones. |
| `dt untrack <app>` | Stop tracking an app; its snapshots stay in git history. |
| `dt delete <app>` | For orphaned configs: final snapshot, delete the live files from disk, untrack. Refuses (without `--force`) if any file was never snapshotted. |
| `dt list` | Tracked apps and their files. |
| `dt backup [app]` | Copy live → store, commit if anything changed, then push if a remote is set. |
| `dt push` | Push the store to its remote. Reports how to add one if there isn't any. |
| `dt apply [app]` | Copy store → live (commits store state first so the applied version is in history). |
| `dt diff [app]` | Live vs last snapshot. |
| `dt edit <app>` | Snapshot, open `$EDITOR` on the live file, show diff, snapshot again. |
| `dt undo <app>` | Restore the pre-edit snapshot. |
| `dt open` | Open the `~/.dotfiles` store in Finder. |
| `dt install-schedule` | Write a launchd agent (`dev.dovetail.backup`) that runs a silent daily `dt backup`. |

`dt list`, `dt find` and `dt diff` take `--json` for scripts: one JSON value on
stdout, errors on stderr with a non-zero exit. `dt diff --json` reports each
file's state (`same` / `changed` / `never-backed-up`) rather than a patch,
because the human `diff` streams `git diff` straight to the terminal.

## What `dt backup` does, exactly

1. Refuse if the store working tree is dirty for the files about to be copied
   (means un-applied hand edits — copying in would clobber them).
2. For each tracked path in `manifest.json`, mirror live → `~/.dotfiles/home/…`
   (adds, updates, and deletions), skipping deny-listed, oversized (>1 MB),
   and binary files.
3. `git add -A && git commit` with a timestamp message — or report
   "nothing changed" and exit without committing.
4. Print what changed.
5. If something was committed and a remote is configured, push. A failed push
   warns but does not fail the backup: the snapshot is already safe locally,
   and the next backup pushes the backlog.

## Safety (trust boundaries — never simplify away)

- **Secrets deny-list**: hardcoded patterns (`~/.ssh/id_*`, `~/.aws/credentials`,
  `~/.netrc`, `gh/hosts.yml`, `*_history`, token-ish filenames) are never
  tracked, even inside a tracked directory. Deny-lists are incomplete by
  nature, which is why:
- **Remote is opt-in and manual**: `dt` never adds, changes, or removes a
  remote — you do that with plain git, after auditing what is in the repo.
  `dt push` and the push at the end of `dt backup` only fire when a remote
  already exists, so a store with no remote behaves exactly as before.
  The remote **must be private**: this used to be "local only, so a deny-list
  miss stays on this machine", and that mitigation is gone.
- **Junk guards**: per-file size cap (~1 MB) and binary skip, so caches and
  databases never bloat the repo.
- **Live files are only written by `dt apply`** (and `dt edit` via `$EDITOR`).
  No other command touches them.

## Status

- [x] Design settled (see decisions above)
- [x] v1 implemented — `dt.ts` (commands), `store.ts` (store/git/guards),
      `discover.ts` (scan/find), `dt.test.ts` (checks). Installed via `bun run compile`.

## Roadmap (v2, only if actually missed)

- Structured `dt get` / `dt set` for TOML/JSON configs
- `dt trace <app>` — find configs by watching file access (`fs_usage`)
- Content-scanning for secret patterns as a warning layer — more valuable now
  that the store can leave the machine
- ~~Remote backup (private repo)~~ — done, 2026-07-28. The pre-push audit was
  deliberately not built: the audit happened once, by hand, before the remote
  was added, and re-running it on every push is the kind of thing that gets
  skipped rather than read.
