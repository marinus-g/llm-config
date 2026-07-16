/** TUI plugin for plan-gate — shows the plan-approval dialog.
 *
 *  Registers a "plan-gate-open" command (internal, not user-facing) that is
 *  dispatched by the server plugin (plugin/plan-gate.js) when the plan agent
 *  calls present_plan. Opens a DialogSelect with four choices:
 *
 *    Auto mode   — danger mode + hand off to orchestrator
 *    Implement   — normal hand off to orchestrator
 *    Refine      — model picker (all providers, no free-only filter) then refine
 *    Change requests — stay on plan, user types changes
 *
 *  The model picker for Refine follows the same pattern as model-override-tui.tsx
 *  but defaults freeOnly=false (show all models including cloud/API ones) and
 *  owns the override only for the duration of the session.
 *
 *  API notes (see tui/workflow-tui.js):
 *  - api.keymap.registerLayer({ commands:[...] }) for command registration
 *  - api.ui.DialogSelect, api.ui.dialog.replace/clear, api.ui.toast
 *  - api.client.session.command({ sessionID, command, arguments }) for dispatch
 *  - api.route.current for active session ID
 *  - api.state.provider for available models (matches model-override-tui.tsx)
 */

import {
  availableModelOptions,
  createModelOverrideOwner,
  writeModelOverride,
  clearModelOverride,
} from "../lib/model-override.js";
import { readPendingPlan } from "../lib/plan-handoff.js";

function errorText(error) {
  if (typeof error === "string") return error;
  if (typeof error?.message === "string") return error.message;
  if (typeof error?.data?.message === "string") return error.data.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export default {
  id: "plan-gate-picker",

  tui: async (api) => {
    const owner = createModelOverrideOwner();
    const ownedSessions = new Set();

    /** Active session ID from the current TUI route. */
    const sessionID = () =>
      api.route.current?.name === "session"
        ? api.route.current.params?.sessionID
        : undefined;

    /** Dispatch a plan-gate choice to the server plugin via session.command.
     *
     *  The agent switch is driven by the dispatched COMMAND's frontmatter agent,
     *  NOT by any agent param here (the param only tags the user message; the
     *  frontmatter agent is what actually switches the responding agent — the
     *  same mechanism commands/workflow.md uses to enter workflow-orchestrator):
     *    auto / implement → command "plan-gate-implement" (agent: orchestrator)
     *    refine / change  → command "plan-gate"          (agent: plan)
     */
    async function dispatchChoice(sid, choice) {
      api.ui.dialog.clear();
      const command = (choice === "auto" || choice === "implement")
        ? "plan-gate-implement"
        : "plan-gate";
      try {
        const result = await api.client.session.command({
          sessionID: sid,
          command,
          arguments: choice,
        });
        if (result?.error) throw result.error;
      } catch (error) {
        api.ui.toast({ variant: "error", message: errorText(error) || "Plan gate dispatch failed." });
      }
    }

    /** Open the model picker for the Refine choice.
     *  Shows ALL configured models (freeOnly=false) so the user can pick a
     *  cloud/API model or a higher-effort local variant. */
    function openModelPicker(sid) {
      const models = availableModelOptions(api.state.provider, { freeOnly: false });
      if (models.length === 0) {
        api.ui.toast({ variant: "warning", message: "No models available." });
        return;
      }
      const modelByValue = new Map(
        models.map((m) => [`model:${m.value.providerID}/${m.value.modelID}`, m.value]),
      );
      const options = [
        {
          title: "← Back to plan choices",
          value: "back",
          description: "Return to the plan-approval dialog.",
        },
        ...models.map((m) => ({
          ...m,
          value: `model:${m.value.providerID}/${m.value.modelID}`,
        })),
      ];

      api.ui.dialog.replace(() =>
        api.ui.DialogSelect({
          title: "Refine: choose a stronger model",
          placeholder: "Search models (local and cloud)…",
          options,
          onSelect: (opt) => {
            if (opt.value === "back") {
              openGate(sid);
              return;
            }
            const model = modelByValue.get(opt.value);
            if (!model) {
              api.ui.toast({ variant: "error", message: "Selected model is no longer available." });
              return;
            }
            try {
              // Write a session-scoped model override; the plan agent's next
              // turn will use this model. The TUI lifecycle cleans it up on dispose.
              writeModelOverride(sid, { mode: "override", model }, owner);
              ownedSessions.add(sid);
            } catch (error) {
              api.ui.toast({ variant: "error", message: errorText(error) });
              return;
            }
            // Tell the server to re-prompt the plan agent.
            void dispatchChoice(sid, "refine");
          },
        }),
      );
    }

    /** Open the four-choice plan-approval dialog. */
    function openGate(sid) {
      const record = readPendingPlan(sid);
      const planSnippet = record?.planText
        ? record.planText.slice(0, 260) + (record.planText.length > 260 ? "…" : "")
        : "(plan text unavailable)";

      const options = [
        {
          title: "⚡ Auto mode",
          value: "auto",
          description:
            "Implement now — danger mode enabled (all tools auto-approved, " +
            "destructive rm outside the repo still asks).",
        },
        {
          title: "▶ Implement",
          value: "implement",
          description: "Hand off to orchestrator with normal permission prompts.",
        },
        {
          title: "🔍 Refine with stronger model",
          value: "refine",
          description:
            "Open model picker (local + cloud) and re-run the plan agent with deeper analysis.",
        },
        {
          title: "✏ Change requests",
          value: "change",
          description: "Clear the plan and stay in plan mode — type your revisions.",
        },
      ];

      api.ui.dialog.replace(() =>
        api.ui.DialogSelect({
          title: "Plan ready — what next?",
          placeholder: planSnippet,
          options,
          onSelect: (opt) => {
            if (opt.value === "refine") {
              openModelPicker(sid);
              return;
            }
            void dispatchChoice(sid, opt.value);
          },
        }),
      );
    }

    // Register the internal "plan-gate-open" command.
    // This is dispatched by the server plugin via client.tui.publish(
    //   { body: { type: "tui.command.execute", properties: { command: "plan-gate-open" } } }
    // ).
    api.keymap.registerLayer({
      commands: [
        {
          name: "plan-gate-open",
          title: "Plan: show plan-approval dialog",
          run() {
            const sid = sessionID();
            if (!sid) {
              api.ui.toast({ variant: "warning", message: "Open a session first." });
              return;
            }
            openGate(sid);
          },
        },
        {
          name: "plan-gate",
          title: "Plan: plan-approval gate",
          category: "Plan",
          namespace: "palette",
          slashName: "plan-gate",
          run() {
            const sid = sessionID();
            if (!sid) {
              api.ui.toast({ variant: "warning", message: "Open a session first." });
              return;
            }
            openGate(sid);
          },
        },
      ],
    });

    // Clean up any model overrides we wrote when the TUI disposes.
    api.lifecycle.onDispose(() => {
      for (const sid of ownedSessions) {
        clearModelOverride(sid, owner.token);
      }
    });
  },
};
