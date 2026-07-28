// store.ts — the snapshot store (~/.dotfiles): path mapping, manifest,
// git plumbing, and the guarded copy operations in both directions.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// DT_HOME / DT_STORE exist so tests can point everything at a temp dir.
export const HOME = process.env.DT_HOME ?? os.homedir();
export const STORE = process.env.DT_STORE ?? path.join(HOME, ".dotfiles");
const MANIFEST = path.join(STORE, "manifest.json");
const MAX_FILE_SIZE = 1024 * 1024; // junk guard: real configs are small

export type Manifest = Record<string, string[]>; // app -> ["~/path", ...]

// ---------- path mapping: live ~/x  <->  store ~/.dotfiles/home/x ----------

export function tildeify(livePath: string): string {
  return "~/" + path.relative(HOME, livePath);
}

export function untildeify(p: string): string {
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : path.resolve(p);
}

export function liveToStore(livePath: string): string {
  return path.join(STORE, "home", path.relative(HOME, livePath));
}

export function storeToLive(storePath: string): string {
  return path.join(HOME, path.relative(path.join(STORE, "home"), storePath));
}

// ---------- secrets deny-list ----------
// Trust boundary: these never enter the repo, even inside a tracked directory.
// A deny-list is incomplete by nature. This used to be mitigated by the store
// being local-only; it isn't any more (see the remote section below), so the
// remote MUST be a private repo and a deny-list miss is now a real leak.
// See PRODUCT.md.

export function isDenied(livePath: string): boolean {
  const rel = path.relative(HOME, livePath);
  const relSlash = rel + "/"; // so ".aws" matches the ".aws/" prefix too
  const base = path.basename(rel).toLowerCase();

  if (rel === ".ssh/config") return false; // the one non-secret in .ssh
  for (const dir of [".ssh/", ".gnupg/", ".aws/", ".kube/"]) {
    if (relSlash.startsWith(dir)) return true;
  }
  if (rel === ".netrc" || rel === ".npmrc") return true; // both can hold auth tokens
  if (rel === ".config/gh/hosts.yml") return true; // GitHub CLI oauth token
  if (rel === ".docker/config.json") return true; // registry auth

  for (const ext of [".pem", ".key", ".p12", ".pfx"]) {
    if (base.endsWith(ext)) return true;
  }
  if (base === ".env" || base.endsWith(".env")) return true;
  for (const word of ["history", "token", "secret", "credential", "password", "cookie"]) {
    if (base.includes(word)) return true;
  }
  return false;
}

// ---------- junk guards ----------

function isBinary(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(8000);
  const n = fs.readSync(fd, buf, 0, 8000, 0);
  fs.closeSync(fd);
  return buf.subarray(0, n).includes(0); // null byte = not a text config
}

// Reason this file must stay out of the store, or null if it is fine.
export function skipReason(livePath: string): string | null {
  if (isDenied(livePath)) return "deny-list";
  const st = fs.statSync(livePath);
  if (st.size > MAX_FILE_SIZE) return "over 1MB";
  if (st.size > 0 && isBinary(livePath)) return "binary";
  return null;
}

// ---------- git plumbing (all git runs inside the store) ----------

export function git(args: string[], allowFail = false): string {
  const r = spawnSync("git", ["-C", STORE, ...args], { encoding: "utf8" });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed:\n${r.stderr}`);
  }
  return r.stdout ?? "";
}

export function ensureStore(): void {
  fs.mkdirSync(path.join(STORE, "home"), { recursive: true });
  if (!fs.existsSync(path.join(STORE, ".git"))) {
    const r = spawnSync("git", ["init", "-q", STORE], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git init failed:\n${r.stderr}`);
    fs.writeFileSync(path.join(STORE, ".gitignore"), ".dt-backup.log\n");
  }
  if (!fs.existsSync(MANIFEST)) fs.writeFileSync(MANIFEST, "{}\n");
}

export function hasCommits(): boolean {
  return spawnSync("git", ["-C", STORE, "rev-parse", "--verify", "HEAD"]).status === 0;
}

// Stage everything and commit; false if there was nothing to commit.
export function commitAll(message: string): boolean {
  git(["add", "-A"]);
  if (git(["status", "--porcelain"]).trim() === "") return false;
  git(["commit", "-q", "-m", message]);
  return true;
}

// Store files (relative paths) with uncommitted changes under the given live paths.
export function dirtyStoreFiles(livePaths: string[]): string[] {
  if (!fs.existsSync(path.join(STORE, ".git"))) return [];
  const rels = livePaths.map((p) => path.join("home", path.relative(HOME, p)));
  const out = git(["status", "--porcelain", "--", ...rels]);
  return out.split("\n").filter(Boolean).map((line) => line.slice(3));
}

// Content of a live file's last snapshot (HEAD), or null if never snapshotted.
export function headContent(liveFile: string): Buffer | null {
  const rel = "home/" + path.relative(HOME, liveFile);
  const r = spawnSync("git", ["-C", STORE, "show", `HEAD:${rel}`]);
  return r.status === 0 ? Buffer.from(r.stdout) : null;
}

// ---------- remote ----------
// A remote is opt-in: you add it yourself with plain git, after checking what is
// in the repo. dt only ever pushes to one that already exists, and never adds,
// changes, or removes it.

export function remoteName(): string | null {
  const out = git(["remote"], true).trim();
  return out === "" ? null : out.split("\n")[0];
}

// Push the current branch. `-u` so this also works on a store that has a remote
// but no upstream set yet. Returns null on success, else git's error output.
export function tryPush(remote: string): string | null {
  const r = spawnSync("git", ["-C", STORE, "push", "-u", remote, "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? null : r.stderr.trim() || "git push failed";
}

// ---------- manifest ----------

export function readManifest(): Manifest {
  if (!fs.existsSync(MANIFEST)) return {};
  return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
}

export function writeManifest(m: Manifest): void {
  const sorted: Manifest = {};
  for (const app of Object.keys(m).sort()) sorted[app] = m[app];
  fs.writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + "\n");
}

// ---------- copying ----------

// All regular files under a path (which may itself be a single file).
export function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const st = fs.statSync(root);
  if (st.isFile()) return [root];
  if (!st.isDirectory()) return []; // sockets, fifos
  const out: string[] = [];
  for (const entry of fs.readdirSync(root).sort()) {
    if (entry === ".git" || entry === "node_modules") continue; // never config
    if (entry === ".DS_Store") continue; // Finder noise
    if (entry === ".zsh_sessions" || entry.startsWith(".zcompdump")) continue; // zsh state
    out.push(...walkFiles(path.join(root, entry)));
  }
  return out;
}

function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, fs.statSync(src).mode);
}

// Mirror one tracked live path into the store (adds, updates, deletions).
export function copyIn(livePath: string): { copied: number; skipped: [string, string][] } {
  const skipped: [string, string][] = [];
  const kept = new Set<string>();
  let copied = 0;
  for (const file of walkFiles(livePath)) {
    const reason = skipReason(file);
    if (reason !== null) {
      skipped.push([tildeify(file), reason]);
      continue;
    }
    const dest = liveToStore(file);
    kept.add(dest);
    copyFile(file, dest);
    copied++;
  }
  // mirror deletions: store copies with no live counterpart disappear
  for (const file of walkFiles(liveToStore(livePath))) {
    if (!kept.has(file)) fs.rmSync(file);
  }
  return { copied, skipped };
}

// Copy one tracked path store -> live. Only writes files that actually differ.
// ponytail: never deletes live files, even ones deleted in the store — safer.
export function copyOut(livePath: string): number {
  let copied = 0;
  for (const file of walkFiles(liveToStore(livePath))) {
    const dest = storeToLive(file);
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(fs.readFileSync(file))) continue;
    copyFile(file, dest);
    copied++;
  }
  return copied;
}
