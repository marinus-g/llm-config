import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_QUESTION_TIMEOUT_MS,
  PLAN_QUESTION_REASONING_MODEL,
  buildAnswerProbe,
  parseAnswerReply,
} from "../lib/plan-question-autoanswer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("PLAN_QUESTION_TIMEOUT_MS is 20 minutes", () => {
  assert.equal(PLAN_QUESTION_TIMEOUT_MS, 20 * 60 * 1000);
});

test("PLAN_QUESTION_REASONING_MODEL is qwen3-moe-large on llamaswap", () => {
  assert.equal(PLAN_QUESTION_REASONING_MODEL.providerID, "llamaswap");
  assert.equal(PLAN_QUESTION_REASONING_MODEL.modelID, "qwen3-moe-large");
});

// ---------------------------------------------------------------------------
// buildAnswerProbe
// ---------------------------------------------------------------------------

const SINGLE_SELECT_Q = {
  question: "Which logging library should we use?",
  header: "Logging lib",
  options: [
    { label: "pino", description: "Fast structured JSON logger" },
    { label: "winston", description: "Widely used, flexible transports" },
  ],
  multiple: false,
};

const MULTI_SELECT_Q = {
  question: "Which environments should we target?",
  header: "Targets",
  options: [
    { label: "development", description: "Local dev environment" },
    { label: "staging", description: "Pre-production environment" },
    { label: "production", description: "Live environment" },
  ],
  multiple: true,
};

const FREE_TEXT_Q = {
  question: "What should the error message prefix be?",
  header: "Error prefix",
  options: [],
  custom: true,
};

const OPTION_LESS_Q = {
  question: "What default timeout should we use in milliseconds?",
  header: "Timeout",
  options: [],
};

test("buildAnswerProbe returns system and text for single-select", () => {
  const { system, text } = buildAnswerProbe(SINGLE_SELECT_Q, "Plan context here");
  assert.ok(system.length > 0, "system prompt must not be empty");
  assert.ok(text.includes("Plan context here"), "text must include the plan context");
  assert.ok(text.includes(SINGLE_SELECT_Q.question), "text must include the question");
  assert.ok(text.includes("pino"), "text must include option labels");
  assert.ok(text.includes("winston"), "text must include option labels");
  // Single-select instruction must reference "one line" or "exact label"
  assert.ok(system.toLowerCase().includes("exact label"), "system must ask for exact label");
});

test("buildAnswerProbe covers multiple-select questions", () => {
  const { system } = buildAnswerProbe(MULTI_SELECT_Q, "");
  assert.ok(system.toLowerCase().includes("one per line"), "multiple-select must say one per line");
});

test("buildAnswerProbe handles free-text / option-less questions", () => {
  const { system, text } = buildAnswerProbe(FREE_TEXT_Q, "some context");
  assert.ok(system.toLowerCase().includes("concise"), "free-text system must ask for concise answer");
  assert.ok(text.includes("open-ended"), "text must mention open-ended for custom questions");
});

test("buildAnswerProbe includes fallback text for empty plan context", () => {
  const { text } = buildAnswerProbe(SINGLE_SELECT_Q, "");
  assert.ok(text.includes("no context available"));
});

// ---------------------------------------------------------------------------
// parseAnswerReply — single-select
// ---------------------------------------------------------------------------

test("parseAnswerReply exact match on label (single-select)", () => {
  const result = parseAnswerReply("pino", SINGLE_SELECT_Q);
  assert.deepEqual(result, ["pino"]);
});

test("parseAnswerReply case-insensitive match (single-select)", () => {
  const result = parseAnswerReply("PINO", SINGLE_SELECT_Q);
  assert.deepEqual(result, ["pino"]);
});

test("parseAnswerReply picks first match when reply contains multiple options (single-select)", () => {
  const result = parseAnswerReply("I would choose pino over winston", SINGLE_SELECT_Q);
  assert.deepEqual(result, ["pino"]);
});

test("parseAnswerReply falls back to first option when no label matches (single-select)", () => {
  const result = parseAnswerReply("bunyan is the best", SINGLE_SELECT_Q);
  assert.deepEqual(result, ["pino"]);
});

test("parseAnswerReply falls back to first option on blank reply (single-select)", () => {
  const result = parseAnswerReply("   ", SINGLE_SELECT_Q);
  assert.deepEqual(result, ["pino"]);
});

// ---------------------------------------------------------------------------
// parseAnswerReply — multiple-select
// ---------------------------------------------------------------------------

test("parseAnswerReply collects all matched labels (multiple-select)", () => {
  const result = parseAnswerReply("development\nproduction", MULTI_SELECT_Q);
  assert.deepEqual(result, ["development", "production"]);
});

test("parseAnswerReply collects labels embedded in prose (multiple-select)", () => {
  const result = parseAnswerReply(
    "We should target development and staging environments.",
    MULTI_SELECT_Q,
  );
  assert.ok(result.includes("development"), "development must be in result");
  assert.ok(result.includes("staging"), "staging must be in result");
  assert.ok(!result.includes("production"), "production must not be in result");
});

test("parseAnswerReply falls back to first option when no match (multiple-select)", () => {
  const result = parseAnswerReply("neither of the above", MULTI_SELECT_Q);
  assert.deepEqual(result, ["development"]);
});

// ---------------------------------------------------------------------------
// parseAnswerReply — free-text / option-less
// ---------------------------------------------------------------------------

test("parseAnswerReply returns trimmed reply for free-text question", () => {
  const result = parseAnswerReply("  [ERROR] prefix  ", FREE_TEXT_Q);
  assert.deepEqual(result, ["[ERROR] prefix"]);
});

test("parseAnswerReply uses sentinel for blank free-text reply", () => {
  const result = parseAnswerReply("", FREE_TEXT_Q);
  assert.deepEqual(result, ["proceed with best judgment"]);
});

test("parseAnswerReply returns trimmed reply for option-less question", () => {
  const result = parseAnswerReply("5000", OPTION_LESS_Q);
  assert.deepEqual(result, ["5000"]);
});

test("parseAnswerReply uses sentinel for blank option-less reply", () => {
  const result = parseAnswerReply("  ", OPTION_LESS_Q);
  assert.deepEqual(result, ["proceed with best judgment"]);
});

// ---------------------------------------------------------------------------
// parseAnswerReply always returns non-empty
// ---------------------------------------------------------------------------

test("parseAnswerReply never returns empty array", () => {
  for (const [reply, q] of [
    ["", SINGLE_SELECT_Q],
    ["", MULTI_SELECT_Q],
    ["", FREE_TEXT_Q],
    ["xyzzy", SINGLE_SELECT_Q],
  ]) {
    const result = parseAnswerReply(reply, q);
    assert.ok(result.length > 0, `expected non-empty result for reply="${reply}"`);
  }
});
