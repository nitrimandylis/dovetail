// Builds the demo world the README gif is recorded against: a fake HOME with a
// couple of plausible configs in it. dt reads HOME through store.ts, so
// pointing HOME here keeps the recording away from your real ~/.config and
// your real ~/.dotfiles store.
//
// Run: bun tapes/fixture.ts   (tapes/dovetail.tape does this itself)

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const home = join(import.meta.dir, "fixtures", "home");

const files: Record<string, string> = {
  ".config/ghostty/config": [
    "font-family = Cascadia Code NF",
    "font-size = 19",
    "theme = spider-verse",
    "background-opacity = 0.92",
    "window-padding-x = 12",
    "window-padding-y = 12",
    "",
  ].join("\n"),

  ".config/btop/btop.conf": [
    'color_theme = "spider-verse"',
    "theme_background = False",
    "update_ms = 1000",
    "",
  ].join("\n"),

  ".zshrc": ["export EDITOR=nvim", 'alias ll="ls -lah"', ""].join("\n"),
};

rmSync(join(import.meta.dir, "fixtures"), { recursive: true, force: true });
for (const [rel, body] of Object.entries(files)) {
  const full = join(home, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  await Bun.write(full, body);
}

console.log(`fixture home: ${home}`);
