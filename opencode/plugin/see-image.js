/**
 * see-image: vision bridge for text-only models in opencode.
 *
 * Registers a `see_image` tool that any model can call when it receives an
 * image-rejection error or when the user references an image. The tool:
 *   1. Resolves the image from the opencode SQLite DB (pasted/dragged attachments),
 *      falls back to the filesystem, then finally to the Wayland clipboard.
 *   2. Calls keye-vl (Qwen3-VL 30B MoE, strongest supported GPU vision) via the local llama-swap endpoint.
 *      Falls back to gemma3-vl-cpu (CPU, fast) on error, timeout, or empty response.
 *
 * Also injects system-prompt instructions telling the primary model to call
 * `see_image` immediately instead of reporting the rejection error to the user.
 */

import { tool } from "@opencode-ai/plugin";
import path from "path";
import os from "os";
import fs from "fs";
import { Database } from "bun:sqlite";

// ─── configuration ────────────────────────────────────────────────────────────

const LLAMA_SWAP_URL = "http://127.0.0.1:5099/v1/chat/completions";
const LLAMA_API_KEY  = process.env.LLAMA_API_KEY ?? "llama-local";

/** Primary vision model — Qwen3-VL 30B MoE, strongest supported GPU vision */
const PRIMARY_MODEL  = "keye-vl";
/** Fallback vision model — CPU, fast, never evicts GPU coder model */
const FALLBACK_MODEL = "gemma3-vl-cpu";

/** Request timeout in ms (AbortController) */
const VISION_TIMEOUT = 60_000;

const EXT_MEDIA = {
  png:  "image/png",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  gif:  "image/gif",
  webp: "image/webp",
  bmp:  "image/bmp",
};

// ─── image resolution ─────────────────────────────────────────────────────────

function opencodeDbPath() {
  const xdgDataHome = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "opencode")
    : "";
  const dataDir =
    process.env.OPENCODE_DATA_DIR ||
    xdgDataHome ||
    path.join(os.homedir(), ".local/share/opencode");
  return path.join(dataDir, "opencode.db");
}

/**
 * Try to resolve an image from opencode's SQLite part table.
 * Returns { dataUrl, mediaType, source } or null.
 */
function resolveFromDb(filename, sessionID) {
  const dbPath = opencodeDbPath();
  if (!fs.existsSync(dbPath)) return null;

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
    let rows;

    const isClipboard = !filename || filename === "clipboard";
    if (isClipboard) {
      if (sessionID) {
        rows = db
          .query(
            `SELECT data FROM part
             WHERE session_id = ?
               AND json_extract(data, '$.type') = 'file'
               AND json_extract(data, '$.url') LIKE 'data:%'
             ORDER BY time_created DESC LIMIT 1`,
          )
          .all(sessionID);
      } else {
        rows = db
          .query(
            `SELECT data FROM part
             WHERE json_extract(data, '$.type') = 'file'
               AND json_extract(data, '$.url') LIKE 'data:%'
             ORDER BY time_created DESC LIMIT 1`,
          )
          .all();
      }
    } else {
      if (sessionID) {
        rows = db
          .query(
            `SELECT data FROM part
             WHERE session_id = ?
               AND json_extract(data, '$.type') = 'file'
               AND json_extract(data, '$.filename') = ?
             ORDER BY time_created DESC LIMIT 1`,
          )
          .all(sessionID, filename);
      } else {
        rows = db
          .query(
            `SELECT data FROM part
             WHERE json_extract(data, '$.type') = 'file'
               AND json_extract(data, '$.filename') = ?
             ORDER BY time_created DESC LIMIT 1`,
          )
          .all(filename);
      }
    }

    if (!rows.length) return null;
    const part = JSON.parse(rows[0].data);
    const url = part.url ?? "";
    if (!url.startsWith("data:")) return null;

    return { dataUrl: url, mediaType: part.mime ?? "image/png", source: "opencode-db" };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Try to resolve an image from the filesystem.
 * Returns { dataUrl, mediaType, source } or null.
 */
function resolveFromFilesystem(name, cwd) {
  if (!name || name === "clipboard") return null;

  // Expand tilde
  if (name.startsWith("~")) name = path.join(os.homedir(), name.slice(1));

  let absPath = null;
  if (path.isAbsolute(name) && fs.existsSync(name)) {
    absPath = name;
  } else {
    const resolved = path.resolve(cwd, name);
    if (fs.existsSync(resolved)) absPath = resolved;
  }

  if (!absPath) {
    // Last-resort search: /tmp, ~/Desktop, ~/Downloads, cwd
    for (const dir of ["/tmp", path.join(os.homedir(), "Desktop"), path.join(os.homedir(), "Downloads"), cwd]) {
      if (!dir) continue;
      try {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) { absPath = full; break; }
      } catch {}
    }
  }

  if (!absPath) return null;

  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mediaType = EXT_MEDIA[ext] ?? "image/png";
  const b64 = Buffer.from(fs.readFileSync(absPath)).toString("base64");
  return { dataUrl: `data:${mediaType};base64,${b64}`, mediaType, source: absPath };
}

/**
 * Try to resolve the most recent Wayland clipboard image via wl-paste / cliphist.
 * Uses the plugin's `$` shell so no subagent spawn is needed.
 * Returns { dataUrl, mediaType, source } or null.
 */
async function resolveFromClipboard($) {
  const tmpPath = path.join(os.tmpdir(), `see-image-clip-${Date.now()}.png`);
  try {
    await $`wl-paste --type image/png --output ${tmpPath}`;
    if (fs.existsSync(tmpPath)) {
      const b64 = Buffer.from(fs.readFileSync(tmpPath)).toString("base64");
      return { dataUrl: `data:image/png;base64,${b64}`, mediaType: "image/png", source: "wl-paste" };
    }
  } catch {}

  // Try cliphist — get the most recent entry that looks like an image
  try {
    const list = await $`cliphist list`.text();
    const lines = list.split("\n").filter(Boolean);
    for (const line of lines) {
      const id = line.split("\t")[0];
      if (!id) continue;
      try {
        await $`sh -c ${`cliphist decode ${id} > ${tmpPath}`}`;
        if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
          const b64 = Buffer.from(fs.readFileSync(tmpPath)).toString("base64");
          return { dataUrl: `data:image/png;base64,${b64}`, mediaType: "image/png", source: `cliphist:${id}` };
        }
      } catch {}
    }
  } catch {}

  return null;
}

/** Master resolution: DB → filesystem → clipboard */
async function resolveImage(name, cwd, sessionID, $) {
  const fromDb = resolveFromDb(name, sessionID);
  if (fromDb) return fromDb;

  const fromFs = resolveFromFilesystem(name, cwd);
  if (fromFs) return fromFs;

  const fromClip = await resolveFromClipboard($);
  if (fromClip) return fromClip;

  throw new Error(
    `see_image: could not find "${name}". Searched opencode DB, filesystem, and Wayland clipboard. ` +
    "Pass an absolute file path, or ensure the image is attached to the message.",
  );
}

// ─── vision call ──────────────────────────────────────────────────────────────

/**
 * Call a vision model via the local llama-swap OpenAI-compatible endpoint.
 * Returns the text content of the first choice.
 */
async function callVision(dataUrl, mediaType, prompt, model, abort) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT);
  const signal = abort
    ? AbortSignal.any([controller.signal, abort])
    : controller.signal;

  try {
    const res = await fetch(LLAMA_SWAP_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LLAMA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) throw new Error("empty response");
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try primary model, fall back to fallback model on any error.
 * Returns { text, model }.
 */
async function callVisionWithFallback(dataUrl, mediaType, prompt, abort) {
  try {
    const text = await callVision(dataUrl, mediaType, prompt, PRIMARY_MODEL, abort);
    return { text, model: PRIMARY_MODEL };
  } catch (primaryErr) {
    console.error(`[see-image] ${PRIMARY_MODEL} failed (${primaryErr.message}), trying ${FALLBACK_MODEL}`);
    try {
      const text = await callVision(dataUrl, mediaType, prompt, FALLBACK_MODEL, abort);
      return { text, model: FALLBACK_MODEL };
    } catch (fallbackErr) {
      throw new Error(
        `see_image: both vision models failed.\n` +
        `  ${PRIMARY_MODEL}: ${primaryErr.message}\n` +
        `  ${FALLBACK_MODEL}: ${fallbackErr.message}`,
      );
    }
  }
}

// ─── system prompt instructions ───────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `# Vision bridge — see_image tool

You have a \`see_image\` tool. Use it immediately in ALL of these situations — do not tell the user about the error first, do not ask for confirmation:

## When to call see_image

1. You receive an error containing \`Cannot read "Screenshot\` or \`Cannot read "...png"\` or \`Cannot read "...jpg"\` or any image filename in quotes.
2. The error message says \`this model does not support image input\`.
3. The error starts with \`ERROR:\` and mentions an image file.
4. The user attaches an image, pastes a screenshot, or references one ("see this", "look at this", ".png", ".jpg", "screenshot").
5. The user says "clipboard" or "what's in my clipboard" and likely means an image.

## How to use it

1. Extract the filename from the error (it is in quotes, e.g. \`Screenshot 2026-06-19 at 02.18.53.png\`), or use \`"clipboard"\` if no filename.
2. Call \`see_image\` with that as \`filePath\`. Optionally pass a \`question\` if the user asked something specific about the image.
3. Answer using the returned description as if you saw the image yourself. Be natural.

## Rules

- NEVER repeat the rejection error to the user. Just call the tool.
- NEVER guess image contents — if you haven't called see_image, you haven't seen the image.
- Do NOT use see_image for text files (\`.ts\`, \`.md\`, \`.json\`, etc.) — use \`read\` instead.
- If see_image cannot find the image, tell the user the filename and ask for an absolute path.
- The tool automatically picks the strongest available local vision model and falls back to a fast CPU model if the GPU is busy.`;

// ─── plugin export ────────────────────────────────────────────────────────────

/** @type {import("@opencode-ai/plugin").Plugin} */
export const server = async (ctx) => {
  const { $ } = ctx;

  const seeImageTool = tool({
    description:
      "See an image/screenshot that the current model cannot view. " +
      "Call when the user attaches an image and you get a \"this model does not support image input\" " +
      "or \"Cannot read\" error, or when a screenshot/image is referenced. " +
      "Routes the image to a local vision model (Qwen3-VL primary → gemma3-vl-cpu CPU fallback) " +
      "and returns a detailed textual description. " +
      "Pass filePath as an absolute path, a bare filename (auto-located from opencode DB or filesystem), " +
      "or \"clipboard\" to read the most recent Wayland clipboard image.",
    args: {
      filePath: tool.schema
        .string()
        .describe(
          'Path to the image. Absolute path, bare filename like "Screenshot 2026-06-18.png" to auto-locate, or "clipboard".',
        ),
      question: tool.schema
        .string()
        .optional()
        .describe(
          [
            "What to ask the vision model. Omit for a general detailed description. Tailor for better results:",
            '- Text/code in image: "Transcribe all text exactly, preserving layout and indentation."',
            '- Error/stack trace: "Quote the exact error message and stack trace, then state the likely cause."',
            '- UI screenshot: "Describe layout, components, text, colors, and spacing precisely enough to rebuild this UI in code."',
            '- Diagram/architecture: "Explain this diagram: list each component and the relationships between them."',
            '- Chart/graph: "Read this visualization: axes, series, key values, and the main takeaway."',
            "Otherwise pass the user's specific question verbatim.",
          ].join("\n"),
        ),
    },
    async execute(args, context) {
      const resolved = await resolveImage(
        args.filePath,
        context.directory,
        context.sessionID,
        $,
      );

      const prompt =
        args.question?.trim()
          ? args.question.trim()
          : "Describe this image in detail. If it is a screenshot, describe the UI, text content, and layout precisely. Be thorough and accurate.";

      context.metadata({ title: `see_image: looking at ${args.filePath}…`, metadata: { working: true } });

      const { text, model } = await callVisionWithFallback(
        resolved.dataUrl,
        resolved.mediaType,
        prompt,
        context.abort,
      );

      context.metadata({
        title: `see_image: ${args.filePath}`,
        metadata: { model, source: resolved.source },
      });

      return text;
    },
  });

  return {
    tool: { see_image: seeImageTool },
    "experimental.chat.system.transform": async (_input, output) => {
      // Append to the existing first system block rather than pushing a new entry.
      // Strict Jinja templates (qwen3-coder) reject multiple system messages, so
      // adding a new array element would cause a "System message must be at the
      // beginning" error regardless of plugin load order. Appending in-place keeps
      // the array at length 1 and is safe for all templates.
      if (output.system.length > 0) {
        output.system[0] = output.system[0] + "\n\n" + SYSTEM_INSTRUCTIONS;
      } else {
        output.system.splice(0, 0, SYSTEM_INSTRUCTIONS);
      }
    },
  };
};
