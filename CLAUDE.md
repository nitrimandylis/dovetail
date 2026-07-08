# dt — project instructions

Read PRODUCT.md first; it holds the settled design. Don't re-litigate decisions
recorded there.

## Stack & conventions

- Bun + TypeScript. Zero runtime dependencies — arg parsing via
  `node:util` `parseArgs`, file ops via `node:fs`, git via `Bun.spawn`.
  Ask before adding any dependency.
- Global install is `bun link` (binary name `dt`). Never instruct running
  scripts by path; the tool is used from zsh anywhere.
- Code at IB-CS-student level: plain, explicit, defensible line-by-line.
  No clever one-liners, no generics gymnastics.

## Invariants (do not break)

- Live config files are written ONLY by `dt apply` and `dt edit` (via $EDITOR).
  Every other command treats the live filesystem as read-only.
- The store is `~/.dotfiles`, a LOCAL-ONLY git repo. Never add a remote,
  never push, never suggest auto-push.
- The secrets deny-list and the conflict rule (refuse when both live and store
  changed since last snapshot) are trust boundaries — never bypass or "simplify"
  them, and any new command that copies files must go through the same guards.
- Every destructive direction (apply over changed live files) requires an
  explicit `--force`.

## Testing

- Non-trivial logic (discovery heuristics, deny-list matching, conflict
  detection) gets one smallest runnable check each. Point file operations at a
  temp directory in tests — never at the real `~/.dotfiles` or live configs.
- Run `bun test` and a typecheck before calling anything done.
