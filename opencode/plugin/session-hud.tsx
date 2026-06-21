/** TUI HUD — session metrics + active mode indicators in the session prompt bar.
 *
 *  Registers into the `session_prompt_right` host slot. Normal display:
 *    ⏱ 1m04s · ↑ 5.2k/45.2k | ↓ 1.1k/8.1k · $0.31
 *  With danger mode active:
 *    ⚠ DANGER · ⏱ 1m04s · ↑ 5.2k/45.2k | ↓ 1.1k/8.1k · $0.31  (error colour)
 *
 *  Visibility rules:
 *  - While busy: show ⏱ (live) + ↑↓ (turn/total) + $ (cumulative).
 *  - For 15s after turn ends: show ⏱ (frozen at final duration) + ↑↓$.
 *  - After 15s idle (or on cold-load of an old session): render nothing.
 *
 *  Token source: step-finish PARTS from the v2 client API (session.messages).
 *  The reactive api.state.part() store maps message IDs to role strings internally
 *  and does NOT return Part arrays with token data. The client API includes inline
 *  parts (including step-finish) in every session.messages response.
 *  The main session is also fetched via the client (same as subagents) so all tokens
 *  come from a single unified poll — no separate reactive loop needed.
 *
 *  Elapsed anchor: latest USER message referenced by an assistant parentID. This
 *  ignores newer queued messages. Frozen value = maxDone - currentUser.time.created.
 *
 *  Poll: main session + all child sessions every 3s via api.client.session.messages
 *  and api.client.session.children using the TUI v2 client's { sessionID } convention.
 */
import { createMemo, createSignal, onCleanup } from "solid-js"
import { isDanger } from "../lib/danger-mode.js"
import {
  findCurrentTurnUser,
  loadTokenTotals,
  shouldShowElapsed,
} from "../lib/session-hud-message.js"

const HIDE_AFTER_MS = 15_000

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  return `${m}m${String(rs).padStart(2, "0")}s`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

interface Totals { up: number; down: number; cost: number }
interface TokenTotals { total: Totals; turn: Totals }

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default {
  id: "session-hud",

  tui: async (api: any) => {
    api.slots.register({
      slots: {
        session_prompt_right: (_ctx: any, props: { session_id: string }) => {
          const sid = props.session_id

          // 1s tick: drives live elapsed counter + ~1s-accurate idle hide.
          const [now, setNow] = createSignal(Date.now())
          const tickId = setInterval(() => setNow(Date.now()), 1_000)

          // Turn and cumulative totals (main session + subagents), polled every 3s.
          const zeroTotals = (): Totals => ({ up: 0, down: 0, cost: 0 })
          const [tokenTotals, setTokenTotals] = createSignal<TokenTotals>({
            total: zeroTotals(),
            turn: zeroTotals(),
          })
          let polling = false
          let lastPollError = ""
          const poll = async () => {
            if (polling || api.lifecycle.signal.aborted) return
            polling = true
            try {
              setTokenTotals(await loadTokenTotals(api.client, sid, "v2"))
              lastPollError = ""
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (message !== lastPollError) {
                console.error("[session-hud] token poll failed:", message)
                lastPollError = message
              }
            } finally {
              polling = false
            }
          }
          poll() // immediate first fetch
          const pollId = setInterval(poll, 3_000)

          onCleanup(() => {
            clearInterval(tickId)
            clearInterval(pollId)
          })

          const label = createMemo(() => {
            const t = now()                                         // tick dependency
            const msgs = api.state.session.messages(sid)           // reactive store read
            const status = api.state.session.status(sid)           // reactive store read
            const busy = status?.type === "busy" || status?.type === "retry"
            const danger = isDanger(sid)                           // cheap existsSync, ticked every 1s

            // Latest completed assistant timestamp.
            // Drives idle-hide and the frozen elapsed timer.
            let maxDone = 0
            for (const m of msgs) {
              if (m.role === "assistant" && m.time?.completed)
                maxDone = Math.max(maxDone, m.time.completed)
            }

            // Hide everything 15s after the turn ends.
            // On cold-load of an old session maxDone is far in the past → hidden immediately.
            // Danger mode forces the element visible regardless of idle state.
            const visible = danger || busy || (maxDone > 0 && Date.now() - maxDone < HIDE_AFTER_MS)
            if (!visible) return { text: "", danger: false }

            // All tokens come from the unified poll (main session + subagents).
            const { total, turn } = tokenTotals()

            const parts: string[] = []

            if (danger) {
              parts.push("⚠ DANGER")
            }

            // ⏱ live while busy; frozen at the turn's final duration during idle grace.
            const currentUser = findCurrentTurnUser(msgs)
            if (currentUser) {
              const endRef = busy ? Date.now() : maxDone
              const elapsedMs = endRef - currentUser.time.created
              if (shouldShowElapsed(elapsedMs)) {
                parts.push(`⏱ ${fmtElapsed(elapsedMs)}`)
              }
            }

            if (total.up > 0 || total.down > 0) {
              parts.push(
                `↑ ${fmtTokens(turn.up)}/${fmtTokens(total.up)} | `
                + `↓ ${fmtTokens(turn.down)}/${fmtTokens(total.down)}`,
              )
            }
            if (total.cost > 0.0001) {
              parts.push(`$${total.cost.toFixed(2)}`)
            }

            return { text: parts.join(" · "), danger }
          })

          // <text> wrapper is mandatory — slot parent is a box; bare strings orphan-error.
          // An empty label renders the element invisibly.
          // When danger mode is active, render in error/red colour so it stands out.
          return (
            <text style={{ fg: label().danger ? (api.theme.current.error ?? "#ff0000") : api.theme.current.textMuted }}>
              {label().text}
            </text>
          )
        },
      },
    })
  },
}
