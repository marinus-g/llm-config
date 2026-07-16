/**
 * lib/plan-question-autoanswer.js
 *
 * Pure, IO-free helpers for the 20-minute plan-question auto-answer feature.
 * The workflow plugin (plugin/workflow.js) imports these; they are kept here
 * so they can be unit-tested without any server/client dependencies.
 */

/** How long to wait before auto-answering an unanswered plan question. */
export const PLAN_QUESTION_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The dedicated reasoning model used for the auto-answer classifier turn.
 * Intentionally hard-coded so it does not inherit the session's active model
 * (which may be a fast non-reasoning model during stage planning).
 *
 * @type {{ providerID: string, modelID: string }}
 */
export const PLAN_QUESTION_REASONING_MODEL = {
  providerID: "llamaswap",
  modelID: "qwen3-moe-large",
};

/**
 * Builds the system prompt and user text for the isolated reasoning-model
 * classifier turn that auto-answers a single question.
 *
 * The model is asked to return:
 *   - For questions with options: exactly the label of the best option (one
 *     word or short phrase matching a label verbatim).
 *   - For free-text / option-less questions: a concise, implementation-ready
 *     answer of 1-3 sentences.
 *   - For multiple-select questions: each selected label on its own line.
 *
 * @param {{ question: string, header: string, options: Array<{label:string,description:string}>, multiple?: boolean, custom?: boolean }} questionInfo
 * @param {string} planContext  Recent plan-agent assistant text (concatenated).
 * @returns {{ system: string, text: string }}
 */
export function buildAnswerProbe(questionInfo, planContext) {
  const { question, options = [], multiple = false, custom = false } = questionInfo;
  const hasOptions = options.length > 0;

  const system =
    "You are a senior software architect making a precise implementation decision. " +
    "You will be shown a planning context and a single clarifying question that was asked " +
    "during workflow stage planning. The developer who initiated the workflow is unavailable " +
    "for 20 minutes. Your job is to provide the best reasonable answer so that planning can " +
    "continue unblocked. " +
    (hasOptions && !multiple
      ? "Reply with ONLY the exact label of the best option — one line, no explanation, " +
        "no punctuation beyond what is in the label itself. "
      : hasOptions && multiple
        ? "Reply with ONLY the exact labels of the selected options, one per line. " +
          "Include every option that should be selected. No explanations. "
        : "Reply with a concise answer of 1-3 sentences. Be concrete and actionable. ") +
    "Do not hedge, do not ask follow-up questions, do not restate the question. " +
    "Base your decision on the planning context provided.";

  const optionsBlock = hasOptions
    ? "\n\nAvailable options:\n" +
      options.map((o) => `- ${o.label}: ${o.description}`).join("\n")
    : "";

  const freeTextNote =
    !hasOptions || custom
      ? "\n\n(This is an open-ended question — write a direct, concise answer.)"
      : "";

  const text =
    `## Planning context\n\n${planContext || "(no context available)"}\n\n` +
    `## Question\n\n${question}${optionsBlock}${freeTextNote}`;

  return { system, text };
}

/**
 * Maps a raw model reply to a valid QuestionAnswer (string[]) for the given
 * question.
 *
 * Strategy (in order):
 *   1. For option-bearing questions: find option labels that appear in the
 *      reply (case-insensitive, trimmed).  For single-select, pick the first
 *      match; for multiple-select, collect all matches.
 *   2. If no option matched, fall back to the first option's label.
 *   3. For option-less / custom-only questions, return the trimmed reply text
 *     (or a fallback sentinel if blank).
 *
 * Always returns a non-empty array.
 *
 * @param {string} replyText  Raw text from the classifier session.
 * @param {{ question: string, options: Array<{label:string}>, multiple?: boolean, custom?: boolean }} questionInfo
 * @returns {string[]}
 */
export function parseAnswerReply(replyText, questionInfo) {
  const { options = [], multiple = false, custom = false } = questionInfo;
  const trimmed = (replyText ?? "").trim();
  const hasOptions = options.length > 0;

  if (!hasOptions || custom) {
    // Free-text question — return whatever the model wrote, or a safe sentinel.
    return [trimmed || "proceed with best judgment"];
  }

  // Normalize labels for fuzzy matching.
  const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedLabels = options.map((o) => normalize(o.label));
  const replyNorm = normalize(trimmed);

  // Collect matched option labels in reply order (by position of label in the reply).
  const matched = [];
  for (let i = 0; i < options.length; i++) {
    const label = options[i].label;
    const labelNorm = normalizedLabels[i];
    // Accept if the normalized reply contains the normalized label as a word/phrase.
    if (replyNorm.includes(labelNorm)) {
      matched.push(label);
    }
  }

  if (multiple) {
    return matched.length > 0 ? matched : [options[0].label];
  }

  // Single-select: first match wins.
  return matched.length > 0 ? [matched[0]] : [options[0].label];
}
