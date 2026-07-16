import { createSignal, onCleanup } from "solid-js";
import {
  AGENT_MODEL_OVERRIDE_COMMAND,
  availableAgentOptions,
  availableModelOptions,
  clearAgentModelOverrides,
  clearModelOverride,
  createModelOverrideOwner,
  formatModelOverride,
  MODEL_OVERRIDE_COMMAND,
  readAgentModelOverrides,
  readModelOverride,
  resolveModelOverride,
  updateAgentModelOverride,
  writeAgentModelOverrides,
  writeModelOverride,
} from "../lib/model-override.js";

export default {
  id: "model-override-picker",

  tui: async (api: any) => {
    const owner = createModelOverrideOwner();
    const ownedSessions = new Set<string>();
    let agentOverrides = readAgentModelOverrides()?.overrides ?? {};
    let ownsAgentOverrides = false;
    let freeOnly = true;
    const sessionID = () => api.route.current?.name === "session"
      ? api.route.current.params?.sessionID
      : undefined;
    const getParentID = async (id: string) => {
      const response = await api.client.session.get({ sessionID: id });
      return response?.data?.parentID ?? null;
    };

    const selectValue = async (id: string, value: string, modelByValue: Map<string, any>) => {
      try {
        if (value === "inherit") {
          clearModelOverride(id);
          ownedSessions.delete(id);
        } else if (value === "default") {
          const parentID = await getParentID(id);
          if (parentID) {
            writeModelOverride(id, { mode: "default" }, owner);
            ownedSessions.add(id);
          } else {
            clearModelOverride(id);
            ownedSessions.delete(id);
          }
        } else {
          const model = modelByValue.get(value);
          if (!model) throw new Error("The selected model is no longer available.");
          writeModelOverride(id, { mode: "override", model }, owner);
          ownedSessions.add(id);
        }
        api.ui.dialog.clear();
        api.ui.toast({ variant: "success", message: "Model selection updated." });
      } catch (error) {
        api.ui.toast({
          variant: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const openPicker = async () => {
      const id = sessionID();
      if (!id) {
        api.ui.toast({ variant: "warning", message: "Open a session first." });
        return;
      }
      let parentID;
      try {
        parentID = await getParentID(id);
      } catch (error) {
        api.ui.toast({
          variant: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const direct = readModelOverride(id);
      const models = availableModelOptions(api.state.provider, { freeOnly });
      const modelByValue = new Map(models.map((model: any) => [
        `model:${model.value.providerID}/${model.value.modelID}`,
        model.value,
      ]));
      const options: any[] = [];
      options.push({
        title: freeOnly ? "Filter: Free models only" : "Filter: All models",
        value: "filter:toggle",
        description: freeOnly
          ? "Show paid and unpriced models."
          : "Hide paid and unpriced models.",
      });
      if (parentID) {
        options.push({
          title: "Inherit parent selection",
          value: "inherit",
          description: "Remove this session's local model selection.",
        });
      }
      options.push({
        title: "Reset override: use agent default",
        value: "default",
        description: parentID
          ? "Do not inherit a parent override."
          : "Clear this session's model override.",
      });
      options.push(...models.map((model: any) => ({
        ...model,
        value: `model:${model.value.providerID}/${model.value.modelID}`,
      })));

      api.ui.dialog.replace(() => api.ui.DialogSelect({
        title: "Override agent model",
        placeholder: "Search models",
        options,
        current: direct?.mode === "override"
          ? `model:${direct.model.providerID}/${direct.model.modelID}`
          : direct?.mode === "default" ? "default" : "inherit",
        onSelect: (option: any) => {
          if (option.value === "filter:toggle") {
            freeOnly = !freeOnly;
            void openPicker();
            return;
          }
          void selectValue(id, option.value, modelByValue);
        },
      }));
    };

    const persistAgentOverrides = () => {
      if (Object.keys(agentOverrides).length === 0) {
        clearAgentModelOverrides();
        ownsAgentOverrides = false;
        return;
      }
      writeAgentModelOverrides(agentOverrides, owner);
      ownsAgentOverrides = true;
    };

    const setAgentModel = (agentID: string, model: any) => {
      try {
        agentOverrides = updateAgentModelOverride(agentOverrides, agentID, model);
        persistAgentOverrides();
        api.ui.dialog.clear();
        api.ui.toast({
          variant: "success",
          message: model
            ? `${agentID} now uses ${model.providerID}/${model.modelID}.`
            : `${agentID} now uses its configured model.`,
        });
      } catch (error) {
        api.ui.toast({
          variant: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const openAgentPicker = () => {
      const agents = availableAgentOptions(api.state.config.agent, agentOverrides);
      if (agents.length === 0) {
        api.ui.toast({ variant: "info", message: "No configured agents available." });
        return;
      }

      const options: any[] = [];
      if (Object.keys(agentOverrides).length > 0) {
        options.push({
          title: "Reset all agent overrides",
          value: "reset:all",
          description: "Restore every agent's configured model.",
        });
      }
      options.push(...agents);

      api.ui.dialog.replace(() => api.ui.DialogSelect({
        title: "Choose agent to override",
        placeholder: "Search agents",
        options,
        onSelect: (option: any) => {
          if (option.value === "reset:all") {
            api.ui.dialog.replace(() => api.ui.DialogConfirm({
              title: "Reset all agent overrides?",
              message: "Every agent will return to its configured model.",
              onConfirm: () => {
                agentOverrides = {};
                persistAgentOverrides();
                api.ui.toast({ variant: "success", message: "All agent model overrides reset." });
                openAgentPicker();
              },
              onCancel: () => openAgentPicker(),
            }));
            return;
          }
          openAgentModelPicker(option.value);
        },
      }));
    };

    const openAgentModelPicker = (agentID: string) => {
      const models = availableModelOptions(api.state.provider, { freeOnly });
      const modelByValue = new Map(models.map((model: any) => [
        `model:${model.value.providerID}/${model.value.modelID}`,
        model.value,
      ]));
      const current = agentOverrides[agentID];
      const options: any[] = [
        {
          title: "Back to agent list",
          value: "back",
          description: "Choose a different configured agent.",
        },
        {
          title: freeOnly ? "Filter: Free models only" : "Filter: All models",
          value: "filter:toggle",
          description: freeOnly
            ? "Show paid and unpriced models."
            : "Hide paid and unpriced models.",
        },
        {
          title: "Reset override: use configured model",
          value: "default",
          description: `Remove the temporary override for ${agentID}.`,
        },
        ...models.map((model: any) => ({
          ...model,
          value: `model:${model.value.providerID}/${model.value.modelID}`,
        })),
      ];

      api.ui.dialog.replace(() => api.ui.DialogSelect({
        title: `Override model for ${agentID}`,
        placeholder: "Search models",
        options,
        current: current
          ? `model:${current.providerID}/${current.modelID}`
          : "default",
        onSelect: (option: any) => {
          if (option.value === "back") {
            openAgentPicker();
            return;
          }
          if (option.value === "filter:toggle") {
            freeOnly = !freeOnly;
            openAgentModelPicker(agentID);
            return;
          }
          if (option.value === "default") {
            setAgentModel(agentID, null);
            return;
          }
          const model = modelByValue.get(option.value);
          if (!model) {
            api.ui.toast({ variant: "error", message: "The selected model is no longer available." });
            return;
          }
          setAgentModel(agentID, model);
        },
      }));
    };

    api.keymap.registerLayer({
      commands: [
        {
          ...MODEL_OVERRIDE_COMMAND,
          run: () => void openPicker(),
        },
        {
          ...AGENT_MODEL_OVERRIDE_COMMAND,
          run: () => openAgentPicker(),
        },
      ],
    });

    api.slots.register({
      slots: {
        session_prompt_right: (_ctx: any, props: { session_id: string }) => {
          const [label, setLabel] = createSignal("");
          let polling = false;
          const poll = async () => {
            if (polling || api.lifecycle.signal.aborted) return;
            polling = true;
            try {
              const record = await resolveModelOverride(props.session_id, getParentID);
              setLabel(formatModelOverride(record));
            } finally {
              polling = false;
            }
          };
          void poll();
          const timer = setInterval(() => void poll(), 2_000);
          onCleanup(() => clearInterval(timer));
          return <text style={{ fg: api.theme.current.warning }}>{label()}</text>;
        },
      },
    });

    api.lifecycle.onDispose(() => {
      for (const id of ownedSessions) clearModelOverride(id, owner.token);
      if (ownsAgentOverrides) clearAgentModelOverrides(owner.token);
    });
  },
};
