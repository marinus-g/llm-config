# Image Analysis Workflow

## Decision tree (execute in order)

1. **Delegate to `vision`** with a detailed preprompt (see examples below).
   - State how many images: "The user attached 1 image."
   - Tell vision to use its clipboard recovery if it can't see the image.
2. **`vision` handles clipboard recovery itself** — it will delegate to `system-admin` for `wl-paste`/`cliphist` if the attachment was stripped.
3. **Act** on vision's description — or delegate to the appropriate specialist.

> The orchestrator does not need to handle the clipboard step. Vision owns its own fallback.

---

## Preprompt examples

### Single image

```
The user attached 1 image and wants it described. The primary model cannot read images natively.

Try to see the attached image. If you can, describe it in detail: content, text, layout, objects, colors, and context.

If you cannot see any image, the attachment was stripped. Use your clipboard recovery procedure: delegate to system-admin to run wl-paste, then describe the saved file.
```

### Multiple images

```
The user attached 2 images and wants them described and compared. The primary model cannot read images natively.

Try to see the attached images. If you can, describe each in detail.

If you cannot see any images, the attachment was stripped. Use your clipboard recovery procedure: delegate to system-admin to run wl-paste, then describe the saved file. The most recently pasted image will be on the clipboard; older ones may still be in cliphist history.
```

---

## Rules

- Always pass a detailed preprompt — never delegate with a generic "describe this image."
- Always tell `vision` how many images to expect.
- Always include the clipboard fallback instruction in the preprompt so `vision` can self-recover.
