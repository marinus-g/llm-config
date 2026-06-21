/**
 * Prefer GPU for delegated OpenCode agents using llama-swap.
 *
 * The orchestrator runs on the primary Qwopus GPU model. When it goes idle and a
 * delegated agent starts on a different local model, tell the local router that the
 * next matching request should take GPU immediately instead of waiting for the
 * router's normal post-GPU grace window to expire.
 */

const ROUTER_URL = "http://127.0.0.1:5099/router/prefer-gpu";
const RUNNING_URL = "http://127.0.0.1:5099/running";
const PROVIDER_ID = "llamaswap";
const PRIMARY_AGENT = "orchestrator";

function modelID(model) {
  return model?.id ?? model?.modelID ?? "";
}

async function preferGPU(model, agent, sessionID) {
  try {
    const response = await fetch(ROUTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, agent, sessionID }),
    });
    if (!response.ok) {
      console.error(`[llama-swap-gpu] prefer-gpu HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`[llama-swap-gpu] prefer-gpu failed: ${error.message}`);
  }
}

async function runningModels() {
  const response = await fetch(RUNNING_URL, {
    headers: { Authorization: "Bearer llama-local" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return Array.isArray(data.running) ? data.running : [];
}

function formatModel(model) {
  const state = model.state ?? "unknown";
  const id = model.model ?? model.name ?? "(unknown)";
  const label = model.name && model.name !== id ? ` - ${model.name}` : "";
  return `${id} [${state}]${label}`;
}

function formatStatus(models) {
  if (models.length === 0) return "llama-swap: no models loaded";

  const gpu = models.filter((model) => !String(model.model ?? "").endsWith("-cpu"));
  const cpu = models.filter((model) => String(model.model ?? "").endsWith("-cpu"));

  const lines = ["llama-swap active models"];
  lines.push("");
  lines.push("GPU:");
  lines.push(...(gpu.length ? gpu.map((model) => `- ${formatModel(model)}`) : ["- none"]));
  lines.push("");
  lines.push("CPU:");
  lines.push(...(cpu.length ? cpu.map((model) => `- ${formatModel(model)}`) : ["- none"]));
  return lines.join("\n");
}

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async () => {
  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "llm") return;

      try {
        output.parts = [{ type: "text", text: formatStatus(await runningModels()) }];
      } catch (error) {
        output.parts = [
          {
            type: "text",
            text: `llama-swap: not responding on 127.0.0.1:5099 (${error.message})`,
          },
        ];
      }
    },

    "chat.headers": async (input, output) => {
      const providerID = input.model?.providerID ?? "";
      const model = modelID(input.model);
      if (providerID !== PROVIDER_ID || !model) return;
      if (model.endsWith("-cpu")) return;

      // FastContext-4B is routed by the router (it evicts the primary GPU model
      // to take the full card; CPU fallback on GPU load failure). Skip prefer-GPU
      // so the router owns routing entirely — forcing it here would interfere.
      if (model.startsWith("fastcontext")) return;

      // All other agents (including orchestrator) get GPU preference.
      // The orchestrator especially needs it after a subagent finishes,
      // because the router's grace period may otherwise route it to CPU.
      output.headers["X-Llama-Swap-Prefer-GPU"] = "true";
      output.headers["X-OpenCode-Agent"] = input.agent;
      await preferGPU(model, input.agent, input.sessionID);
    },
  };
};
