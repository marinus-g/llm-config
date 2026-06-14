---
description: Validate and reload Hyprland Lua config
agent: orchestrator
---

Validate the Hyprland Lua configuration and reload if valid.

1. Run `luac -p ~/dotfiles/hyprland/.config/hypr/hyprland.lua` to check syntax
2. If syntax is valid, run `hyprctl reload`
3. Run `hyprctl configerrors` to check for runtime errors
4. Report the results

If there are errors, DO NOT reload. Report the errors and suggest fixes.
