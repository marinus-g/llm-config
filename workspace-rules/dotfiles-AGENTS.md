# AGENTS.md — Dotfiles

Arch Linux Hyprland dotfiles managed via **GNU stow**. All config packages are under `~/.dotfiles`; stow creates relative symlinks into `~/.config/<tool>`.

## Symlink Layout

| Repo folder | Symlinks to |
|---|---|
| `hyprland/.config/hypr/` | `~/.config/hypr/` |
| `waybar/.config/waybar/` | `~/.config/waybar/` |
| `ghostty/.config/ghostty/` | `~/.config/ghostty/` |
| `rofi/.config/rofi/` | `~/.config/rofi/` |
| `quickshell/.config/quickshell/` | `~/.config/quickshell/` |

Spicetify (`~/.config/spicetify/`) is **not** symlinked — Spicetify writes runtime-generated files there. Its config is tracked in `.config/spicetify/` and deployed via `install-scripts/install-spicetify.sh` (copies themes/extensions/apps then runs `spicetify apply`). Re-link other packages with `stow` from the repo root after adding/removing.

## Hyprland Config (Highest Signal)

Hyprland 0.55+ uses **Lua** config. Both `.lua` and `.conf` files coexist in `hyprland/.config/hypr/` — `.lua` is active, `.conf` is fallback/reference.

- `hyprland.lua` is the entrypoint. It `require()`s all modules.
- Programs are defined in `programs.lua` (`M.terminal`, `M.browser`, etc.). Always reference programs through this module.
- Use Hyprland Lua API: `hl.*`, `hl.dsp.*`. See `docs/hyprland-lua-migration-summary.md` for `.conf → .lua` mappings.
- **Validate before reload**: `luac -p` catches syntax errors; `hyprctl configerrors` catches runtime errors `luac` can't see.

## Dual Monitor Setup

`split-monitor-workspaces` plugin manages per-monitor workspace sets. Monitors: `DP-3` (main), `DP-2` (secondary), `HDMI-A-2` (third).

Autostart (`autostart.lua`) uses a shell pipeline with timed sleeps for focus-spawn ordering. Don't remove the sleeps — focus dispatches return immediately and windows will spawn on the wrong monitor without them.

## Install System

`install-all.sh` runs `install-scripts/install-*.sh` in glob order (yay first, hyprland core, then rest). Arch/Pacman-based, idempotent. Use `yay` for AUR packages.

## Component Overview

- **Waybar** — status bar with dynamic modules. Config in `waybar/.config/waybar/config.jsonc`.
- **Ghostty** — terminal emulator. Default terminal (`programs.lua`).
- **Rofi** — app launcher (`rofi -show drun`).
- **Quickshell** — shell-based widget system with wallpaper integration.
- **swaync** — notification daemon.
- **cliphist** — clipboard manager (wl-clipboard frontend).
- **awwww** — animated wallpaper daemon.
- **matugen** — GTK theme generator from wallpaper.
- **Spicetify** — Spotify client customization (adaptive colors).

## Docs

`docs/` contains migration notes, autostart fixes, and AI-assisted work records. Read `docs/hyprland-lua-migration-summary.md` for Hyprland Lua API reference and known gotchas.

## Conventions

- No `.gitignore` at root — repo tracks config files, not build artifacts.
- Hyprland Lua: dotted config keys use string syntax (`["col.active_border"] = "..."`), not nested objects.
- Hyprland Lua: `hl.exec_cmd` doesn't invoke a shell — pipeline operators (`&&`, `|`) need `sh -c "..."`.
