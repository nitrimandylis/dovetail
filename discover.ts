// discover.ts — `dt scan` (sweep the dotfile zones) and `dt find <app>`
// (probe conventional locations + grep man page / --help for paths).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOME, isDenied } from "./store";

// Home-directory dotfiles that are state, not config.
const NOISE = [
  ".DS_Store",
  ".CFUserTextEncoding",
  ".lesshst",
  ".viminfo",
  ".localized",
  ".hushlogin",
];

// ".zshrc" -> "zsh", ".gitconfig" -> "git", ".tmux.conf" -> "tmux"
export function appNameFromDotfile(filename: string): string {
  let name = filename.replace(/^\./, "");
  name = name.replace(/\.conf$/, "").replace(/config$/, "").replace(/rc$/, "");
  // ponytail: crude stems (".zshenv" stays "zshenv") — regroup with `dt add` if it bothers you
  return name === "" ? filename.replace(/^\./, "") : name;
}

// "starship.toml" -> "starship"
function appNameFromConfigEntry(entry: string): string {
  return entry.replace(/\.(toml|ya?ml|json|conf|ini)$/, "");
}

// Everything `dt scan` would track: ~/.config/* entries plus ~/.* files.
// Guards (deny-list per file, size, binary) run later, at copy time; the
// deny-list also runs here so secret top-level files never enter the manifest.
export function scanCandidates(): { app: string; livePath: string }[] {
  const found: { app: string; livePath: string }[] = [];

  const configDir = path.join(HOME, ".config");
  if (fs.existsSync(configDir)) {
    for (const entry of fs.readdirSync(configDir).sort()) {
      if (entry.startsWith(".")) continue;
      found.push({ app: appNameFromConfigEntry(entry), livePath: path.join(configDir, entry) });
    }
  }

  for (const entry of fs.readdirSync(HOME).sort()) {
    if (!entry.startsWith(".") || entry === ".config") continue;
    if (NOISE.includes(entry) || entry.startsWith(".zcompdump")) continue;
    const full = path.join(HOME, entry);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue; // broken symlink
    }
    if (!st.isFile()) continue; // home dot-DIRS are too risky to auto-track (.ssh, caches)
    if (isDenied(full)) continue;
    found.push({ app: appNameFromDotfile(entry), livePath: full });
  }
  return found;
}

// ---------- dt find <app> ----------

export type Findings = {
  hits: string[]; // conventional paths that exist
  misses: string[]; // conventional paths that don't
  plists: string[]; // ~/Library/Preferences matches
  mentions: { path: string; exists: boolean }[]; // paths named in man page / --help
};

export function findConfig(app: string): Findings {
  const a = app.toLowerCase();
  const capitalized = a.charAt(0).toUpperCase() + a.slice(1);
  const conventional = [
    path.join(HOME, ".config", a),
    path.join(HOME, `.${a}rc`),
    path.join(HOME, `.${a}`),
    path.join(HOME, `.${a}.conf`),
    path.join(HOME, "Library", "Application Support", a),
    path.join(HOME, "Library", "Application Support", capitalized),
  ];
  const hits = conventional.filter((p) => fs.existsSync(p));
  const misses = conventional.filter((p) => !fs.existsSync(p));

  const prefsDir = path.join(HOME, "Library", "Preferences");
  const plists = fs.existsSync(prefsDir)
    ? fs
        .readdirSync(prefsDir)
        .filter((f) => f.toLowerCase().includes(a))
        .map((f) => path.join(prefsDir, f))
    : [];

  return { hits, misses, plists, mentions: pathMentions(a) };
}

// Grep the app's man page and --help output for home-relative paths.
function pathMentions(app: string): { path: string; exists: boolean }[] {
  let text = "";

  const man = spawnSync("man", [app], {
    env: { ...process.env, MANPAGER: "cat", PAGER: "cat" },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (man.status === 0) text += man.stdout.replace(/.\x08/g, ""); // strip overstrike bold

  const onPath = spawnSync("which", [app]).status === 0;
  if (onPath) {
    const help = spawnSync(app, ["--help"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 10 * 1024 * 1024,
    });
    text += "\n" + (help.stdout ?? "") + (help.stderr ?? "");
  }

  return extractPaths(text, HOME)
    .slice(0, 12)
    .map((p) => ({ path: p, exists: fs.existsSync(p) }));
}

/**
 * The pure half of the grep, split out so it can be tested without running
 * `man`. Man pages end sentences with the path itself ("...lives in
 * ~/.config/app."), so a trailing period is punctuation, not a filename.
 */
export function extractPaths(text: string, home: string): string[] {
  const re = /(?:~|\$HOME|\$XDG_CONFIG_HOME)\/[\w.\-/]+/g;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.match(re) ?? []) {
    const expanded = match
      .replace(/[.,;:]+$/, "")
      .replace(/^\$XDG_CONFIG_HOME/, path.join(home, ".config"))
      .replace(/^(?:~|\$HOME)/, home);
    if (seen.has(expanded)) continue;
    seen.add(expanded);
    out.push(expanded);
  }
  return out;
}
