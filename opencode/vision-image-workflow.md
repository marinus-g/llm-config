# Image Analysis Workflow

## Default path — `see_image` tool (use this first)

When an image/screenshot/diagram is attached or referenced, or when you receive a
"this model does not support image input" / "Cannot read …png" rejection error:

1. **Call `see_image` immediately** — do not tell the user you can't see the image.
   - `filePath`: bare filename from the error (e.g. `"Screenshot 2026-06-18.png"`), or `"clipboard"`.
   - `question` (optional): the user's specific ask, or omit for a full description.
2. **Act** on the returned description — answer the user directly or delegate to the right specialist.

The tool resolves the image from the opencode DB (pasted/dragged attachments), filesystem, or
Wayland clipboard in that order. It calls `qwen3-moe-vl` (GPU, strongest) and automatically
falls back to `gemma3-vl-cpu` (CPU, fast) if the GPU is busy.

---

## Deep analysis path — `vision` subagent

Use the `vision` subagent (via `Task`) only when you need:
- Exhaustive, structured description (the vision agent's output format is more detailed)
- Multi-step OCR or cross-referencing several images
- The primary model cannot use tools at all (no tool support in that context)

### Single image preprompt

```
The user attached 1 image and wants it described. The primary model cannot read images natively.

Try to see the attached image. If you can, describe it in detail: content, text, layout, objects, colors, and context.

If you cannot see any image, the attachment was stripped. Use your clipboard recovery procedure:
delegate to system-admin to run wl-paste, then describe the saved file.
```

### Multiple images preprompt

```
The user attached 2 images and wants them described and compared. The primary model cannot read images natively.

Try to see the attached images. If you can, describe each in detail.

If you cannot see any images, the attachment was stripped. Use your clipboard recovery procedure:
delegate to system-admin to run wl-paste for the most recent image, then check cliphist for older ones.
```

---

## Rules

- **Always try `see_image` first** — it is faster (no subagent spawn) and handles clipboard recovery automatically.
- Use the `vision` subagent only for deep/exhaustive cases listed above.
- Never guess image contents. If `see_image` fails and the vision subagent also fails, report the error and ask the user for an absolute file path.
