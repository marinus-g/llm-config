import { createModelOverrideHooks } from "../lib/model-override.js";

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async ({ client }) => createModelOverrideHooks(client);

export default server;
