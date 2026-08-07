---
name: dovetail-cli
description: Drive the dovetail (`dt`) CLI — find, back up, diff, and restore macOS app configs through a local git store at ~/.dotfiles. Use whenever the user asks where an app keeps its config, wants a dotfile backed up or restored, says they broke their zshrc or any other config, wants to see what changed in a config, mentions dotfiles or ~/.dotfiles, or is about to edit a config file that should be snapshotted first.
---

# dovetail (`dt`)

`dt` mirrors live config files into `~/.dotfiles`, a local git repo where every backup is a commit and
every mistake is an undo. Compiled Bun binary at `~/.bun/bin/dt`. Full offline reference: `man dt`.

Nothing is symlinked. Live files stay where they are and `dt` copies them **in** (`backup`) or **out**
(`apply`). That symmetry is the whole design: hand-editing the store and pushing it live is the same
operation as restoring a backup.

## Before touching any config file

If the user is about to edit a tracked config — or you are — snapshot first:

```bash
dt backup <app>     # or `dt edit <app>`, which snapshots, opens $EDITOR, and snapshots again
```

A no-op commit costs nothing, so there is never a reason to skip this. This is the single most useful
thing dovetail does for an agent: it makes an edit reversible before you make it.

## Reading, always safe

```bash
dt list             # tracked apps and their files
dt find <app>       # locate a config: conventional paths, then the man page's FILES section
dt diff [app]       # live files vs last snapshot, straight from git diff

dt list --json      # [{app, paths, files}] — empty array when nothing is tracked
dt find <app> --json# {app, hits, plists, mentions: [{path, exists}], found}
dt diff [app] --json# [{app, file, state}] — state is same | changed | never-backed-up
```

`dt find` is the right first move whenever the question is "where does <app> keep its settings". It
probes `~/.config`, `~/.<app>rc`, `~/Library/Application Support`, then greps the app's man page and
`--help` for path mentions. Reach for it before guessing a path.

## Writing

```bash
dt add <app> <path…>   # track files or dirs manually (must be under ~)
dt scan                # sweep ~/.config and home dotfiles, auto-track what passes the guards
dt backup [app]        # mirror live → store, commit (and push if a remote exists)
dt apply [app]         # copy store → live locations
dt undo <app>          # restore the previous snapshot; run it again to redo
dt untrack <app>       # stop tracking; history stays in the store
dt delete <app>        # final snapshot, then remove an orphaned config from disk
dt push                # push the store, only to a remote that already exists
dt install-schedule    # silent daily backup via launchd
```

`dt apply` and `dt undo` overwrite live files. Say which files will change and get the user's yes before
running either.

## Things that will bite you

- **`dt diff --json` is not the patch.** Plain `dt diff` streams `git diff` to
  the terminal and puts nothing parseable on stdout, so `--json` reports each
  file's state instead. If the user wants to see the actual changes, hand them
  `dt diff <app>` to run themselves.
- **`dt list` with nothing tracked errors for a human and returns `[]` for
  `--json`.** An empty array is the real answer, not a failed call.
- **`--help` is safe on every command, and unknown flags are rejected.** Before
  2026-08-07 flags were filtered out unparsed, so `dt install-schedule --help`
  silently performed the install and a typo like `--frce` was ignored. Both now
  exit without running anything.

- **The conflict rule is load bearing.** If both the live file and the store changed since the last
  snapshot, `dt` refuses and makes you pick a direction. That refusal is correct — neither side silently
  loses. Resolve it by reading `dt diff` and deciding, not by reaching for `--force`.
- **`--force` overrides a safety refusal on `backup`, `apply` and `undo`.** Treat it the way you would
  treat `git push --force`: only after the user has seen what the refusal was protecting, and never as
  a first response to an error.
- **`dt undo` is a toggle, not a stack.** Two runs put you back where you started. If the user wants to
  go further back, that is `git` inside `~/.dotfiles`, not `undo` repeated.
- **A hardcoded deny-list keeps ssh keys, tokens, and shell history out of the store**, plus binaries and
  files over 1MB. Do not try to route around it to get a file tracked. If something legitimately needs
  tracking and is being excluded, tell the user rather than working around the guard — see the global
  rule about never handling secrets.
- **The store is only private if the user made it private.** Once it leaves the machine the deny-list is
  the only thing protecting whatever it missed. Never run `dt push` unprompted, and never suggest adding
  a public remote.
- **`dt delete` removes a config from disk.** It refuses if any file was never snapshotted, which is the
  guard that makes it survivable. Confirm explicitly before running it.
- **`dt edit` appends `--wait` for GUI editors**, because they exit immediately and would otherwise make
  the second snapshot fire before you have typed anything. If the user's `$EDITOR` is a GUI editor and
  the second snapshot looks empty, that is the failure mode to check.
