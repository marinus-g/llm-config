---
description: Check system health: updates, disk, services
agent: orchestrator
---

Check the overall system health.

Run these commands and summarize:

1. `checkupdates 2>/dev/null | wc -l` — count pending pacman updates
2. `yay -Qu 2>/dev/null | wc -l` — count pending AUR updates
3. `df -h / /home` — disk usage
4. `systemctl --failed --no-legend` — failed services
5. `uptime` — system uptime and load

Report a health summary with:
- Update counts (pacman + AUR)
- Disk usage for relevant mounts
- Any failed services (or "all services OK")
- System load assessment
