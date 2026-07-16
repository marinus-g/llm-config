/** TUI plugin for /workflow — interactive picker for list & attach.
 *
 *  Registers a "workflow-list" command (slash: /workflow-list) that opens
 *  a DialogSelect over all persisted workflows. Selecting one closes the
 *  picker and dispatches /workflow attach <id> through the active agent.
 *
 *  /workflow list in the markdown command publishes tui.command.execute
 *  {command:"workflow-list"} to bridge here via keymap.dispatchCommand.
 *  If that throws, the server-side list branch falls back to plain text.
 *
 *  IMPORTANT: This module uses `export default { id, tui }` (not a named
 *  export). TUI plugins must be registered in tui.json (NOT opencode.json),
 *  and readV1Plugin() expects mod.default with {id, tui}. The id field is
 *  required for file-path plugins — resolvePluginId throws without it.
 *
 *  API notes (verified against v1.16.2 source plugin/runtime.ts):
 *  - use api.keymap.registerLayer({ commands:[{name,title,category,namespace,
 *    slashName,run()}] }) — command-shim.ts:toCommand is the exact mapping
 *  - dialog props: DialogSelect onSelect?(option); DialogConfirm {title,message,
 *    onConfirm?,onCancel?}; option supports disabled
 *  - api.command (shim) IS present when loaded by the TUI runtime; the past
 *    crashes were caused by this file landing in the server loader, not a
 *    missing api
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { listWorkflows, SCHEMA_VERSION, getStateDir } from "../lib/workflow-core.js";

function errorText(error) {
  if (typeof error === "string") return error;
  if (typeof error?.message === "string") return error.message;
  if (typeof error?.data?.message === "string") return error.data.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

/** Dispatch attach through the agent command path; return transport failures to that agent. */
export async function dispatchAttach(api, sessionID, workflowID) {
  api.ui.dialog.clear();
  let failure;
  try {
    const result = await api.client.session.command({
      sessionID,
      command: "workflow",
      arguments: `attach ${workflowID}`,
    });
    if (!result?.error) return;
    failure = result.error;
  } catch (error) {
    failure = error;
  }

  const exactError = errorText(failure) || "Unknown client error";
  try {
    const result = await api.client.session.promptAsync({
      sessionID,
      parts: [{ type: "text", text:
        `The /workflow attach ${workflowID} request failed at the client transport layer.\n\n` +
        `Exact error:\n\n\`\`\`text\n${exactError}\n\`\`\`\n\n` +
        "Evaluate this exact error, explain the likely cause, and give the next safe action. Do not claim the workflow is attached."
      }],
    });
    if (result?.error) throw result.error;
  } catch {
    api.ui.toast({ variant: "error", message: exactError });
  }
}

export default {
  id: "workflow-list-picker",

  tui: async (api) => {
    /** Return the active session ID from the current TUI route, or undefined. */
    const sessionID = () =>
      api.route.current?.name === "session"
        ? api.route.current.params?.sessionID
        : undefined;

    /** Open a help dialog populated from the handoff file written by workflow_control. */
    const openHelp = () => {
      let text;
      try { text = readFileSync(join(getStateDir(), "help-buffer.txt"), "utf8"); } catch { return; }
      api.ui.dialog.replace(() =>
        api.ui.DialogConfirm({
          title: "Workflow help",
          message: text,
          onConfirm: () => api.ui.dialog.clear(),
          onCancel: () => api.ui.dialog.clear(),
        })
      );
      try { rmSync(join(getStateDir(), "help-buffer.txt"), { force: true }); } catch {}
    };

    /** Open the workflow select dialog. Called by the registered command and
     *  (indirectly) by /workflow list via the tui.command.execute bridge. */
    const openPicker = () => {
      const states = listWorkflows();
      if (!states.length) {
        api.ui.toast({ variant: "info", message: "No persisted workflows." });
        return;
      }
      const options = states.map((s) => ({
        title: `${s.id} [${s.status}]`,
        value: s.id,
        description: s.sourcePath,
        disabled: s.schemaVersion !== SCHEMA_VERSION || Boolean(s.migrationError),
      }));
      api.ui.dialog.replace(() =>
        api.ui.DialogSelect({
          title: "Attach to workflow",
          options,
          onSelect: (opt) => onPick(opt.value),
        })
      );
    };

    /** Close the picker and hand attachment, including error evaluation, to the agent. */
    const onPick = async (id) => {
      const activeSessionID = sessionID();
      if (!activeSessionID) {
        api.ui.dialog.clear();
        api.ui.toast({ variant: "warning", message: "Open a session first." });
        return;
      }
      await dispatchAttach(api, activeSessionID, id);
    };

    // 1.16.2 native registration via keymap.registerLayer.
    // command-shim.ts:toCommand shows the exact legacy→native field mapping:
    //   value→name, slash.name→slashName, onSelect→run, description→desc
    // The name "workflow-list" is the dispatch key keymap.dispatchCommand resolves.
    // "workflow-list" is NOT registered as a slashName or in the palette — it is
    // an internal dispatch target used by /workflow list via tui.command.execute.
    api.keymap.registerLayer({
      commands: [
        {
          name: "workflow-list",
          title: "Workflow: list & attach",
          run() {
            openPicker();
          },
        },
        {
          name: "workflow-help",
          title: "Workflow: help",
          run() {
            openHelp();
          },
        },
      ],
    });
  },
};
