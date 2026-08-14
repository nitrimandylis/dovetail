# The README hero. Record with:  vhs tapes/dovetail.tape   (from the repo root)
#
# Runs against tapes/fixture.ts, not your real machine: HOME is redirected to a
# fake one, so `dt` finds fixture configs and writes a fixture store. Your real
# ~/.config and ~/.dotfiles are never touched.
#
# `dt` is a shell function pointing at the repo, so the tape records the code in
# this working tree rather than whatever binary happens to be installed.
#
# Terminal settings match ghostty on the machine this was shot on:
# Cascadia Code NF at 19, padding 12, swatch theme spider-verse.

Output .github/assets/dovetail.gif

Set Shell "zsh"
Set FontFamily "Cascadia Code NF"
Set FontSize 19
Set Width 1200
Set Height 630
Set Padding 12
Set TypingSpeed 40ms
Set Theme { "name": "spider-verse", "background": "#0d0a1e", "foreground": "#ece9f7", "cursor": "#ff1f6b", "selection": "#272049", "black": "#1b1638", "red": "#b01c18", "green": "#2fbf7a", "yellow": "#d99a12", "blue": "#6b4fd6", "magenta": "#d6155a", "cyan": "#00a8cc", "white": "#c9c4dd", "brightBlack": "#5c5480", "brightRed": "#ff473c", "brightGreen": "#3dffa8", "brightYellow": "#ffc93c", "brightBlue": "#8b6cff", "brightMagenta": "#ff1f6b", "brightCyan": "#00d4ff", "brightWhite": "#ece9f7" }

Hide
Type "DT=$PWD && bun tapes/fixture.ts > /dev/null && export HOME=$DT/tapes/fixtures/home && dt() { bun $DT/dt.ts $@ } && export PS1='%F{5}❯%f ' && cd ~ && clear"
Enter
Sleep 3s
Show

Sleep 1s
Type "dt find ghostty"
Sleep 400ms
Enter
Sleep 3s

Type "dt add ghostty ~/.config/ghostty"
Sleep 400ms
Enter
Sleep 2s

Type "echo 'font-size = 21' >> ~/.config/ghostty/config"
Sleep 400ms
Enter
Sleep 1s

Type "dt diff ghostty"
Sleep 400ms
Enter
Sleep 3500ms

Type "dt backup ghostty"
Sleep 400ms
Enter
Sleep 3s
