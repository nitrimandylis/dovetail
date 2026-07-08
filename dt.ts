#!/usr/bin/env bun
// dt — find, back up, and safely edit app configs. Design: PRODUCT.md.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as store from "./store";
import * as discover from "./discover";

const HELP = `dovetail (dt) — find, back up, and edit app configs safely

  dt find <app>          locate an app's config (conventional paths + man page)
  dt scan                sweep ~/.config and ~/ dotfiles, track what passes the guards
  dt add <app> <path..>  track files/dirs manually (anything under ~)
  dt untrack <app>       stop tracking an app (its history stays in the store)
  dt list                tracked apps and their files
  dt backup [app]        snapshot live files into ~/.dotfiles (a git commit)
  dt apply [app]         push store copies out to the live locations
  dt diff [app]          live files vs last snapshot
  dt edit <app>          snapshot, open $EDITOR on the live files, snapshot again
  dt undo <app>          restore the previous snapshot (run again to redo)
  dt open                open the ~/.dotfiles store in Finder
  dt install-schedule    silent daily backup via launchd

  --force                override a safety refusal (backup / apply / undo)`;

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

function cmdDiff(app: string | undefined): void {
  store.ensureStore();
  const m = store.readManifest();
  for (const p of livePathsOf(m, targetApps(m, app))) {
    const storePath = store.liveToStore(p);
    if (!fs.existsSync(storePath)) {
      console.log(`${store.tildeify(p)}: never backed up`);
      continue;
    }
    // exits 1 when files differ — that's normal for diff
    spawnSync("git", ["-C", store.STORE, "diff", "--no-index", "--", storePath, p], {
      stdio: "inherit",
    });
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

function cmdList(): void {
  store.ensureStore();
  const m = store.readManifest();
  const apps = Object.keys(m);
  if (apps.length === 0) fail("nothing tracked yet. run: dt scan  (or dt add)");
  for (const app of apps) {
    const count = m[app].flatMap((p) => store.walkFiles(store.untildeify(p))).length;
    console.log(`${app.padEnd(24)} ${m[app].join(", ")}  (${count} files)`);
  }
}

function cmdFind(app: string | undefined): void {
  if (app === undefined) fail("usage: dt find <app>");
  const f = discover.findConfig(app);
  let foundAnything = false;

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

function cmdInstallSchedule(): void {
  const label = "dev.nick.dt-backup";
  const logFile = path.join(store.STORE, ".dt-backup.log");
  const plistPath = path.join(store.HOME, "Library", "LaunchAgents", `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(import.meta.dir, "dt.ts")}</string>
    <string>backup</string>
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
  spawnSync("launchctl", ["unload", plistPath]); // ok to fail on first install
  const r = spawnSync("launchctl", ["load", plistPath], { encoding: "utf8" });
  if (r.status !== 0) fail(`launchctl load failed:\n${r.stderr}`);
  console.log(`daily backup scheduled (12:00). log: ${store.tildeify(logFile)}`);
}

// ---------- dispatch ----------

if (import.meta.main) main();

function main(): void {
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const [cmd, ...args] = argv.filter((a) => !a.startsWith("--"));

try {
  switch (cmd) {
    case "find": cmdFind(args[0]); break;
    case "scan": cmdScan(); break;
    case "add": cmdAdd(args[0], args.slice(1)); break;
    case "untrack": cmdUntrack(args[0]); break;
    case "list": cmdList(); break;
    case "backup": cmdBackup(args[0], force); break;
    case "apply": cmdApply(args[0], force); break;
    case "diff": cmdDiff(args[0]); break;
    case "edit": cmdEdit(args[0]); break;
    case "undo": cmdUndo(args[0], force); break;
    case "open": store.ensureStore(); spawnSync("open", [store.STORE]); break;
    case "install-schedule": cmdInstallSchedule(); break;
    default: console.log(HELP);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
}
