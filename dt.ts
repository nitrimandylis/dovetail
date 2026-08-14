#!/usr/bin/env bun
// dt — find, back up, and safely edit app configs. Design: PRODUCT.md.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import * as store from "./store";
import * as discover from "./discover";

const HELP = `dovetail (dt) — find, back up, and edit app configs safely

  dt find <app>          locate an app's config (conventional paths + man page)
  dt scan                sweep ~/.config and ~/ dotfiles, track what passes the guards
  dt add <app> <path..>  track files/dirs manually (anything under ~)
  dt untrack <app>       stop tracking an app (its history stays in the store)
  dt delete <app>        snapshot, then delete an orphaned config from disk
  dt list                tracked apps and their files
  dt backup [app]        snapshot live files into ~/.dotfiles (a git commit)
  dt push                push the store to its remote, if you have set one
  dt apply [app]         push store copies out to the live locations
  dt diff [app]          live files vs last snapshot
  dt edit <app>          snapshot, open $EDITOR on the live files, snapshot again
  dt undo <app>          restore the previous snapshot (run again to redo)
  dt open                open the ~/.dotfiles store in Finder
  dt install-schedule    silent daily backup via launchd

  --force                override a safety refusal (backup / apply / undo)
  --json                 machine-readable output (list / diff / find)
  --help, -h             show this text and do nothing else`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function targetApps(m: store.Manifest, app?: string): string[] {
  if (app === undefined) return Object.keys(m);
  if (!(app in m)) fail(`'${app}' is not tracked. see: dt list`);
  return [app];
}

function livePathsOf(m: store.Manifest, apps: string[]): string[] {
  return apps.flatMap((a) => m[a].map(store.untildeify));
}

// Live files whose content differs from the last snapshot (HEAD).
function changedSinceSnapshot(livePaths: string[]): string[] {
  const changed: string[] = [];
  for (const p of livePaths) {
    for (const storeFile of store.walkFiles(store.liveToStore(p))) {
      const liveFile = store.storeToLive(storeFile);
      if (!fs.existsSync(liveFile)) continue;
      const head = store.headContent(liveFile);
      if (head === null) continue; // never snapshotted yet
      if (!fs.readFileSync(liveFile).equals(head)) changed.push(liveFile);
    }
  }
  return changed;
}

// dt edit needs the editor to block until the file is closed. GUI editors
// (code, zed, ...) exit immediately unless given their wait flag — without it
// the post-edit snapshot runs before the user has even seen the file.
const WAIT_FLAGS: Record<string, string> = {
  code: "--wait",
  cursor: "--wait",
  zed: "--wait",
  subl: "--wait",
  mate: "-w",
};

export function editorCommand(editorEnv: string): string[] {
  const parts = editorEnv.split(" ").filter(Boolean);
  const flag = WAIT_FLAGS[path.basename(parts[0])];
  if (flag && !parts.includes("--wait") && !parts.includes("-w")) parts.push(flag);
  return parts;
}

// ---------- commands ----------

function cmdBackup(app: string | undefined, force: boolean, message?: string): void {
  store.ensureStore();
  const m = store.readManifest();
  const apps = targetApps(m, app);
  if (apps.length === 0) fail("nothing tracked yet. run: dt scan  (or dt add)");
  const livePaths = livePathsOf(m, apps);

  const dirty = store.dirtyStoreFiles(livePaths);
  if (dirty.length > 0 && !force) {
    console.error("refusing: un-applied hand edits in the store would be overwritten:");
    for (const f of dirty) console.error("  " + f);
    fail("push them live first with `dt apply`, or discard them with `dt backup --force`.");
  }

  let copied = 0;
  const skipped: [string, string][] = [];
  for (const p of livePaths) {
    const result = store.copyIn(p);
    copied += result.copied;
    skipped.push(...result.skipped);
  }
  const committed = store.commitAll(message ?? `backup ${new Date().toISOString()}`);
  console.log(committed ? `snapshot committed (${copied} files mirrored)` : "nothing changed");
  if (skipped.length > 0) {
    console.log(`skipped ${skipped.length}:`);
    for (const [file, reason] of skipped) console.log(`  ${file}  (${reason})`);
  }
  if (committed) cmdPush(true); // quiet: a local-only store must not nag on every backup
}

// Push the store to its remote. No remote is the normal case, not an error, so
// a backup on a local-only store stays silent about it.
// ponytail: a failed push only warns — the snapshot is already committed
// locally, which is the part that must not be lost. Retry is the next backup.
function cmdPush(quiet: boolean): void {
  store.ensureStore();
  const remote = store.remoteName();
  if (remote === null) {
    if (!quiet) {
      console.log("no remote configured. the store is local-only until you add one:");
      console.log(`  git -C ${store.STORE} remote add origin <url>`);
      console.log("  use a PRIVATE repo — the secrets deny-list is not airtight.");
    }
    return;
  }
  const err = store.tryPush(remote);
  if (err === null) console.log(`pushed to ${remote}`);
  else console.error(`push to ${remote} failed (the snapshot is safe locally):\n${err}`);
}

function cmdApply(app: string | undefined, force: boolean): void {
  store.ensureStore();
  if (!store.hasCommits()) fail("the store has no snapshots yet. run: dt backup");
  const m = store.readManifest();
  const apps = targetApps(m, app);
  const livePaths = livePathsOf(m, apps);

  // conflict: live changed since the last snapshot AND differs from what we'd write
  const conflicts = changedSinceSnapshot(livePaths).filter((liveFile) => {
    const storeFile = store.liveToStore(liveFile);
    return !fs.readFileSync(liveFile).equals(fs.readFileSync(storeFile));
  });
  if (conflicts.length > 0 && !force) {
    console.error("refusing: these live files changed since their last snapshot:");
    for (const f of conflicts) console.error("  " + store.tildeify(f));
    fail("keep the live versions with `dt backup`, or overwrite them with `dt apply --force`.");
  }

  store.commitAll(`apply ${new Date().toISOString()}`); // hand edits land in history first
  let copied = 0;
  for (const p of livePaths) copied += store.copyOut(p);
  console.log(copied > 0 ? `updated ${copied} live file(s)` : "live files already match the store");
}

/**
 * Per-path drift, without producing a patch.
 *
 * `dt diff` itself shells out to `git diff` and inherits its stdio, which is
 * right for a human and useless to a consumer: the payload is a patch on the
 * terminal, not something on stdout to parse. This reports the state only.
 */
function diffStates(app: string | undefined): { app: string; file: string; state: string }[] {
  const m = store.readManifest();
  const out: { app: string; file: string; state: string }[] = [];
  for (const a of targetApps(m, app)) {
    for (const p of m[a].map(store.untildeify)) {
      const storePath = store.liveToStore(p);
      if (!fs.existsSync(storePath)) {
        out.push({ app: a, file: store.tildeify(p), state: "never-backed-up" });
        continue;
      }
      // --quiet exits 1 when they differ, which is the whole question here.
      const r = spawnSync("git", ["-C", store.STORE, "diff", "--no-index", "--quiet", "--", storePath, p]);
      out.push({ app: a, file: store.tildeify(p), state: r.status === 0 ? "same" : "changed" });
    }
  }
  return out;
}

function cmdDiff(app: string | undefined, json = false): void {
  store.ensureStore();
  if (json) return void console.log(JSON.stringify(diffStates(app)));
  const m = store.readManifest();
  for (const p of livePathsOf(m, targetApps(m, app))) {
    const storePath = store.liveToStore(p);
    if (!fs.existsSync(storePath)) {
      console.log(`${store.tildeify(p)}: never backed up`);
      continue;
    }
    // Run from HOME with relative paths so the header reads
    // "snapshot/.dotfiles/home/.zshrc  live/.zshrc" instead of two absolute
    // paths that wrap. Both sides are always under HOME.
    // exits 1 when files differ — that's normal for diff
    spawnSync(
      "git",
      [
        "-C", store.HOME,
        "diff", "--no-index",
        "--src-prefix=snapshot/", "--dst-prefix=live/",
        "--", path.relative(store.HOME, storePath), path.relative(store.HOME, p),
      ],
      { stdio: "inherit" },
    );
  }
}

function cmdEdit(app: string | undefined): void {
  if (app === undefined) fail("usage: dt edit <app>");
  const m = store.readManifest();
  targetApps(m, app);
  cmdBackup(app, false, `edit ${app} (before)`);

  const files = m[app].map(store.untildeify).filter((p) => fs.existsSync(p));
  if (files.length === 0) fail(`none of ${app}'s tracked paths exist on disk`);
  const editor = editorCommand(process.env.EDITOR ?? "vim");
  spawnSync(editor[0], [...editor.slice(1), ...files], { stdio: "inherit" });

  cmdDiff(app); // store still holds the pre-edit copy, so this shows your edit
  cmdBackup(app, false, `edit ${app}`);
}

function cmdUndo(app: string | undefined, force: boolean): void {
  if (app === undefined) fail("usage: dt undo <app>");
  store.ensureStore();
  const m = store.readManifest();
  targetApps(m, app);
  const livePaths = livePathsOf(m, [app]);
  const rels = livePaths.map((p) => "home/" + path.relative(store.HOME, p));

  const log = store.git(["log", "--format=%H", "-n", "2", "--", ...rels]).trim().split("\n").filter(Boolean);
  if (log.length < 2) fail(`no earlier snapshot of ${app} to undo to`);

  const changed = changedSinceSnapshot(livePaths);
  if (changed.length > 0 && !force) {
    console.error("refusing: live files have changes not in any snapshot:");
    for (const f of changed) console.error("  " + store.tildeify(f));
    fail("save them first with `dt backup`, or discard them with `dt undo --force`.");
  }

  store.git(["checkout", log[1], "--", ...rels]);
  store.commitAll(`undo ${app}`);
  let copied = 0;
  for (const p of livePaths) copied += store.copyOut(p);
  console.log(`restored ${app} to its previous snapshot (${copied} file(s)). run again to redo.`);
}

function cmdScan(): void {
  store.ensureStore();
  const m = store.readManifest();
  let added = 0;
  for (const c of discover.scanCandidates()) {
    const t = store.tildeify(c.livePath);
    if (!(c.app in m)) m[c.app] = [];
    if (!m[c.app].includes(t)) {
      m[c.app].push(t);
      added++;
    }
  }
  store.writeManifest(m);
  console.log(`tracking ${Object.keys(m).length} apps (${added} newly found). backing up...`);
  cmdBackup(undefined, false);
}

function cmdAdd(app: string | undefined, paths: string[]): void {
  if (app === undefined || paths.length === 0) fail("usage: dt add <app> <path> [path...]");
  store.ensureStore();
  const m = store.readManifest();
  if (!(app in m)) m[app] = [];
  for (const p of paths) {
    const live = store.untildeify(p);
    if (!fs.existsSync(live)) fail(`${p} does not exist`);
    if (path.relative(store.HOME, live).startsWith("..")) fail(`${p} is outside ~; only home files are supported`);
    if (store.isDenied(live)) fail(`${p} is on the secrets deny-list`);
    const t = store.tildeify(live);
    if (!m[app].includes(t)) m[app].push(t);
  }
  store.writeManifest(m);
  cmdBackup(app, false, `add ${app}`);
}

function cmdUntrack(app: string | undefined): void {
  if (app === undefined) fail("usage: dt untrack <app>");
  store.ensureStore();
  const m = store.readManifest();
  targetApps(m, app);
  for (const p of m[app]) {
    fs.rmSync(store.liveToStore(store.untildeify(p)), { recursive: true, force: true });
  }
  delete m[app];
  store.writeManifest(m);
  store.commitAll(`untrack ${app}`);
  console.log(`${app} untracked. its snapshots stay in the store's git history.`);
}

// For orphaned configs: final snapshot -> delete the live files -> untrack.
// Everything stays recoverable from the store's git history.
function cmdDelete(app: string | undefined, force: boolean): void {
  if (app === undefined) fail("usage: dt delete <app>");
  store.ensureStore();
  const m = store.readManifest();
  targetApps(m, app);
  const livePaths = livePathsOf(m, [app]);

  cmdBackup(app, force, `delete ${app} (final snapshot)`);

  // guard: files the store never captured (deny-list, size, binary) would be lost forever
  const unsnapshotted = livePaths
    .flatMap((p) => store.walkFiles(p))
    .filter((f) => !fs.existsSync(store.liveToStore(f)));
  if (unsnapshotted.length > 0 && !force) {
    console.error("refusing: these files were never snapshotted (deny-list/size/binary) and would be lost:");
    for (const f of unsnapshotted) console.error("  " + store.tildeify(f));
    fail("delete them anyway with `dt delete " + app + " --force`.");
  }

  for (const p of livePaths) fs.rmSync(p, { recursive: true, force: true });
  cmdUntrack(app);
  console.log(`deleted ${m[app].join(", ")} from disk.`);
}

function cmdList(json = false): void {
  store.ensureStore();
  const m = store.readManifest();
  const apps = Object.keys(m);
  // An empty manifest is an error for a human, who wants telling what to run
  // next, but an empty array for a consumer, which is a fact and not a failure.
  if (json) {
    return void console.log(JSON.stringify(apps.map((app) => ({
      app,
      paths: m[app],
      files: m[app].flatMap((p) => store.walkFiles(store.untildeify(p))).length,
    }))));
  }
  if (apps.length === 0) fail("nothing tracked yet. run: dt scan  (or dt add)");
  for (const app of apps) {
    const count = m[app].flatMap((p) => store.walkFiles(store.untildeify(p))).length;
    console.log(`${app.padEnd(24)} ${m[app].join(", ")}  (${count} files)`);
  }
}

function cmdFind(app: string | undefined, json = false): void {
  if (app === undefined) fail("usage: dt find <app>");
  const f = discover.findConfig(app);
  let foundAnything = false;

  if (json) {
    const mentioned = f.mentions.filter((m) => !f.hits.includes(m.path));
    return void console.log(JSON.stringify({
      app,
      hits: f.hits.map(store.tildeify),
      plists: f.plists.map(store.tildeify),
      mentions: mentioned.map((m) => ({ path: store.tildeify(m.path), exists: m.exists })),
      found: f.hits.length > 0 || f.plists.length > 0 || mentioned.some((m) => m.exists),
    }));
  }

  console.log("conventional paths:");
  for (const p of f.hits) {
    console.log(`  ${store.tildeify(p)}  FOUND`);
    foundAnything = true;
  }
  if (f.hits.length === 0) console.log("  none of the usual spots exist");

  if (f.plists.length > 0) {
    console.log("~/Library/Preferences:");
    for (const p of f.plists) console.log(`  ${store.tildeify(p)}`);
    foundAnything = true;
  }

  const mentions = f.mentions.filter((m) => !f.hits.includes(m.path));
  if (mentions.length > 0) {
    console.log("mentioned in man page / --help:");
    for (const m of mentions) {
      console.log(`  ${store.tildeify(m.path)}  ${m.exists ? "FOUND" : "(not present)"}`);
      if (m.exists) foundAnything = true;
    }
  }

  console.log(
    foundAnything
      ? `\ntrack it with: dt add ${app} <path>`
      : `\nnothing found — ${app} may not have a config file.`,
  );
}

// What launchd should actually run. Compiled with `bun build --compile`, the
// binary runs itself and takes the command straight away. From source it is bun
// followed by the script path. import.meta.dir points inside bun's embedded
// filesystem in the compiled case, so "is the script really on disk" separates
// the two. Getting this wrong is invisible: dt would receive the bogus script
// path as its command, print the help text, and exit 0 every single day.
export function scheduleProgramArgs(execPath: string, scriptPath: string): string[] {
  return fs.existsSync(scriptPath) ? [execPath, scriptPath, "backup"] : [execPath, "backup"];
}

// The label this used to install. Kept only so an existing install can be
// retired: leaving it loaded would run a second daily backup under the old
// plist, which looks like nothing at all until the log has two entries a day.
const OLD_SCHEDULE_LABEL = "dev.nick.dt-backup";

function cmdInstallSchedule(): void {
  const label = "dev.dovetail.backup";
  const logFile = path.join(store.STORE, ".dt-backup.log");
  const plistPath = path.join(store.HOME, "Library", "LaunchAgents", `${label}.plist`);
  const args = scheduleProgramArgs(process.execPath, path.join(import.meta.dir, "dt.ts"));
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`;
  store.ensureStore();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);

  // Retire the pre-rename install before loading the new one, so a machine that
  // had the old label ends up with one scheduled backup rather than two.
  const oldPlist = path.join(store.HOME, "Library", "LaunchAgents", `${OLD_SCHEDULE_LABEL}.plist`);
  if (fs.existsSync(oldPlist)) {
    spawnSync("launchctl", ["unload", oldPlist]);
    fs.rmSync(oldPlist);
    console.log(`removed the old ${OLD_SCHEDULE_LABEL} schedule`);
  }

  spawnSync("launchctl", ["unload", plistPath]); // ok to fail on first install
  const r = spawnSync("launchctl", ["load", plistPath], { encoding: "utf8" });
  if (r.status !== 0) fail(`launchctl load failed:\n${r.stderr}`);
  console.log(`daily backup scheduled (12:00). log: ${store.tildeify(logFile)}`);
}

// ---------- dispatch ----------

if (import.meta.main) main();

function main(): void {
// parseArgs is strict: an unknown flag throws instead of being silently
// dropped, which is what used to let `dt install-schedule --help` run the
// install. Every flag a command accepts has to be declared here.
let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  }));
} catch (e) {
  // parseArgs's own message advises using "--", which is not what a typo needs.
  const flag = e instanceof Error ? e.message.match(/'(-[^']+)'/)?.[1] : null;
  fail(flag ? `unknown flag: ${flag}\ndt --help lists the flags` : String(e));
}

// --help never runs a command, whatever it is paired with.
if (values.help || positionals.length === 0) {
  console.log(HELP);
  return;
}

const force = values.force;
const json = values.json;
const [cmd, ...args] = positionals;

try {
  switch (cmd) {
    case "find": cmdFind(args[0], json); break;
    case "scan": cmdScan(); break;
    case "add": cmdAdd(args[0], args.slice(1)); break;
    case "untrack": cmdUntrack(args[0]); break;
    case "delete": cmdDelete(args[0], force); break;
    case "list": cmdList(json); break;
    case "backup": cmdBackup(args[0], force); break;
    case "push": cmdPush(false); break;
    case "apply": cmdApply(args[0], force); break;
    case "diff": cmdDiff(args[0], json); break;
    case "edit": cmdEdit(args[0]); break;
    case "undo": cmdUndo(args[0], force); break;
    case "open": store.ensureStore(); spawnSync("open", [store.STORE]); break;
    case "install-schedule": cmdInstallSchedule(); break;
    // An unknown command used to print help and exit 0, so a typo in a script
    // looked like success. It is an error.
    default: fail(`unknown command: ${cmd}\n\n${HELP}`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
}
