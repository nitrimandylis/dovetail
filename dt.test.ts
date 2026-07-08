// Smallest runnable checks: deny-list, app naming, and a full
// scan -> backup -> hand-edit -> apply roundtrip in a temp directory.
import { test, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { isDenied, HOME } from "./store";
import { appNameFromDotfile } from "./discover";

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

test("GUI editors get a wait flag, terminal editors don't", async () => {
  const { editorCommand } = await import("./dt");
  expect(editorCommand("code")).toEqual(["code", "--wait"]);
  expect(editorCommand("code --wait")).toEqual(["code", "--wait"]); // no double flag
  expect(editorCommand("zed")).toEqual(["zed", "--wait"]);
  expect(editorCommand("vim")).toEqual(["vim"]);
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
