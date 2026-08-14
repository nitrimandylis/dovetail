// Smallest runnable checks: deny-list, app naming, and a full
// scan -> backup -> hand-edit -> apply roundtrip in a temp directory.
import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { isDenied, HOME } from "./store";
import { appNameFromDotfile, extractPaths } from "./discover";

test("deny-list blocks secrets, allows configs", () => {
  expect(isDenied(path.join(HOME, ".aws/credentials"))).toBe(true);
  expect(isDenied(path.join(HOME, ".ssh/id_ed25519"))).toBe(true);
  expect(isDenied(path.join(HOME, ".config/gh/hosts.yml"))).toBe(true);
  expect(isDenied(path.join(HOME, ".zsh_history"))).toBe(true);
  expect(isDenied(path.join(HOME, ".config/myapp/secret.json"))).toBe(true);

  expect(isDenied(path.join(HOME, ".ssh/config"))).toBe(false);
  expect(isDenied(path.join(HOME, ".zshrc"))).toBe(false);
  expect(isDenied(path.join(HOME, ".config/gh/config.yml"))).toBe(false);
});

test("man-page paths drop sentence punctuation and duplicates", () => {
  const text = [
    "Config is read from ~/.config/ghostty/config.",
    "Themes live in ~/.config/ghostty/themes; see also $XDG_CONFIG_HOME/ghostty,",
    "and again ~/.config/ghostty/config for good measure.",
  ].join("\n");

  expect(extractPaths(text, "/home/x")).toEqual([
    "/home/x/.config/ghostty/config",
    "/home/x/.config/ghostty/themes",
    "/home/x/.config/ghostty",
  ]);
});

test("GUI editors get a wait flag, terminal editors don't", async () => {
  const { editorCommand } = await import("./dt");
  expect(editorCommand("code")).toEqual(["code", "--wait"]);
  expect(editorCommand("code --wait")).toEqual(["code", "--wait"]); // no double flag
  expect(editorCommand("zed")).toEqual(["zed", "--wait"]);
  expect(editorCommand("vim")).toEqual(["vim"]);
});

test("the schedule runs the compiled binary directly, the script only if it exists", async () => {
  const { scheduleProgramArgs } = await import("./dt");
  const realScript = path.join(import.meta.dir, "dt.ts");
  expect(scheduleProgramArgs("/usr/bin/bun", realScript)).toEqual(["/usr/bin/bun", realScript, "backup"]);
  // compiled: import.meta.dir points into bun's embedded fs, so no script on disk
  expect(scheduleProgramArgs("/Users/x/.bun/bin/dt", "/$bunfs/root/dt.ts")).toEqual([
    "/Users/x/.bun/bin/dt",
    "backup",
  ]);
});

test("dotfile names map to app names", () => {
  expect(appNameFromDotfile(".zshrc")).toBe("zsh");
  expect(appNameFromDotfile(".gitconfig")).toBe("git");
  expect(appNameFromDotfile(".tmux.conf")).toBe("tmux");
  expect(appNameFromDotfile(".profile")).toBe("profile");
});

// Run dt as a subprocess against a throwaway HOME and store.
function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-test-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  return { home, env: { ...process.env, DT_HOME: home, DT_STORE: path.join(tmp, "store") } };
}

function dt(env: Record<string, string | undefined>, ...args: string[]) {
  return spawnSync("bun", [path.join(import.meta.dir, "dt.ts"), ...args], {
    env,
    encoding: "utf8",
  });
}

test("scan skips secrets, backup snapshots, hand-edit + apply updates live", () => {
  const { home, env } = makeEnv();
  fs.mkdirSync(path.join(home, ".config/foo"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/foo/config.toml"), "color = true\n");
  fs.writeFileSync(path.join(home, ".zshrc"), "alias a=1\n");
  fs.writeFileSync(path.join(home, ".netrc"), "machine x login y password z\n");
  fs.mkdirSync(path.join(home, ".config/foo/.zsh_sessions"));
  fs.writeFileSync(path.join(home, ".config/foo/.zsh_sessions/x.session"), "state\n");

  let r = dt(env, "scan");
  expect(r.status).toBe(0);

  const storeHome = path.join(env.DT_STORE!, "home");
  expect(fs.existsSync(path.join(storeHome, ".config/foo/config.toml"))).toBe(true);
  expect(fs.existsSync(path.join(storeHome, ".zshrc"))).toBe(true);
  expect(fs.existsSync(path.join(storeHome, ".netrc"))).toBe(false); // deny-listed
  expect(fs.existsSync(path.join(storeHome, ".config/foo/.zsh_sessions"))).toBe(false); // state skipped

  // hand-edit the store copy, apply pushes it to the live location
  fs.writeFileSync(path.join(storeHome, ".zshrc"), "alias a=2\n");
  r = dt(env, "apply");
  expect(r.status).toBe(0);
  expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("alias a=2\n");
});

test("delete snapshots, refuses on unsnapshotted files, then removes from disk", () => {
  const { home, env } = makeEnv();
  const appDir = path.join(home, ".config/foo");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, "config.toml"), "color = true\n");
  fs.writeFileSync(path.join(appDir, "api-token.txt"), "hunter2\n"); // deny-listed, never snapshotted
  expect(dt(env, "add", "foo", appDir).status).toBe(0);

  expect(dt(env, "delete", "foo").status).not.toBe(0); // token file would be lost
  expect(fs.existsSync(appDir)).toBe(true); // nothing deleted on refusal

  expect(dt(env, "delete", "foo", "--force").status).toBe(0);
  expect(fs.existsSync(appDir)).toBe(false); // live config gone
  expect(dt(env, "list").stdout.includes("foo")).toBe(false); // untracked
  // the deleted config is still recoverable from history (commit before the untrack)
  const show = spawnSync(
    "git",
    ["-C", env.DT_STORE!, "show", "HEAD~1:home/.config/foo/config.toml"],
    { encoding: "utf8" },
  );
  expect(show.stdout).toBe("color = true\n");
});

test("push is a no-op without a remote, and backup pushes once there is one", () => {
  const { home, env } = makeEnv();
  fs.writeFileSync(path.join(home, ".zshrc"), "v1\n");
  expect(dt(env, "add", "zsh", path.join(home, ".zshrc")).status).toBe(0);

  // local-only store: push explains itself and succeeds without doing anything
  let r = dt(env, "push");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("no remote configured");

  const remote = path.join(env.DT_STORE!, "..", "remote.git");
  spawnSync("git", ["init", "-q", "--bare", remote]);
  spawnSync("git", ["-C", env.DT_STORE!, "remote", "add", "origin", remote]);

  fs.writeFileSync(path.join(home, ".zshrc"), "v2\n");
  r = dt(env, "backup");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("pushed to origin");

  const show = spawnSync("git", ["-C", remote, "show", "HEAD:home/.zshrc"], { encoding: "utf8" });
  expect(show.stdout).toBe("v2\n");
});

test("apply refuses a conflict, obeys --force; backup refuses a dirty store", () => {
  const { home, env } = makeEnv();
  fs.writeFileSync(path.join(home, ".zshrc"), "v1\n");
  expect(dt(env, "add", "zsh", path.join(home, ".zshrc")).status).toBe(0);

  // both sides change since the snapshot -> conflict
  fs.writeFileSync(path.join(home, ".zshrc"), "live-edit\n");
  const storeCopy = path.join(env.DT_STORE!, "home", ".zshrc");
  fs.writeFileSync(storeCopy, "store-edit\n");

  expect(dt(env, "apply").status).not.toBe(0);
  expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("live-edit\n"); // untouched

  expect(dt(env, "backup").status).not.toBe(0); // dirty store refusal, same standoff

  expect(dt(env, "apply", "--force").status).toBe(0);
  expect(fs.readFileSync(path.join(home, ".zshrc"), "utf8")).toBe("store-edit\n");
});

// A flag must never be silently dropped: `dt install-schedule --help` used to
// ignore --help and perform the install. `list` stands in for every command
// here because the --help check sits before the dispatch switch, so proving it
// for one command proves the mechanism; and `list` is read-only if it regresses.
test("--help prints help instead of running the command", () => {
  const script = path.join(import.meta.dir, "dt.ts");
  const run = (args: string[]) =>
    spawnSync("bun", [script, ...args], { encoding: "utf8" });

  for (const flag of ["--help", "-h"]) {
    const r = run(["list", flag]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dovetail (dt) — find, back up, and edit app configs safely");
    // help is the whole output: nothing was printed after it, so `list` never ran
    expect(r.stdout.trim().endsWith("show this text and do nothing else")).toBe(true);
  }

  // bare `dt` still prints help
  expect(run([]).status).toBe(0);
  expect(run([]).stdout).toContain("dovetail (dt)");

  // an unknown flag is an error, not something to shrug off
  const bad = run(["backup", "--frce"]);
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("--frce");

  // an unknown command used to exit 0, so a typo looked like success
  const typo = run(["backpu"]);
  expect(typo.status).toBe(1);
  expect(typo.stderr).toContain("unknown command: backpu");
});
