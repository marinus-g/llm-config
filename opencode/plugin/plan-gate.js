/**
 * /plan-gate plugin — plan-approval gate for the plan agent.
 *
 * HOW IT WORKS
 * ============
 * When the plan agent's final plan is ready, it calls the present_plan tool.
 * That tool persists the plan text (lib/plan-handoff.js) and opens the TUI
 * plan-approval dialog (tui/plan-gate-tui.js) via the tui.command.execute
 * bridge — exactly the same mechanism as /workflow list.
 *
 * The user picks one of four choices in the dialog:
 *   auto      → enable danger mode + hand off to orchestrator (auto-start)
 *   implement → hand off to orchestrator (normal permissions, auto-start)
 *   refine    → TUI picks a model override, then re-prompts plan agent to refine
 *   change    → clear pending plan, stay on plan, user types change requests
 *
 * The TUI dispatches the choice via /plan-gate <choice>, which this plugin
 * handles in command.execute.before.
 *
 * HEADLESS FALLBACK
 * If there is no TUI (opencode run), present_plan injects a noReply message
 * explaining the choices so the user can type /plan-gate <choice> manually.
 */

import { tool } from "@opencode-ai/plugin";
import { setDanger } from "../lib/danger-mode.js";
import {
  clearPendingPlan,
  readPendingPlan,
  writePendingPlan,
} from "../lib/plan-handoff.js";
import { createModelOverrideOwner } from "../lib/model-override.js";
import { randomUUID } from "node:crypto";

const PLAN_GATE_TUI_COMMAND = "plan-gate-open";

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => {
  const owner = createModelOverrideOwner();

  // -------------------------------------------------------------------------
  // Inject a message into a session, optionally switching the active agent.
  // -------------------------------------------------------------------------
  function inject(sessionID, text, agent, noReply = false) {
    return client.session.promptAsync({
      path: { id: sessionID },
      body: {
        ...(agent ? { agent } : {}),
        parts: [{ type: "text", text }],
        ...(noReply ? { noReply: true } : {}),
      },
    }).catch((error) => console.error("[plan-gate] inject failed:", error.message));
  }

  // -------------------------------------------------------------------------
  // Fetch the last assistant text from the session transcript.
  // Used by present_plan so the model does NOT need to re-emit the plan as
  // a tool argument — it streams the plan as normal text, then calls the tool
  // (which is a tiny, instant call), and we read the plan text back here.
  // -------------------------------------------------------------------------
  async function fetchLastPlanText(sessionID) {
    try {
      const resp = await client.session.messages({
        path: { id: sessionID },
        query: { limit: 8 },
      });
      const entries = resp.data ?? [];
      const assistantEntries = entries.filter((e) => e.info?.role === "assistant");
      const last = assistantEntries[assistantEntries.length - 1];
      if (!last) return null;
      const text = (last.parts ?? [])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text.trim())
        .join("\n")
        .trim();
      return text || null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // present_plan tool — called by the plan agent when the plan is final.
  // -------------------------------------------------------------------------
  const presentPlan = tool({
    description:
      "Signal that your final plan is ready for the user to act on. " +
      "Print the complete plan as normal chat text first, **then** call this tool " +
      "with no arguments. The system reads the plan from your last message — " +
      "do NOT repeat the plan text inside the tool call. " +
      "Call this once when you are done planning and ready for the user to choose " +
      "whether to implement, refine, or revise.",
    args: {},
    async execute(_args, context) {
      context.metadata({ title: "Plan approval gate" });

      // Read the plan from the last assistant message — the model already
      // streamed it as visible text so no re-emission is needed.
      const planText =
        (await fetchLastPlanText(context.sessionID)) ??
        "(see plan above in the conversation)";

      // Persist the plan so both TUI and server can read it.
      try {
        writePendingPlan(context.sessionID, planText, owner);
      } catch (error) {
        throw new Error(`Failed to persist plan: ${error.message}`);
      }

      // Try to open the TUI dialog (works when the TUI is running).
      // app.tsx: event.on("tui.command.execute") → keymap.dispatchCommand(command)
      // which resolves the "plan-gate-open" command registered in tui/plan-gate-tui.js.
      let tuiOpened = false;
      try {
        await client.tui.publish({
          body: {
            type: "tui.command.execute",
            properties: { command: PLAN_GATE_TUI_COMMAND, sessionID: context.sessionID },
          },
        });
        tuiOpened = true;
      } catch {
        // TUI not available — headless path below.
      }

      if (!tuiOpened) {
        // Headless fallback: inject a visible message with the choices.
        const snippet = planText.startsWith("(see plan")
          ? planText
          : planText.slice(0, 400) + (planText.length > 400 ? "\n…(truncated)" : "");
        inject(
          context.sessionID,
          "◎ Plan approval required. No TUI detected — reply with `/plan-gate <choice>`:\n\n" +
            "• `/plan-gate auto` — implement in auto mode (all tools allowed, no prompts)\n" +
            "• `/plan-gate implement` — implement with normal permissions\n" +
            "• `/plan-gate refine` — keep planning with a stronger model (set model override first)\n" +
            "• `/plan-gate change` — describe change requests (stay in plan mode)\n\n" +
            "Plan text (first 400 chars):\n```\n" +
            snippet +
            "\n```",
          undefined,
          true, // noReply — present choices without triggering another agent turn
        );
      }

      return (
        "✓ Plan delivered to user approval dialog. " +
        "Stop generating — do not add further text. " +
        "Await the user's choice; the system will inject a new turn when the choice is made."
      );
    },
  });

  // -------------------------------------------------------------------------
  // Choice dispatcher — handles /plan-gate <choice> from TUI or user.
  // -------------------------------------------------------------------------
  return {
    tool: { present_plan: presentPlan },

    "command.execute.before": async (input, output) => {
      if (input.command !== "plan-gate") return;

      const sessionID = input.sessionID;
      const choice = (input.arguments ?? "").trim().toLowerCase();

      // Auto and implement both hand off to the orchestrator.
      if (choice === "auto" || choice === "implement") {
        const record = readPendingPlan(sessionID);
        const planText = record?.planText ?? "(plan text unavailable — see conversation history)";

        if (choice === "auto") {
          setDanger(sessionID, true);
          try {
            client.tui.showToast({
              body: { message: "⚠ Auto mode — all tools allowed", variant: "warning" },
            }).catch(() => {});
          } catch { /* no TUI */ }
        }

        clearPendingPlan(sessionID); // unconditional — plugin is authoritative on choice

        const prefix = choice === "auto"
          ? "AUTO MODE: Danger mode is enabled — all edit and bash tools are allowed without prompting (destructive filesystem commands outside the repository still ask).\n\n"
          : "";

        inject(
          sessionID,
          `${prefix}◈ Plan approved — implement it now.\n\n` +
            `The following plan was produced by the plan agent. Implement it completely.\n\n` +
            `---\n\n${planText}`,
          "orchestrator",
        );

        output.parts = [{
          type: "text",
          text: choice === "auto"
            ? "◈ Auto mode enabled. Handing off to orchestrator…"
            : "◈ Handing off to orchestrator…",
        }];
        return;
      }

      // Refine: model override was written by the TUI; just re-prompt the plan agent.
      if (choice === "refine") {
        const record = readPendingPlan(sessionID);
        const planText = record?.planText ?? "(current plan — see conversation history)";
        clearPendingPlan(sessionID); // unconditional — plugin is authoritative on choice

        inject(
          sessionID,
          "◎ Refine requested. A stronger model has been applied. " +
            "Re-examine the plan below with deeper analysis and more thorough consideration " +
            "of edge cases, risks, and implementation details. Then call `present_plan` again " +
            "with the improved plan.\n\n" +
            `Current plan:\n\n${planText}`,
          "plan",
        );

        output.parts = [{ type: "text", text: "◎ Switching to stronger model — plan agent will refine…" }];
        return;
      }

      // Change requests: clear the plan and stay on the plan agent.
      if (choice === "change") {
        clearPendingPlan(sessionID); // unconditional — plugin is authoritative on choice
        try {
          client.tui.showToast({
            body: {
              message: "Plan cleared — type your change requests",
              variant: "info",
            },
          }).catch(() => {});
        } catch { /* no TUI */ }

        output.parts = [{
          type: "text",
          text: "◎ Plan cleared. Describe your change requests and the plan agent will revise.",
        }];
        return;
      }

      // Unknown choice.
      output.parts = [{
        type: "text",
        text: `Unknown plan-gate choice: "${choice}". Valid choices: auto, implement, refine, change.`,
      }];
    },
  };
};

export default server;
