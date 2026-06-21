# Image Analysis Workflow

General workflow for analyzing images attached to chat when the model can't read them natively.

## Workflow

### Step 1: Try vision agent first

If an image is attached but the model says it can't read it, immediately delegate to the `vision` subagent — the local VL model can often handle it regardless of the primary model's capabilities.

### Step 2: Clipboard capture + vision agent (fallback)

If the vision agent can't handle the attached image directly (e.g., attachment was stripped by the non-vision model), capture from the clipboard and delegate:

1. **Check clipboard** — delegate to `system-admin` agent to verify and extract:
   - Run `wl-paste --list-types` to verify `image/png` or `image/jpeg` in clipboard
   - Run `wl-paste --type image/png --output /tmp/clipboard-image-YYYYMMDD-HHMMSS.png`
   - Also check `cliphist list` as fallback
2. **Delegate to vision agent** — once the image is saved to `/tmp`, call the `vision` subagent with the file path
3. **Report findings** — summarize the vision agent's output concisely

## Key detail

The image attachment mechanism in the chat interface does NOT pass images to the model when running on a non-vision model (qwen3-mcp). The attachment is stripped before reaching the model. In that case, the clipboard capture + /tmp + vision agent delegation is the reliable fallback. **Always pass a detailed preprompt to the vision agent (see section below) — never delegate with just a generic 'describe this image' instruction.**

## Delegating to the vision agent

When you delegate to the `vision` subagent for image analysis, always pass a **detailed preprompt** that includes:

### 1. How many attachments to expect
The primary model can't read attachments, but it can *count* them from the chat interface. Always tell the vision agent how many images were attached:

> "The user attached 1 image. Describe it in detail."
> "The user attached 2 images. Analyze both and compare them."

### 2. Clipboard check instruction
The attached image may not reach the vision agent. Instruct it to fall back to the clipboard:

> "First, try to see the attached image. If it's not visible, check the clipboard: run `wl-paste --list-types` to check for `image/png`. If available, save it with `wl-paste --type image/png --output /tmp/clipboard-image.png`, then analyze `/tmp/clipboard-image.png`. If that doesn't exist, check `cliphist list` and extract the most recent image entry."

### Full preprompt example (single image):
```
The user attached 1 image and wants it described. The primary model cannot read images natively — the attachment may have been stripped.

First, check if you can see the attached image. If you can, describe it in detail: content, text, layout, objects, colors, and context.

If you cannot see an image, the attachment was stripped. Fall back to the clipboard:
1. Run `wl-paste --list-types` to check for `image/png`
2. If available, save: `wl-paste --type image/png --output /tmp/clipboard-image.png`
3. If the file exists, analyze `/tmp/clipboard-image.png`
4. If that fails, check `cliphist list` for recent image entries and extract the most recent one
5. Describe whatever image you find
```

### Full preprompt example (multiple images):
```
The user attached 2 images and wants them described and compared. The primary model cannot read images natively — the attachment may have been stripped.

First, check if you can see the attached images. If you can, describe each in detail.

If you cannot see images, fall back to the clipboard. The most recently pasted image will be on the live clipboard. Extract it with `wl-paste` as above and describe it. Note that older attachments may still be in `cliphist` history.
```

## Available tools (on this system)

- `wl-paste` — Wayland clipboard access (primary)
- `cliphist` — clipboard history manager (fallback)
- Both at `/usr/bin/`

---
tags: ai/memory/lesson/vision | source: marinus | modified: 2026-06-06
