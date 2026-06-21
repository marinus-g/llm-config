---
description: "Create, drive, or recover a staged workflow. Usage: /workflow create|validate|start|list|attach|status|log|doctor|finish|recover|rewind|pause|resume|retry|confirm|skip|stop|reset|danger"
agent: workflow-orchestrator
---

Raw arguments:

```text
$ARGUMENTS
```

If the first token is `create`, do not call `workflow_control`. Build a new
workflow interactively in this conversation:

1. Obtain the destination path first. If it was supplied after `create`, repeat
   it and ask the user to confirm it before gathering requirements. The final
   directory must not already exist and its parent directory must exist.
2. Inspect the destination repository's `AGENTS.md`, manifests, scripts, and
   relevant structure so verification commands and constraints are real. Do not
   edit anything during this discovery.
3. Ask what the workflow should accomplish. Gather its deliverables,
   constraints, architecture or compatibility decisions, exclusions, and
   acceptance criteria. After every answer, briefly summarize what was added
   and explicitly ask: "Is there anything else this workflow should include?"
   Continue until the user says no.
4. Propose the ordered stages and their TODOs. Ask the same "anything else"
   question after presenting the outline and incorporate revisions until the
   user says no.
5. Prepare a full directory draft with `00-context.md` and one root-level
   `NN-stage-name.md` file per stage. Supporting Markdown files may be added in
   subdirectories when useful. Every TODO must be unchecked, use an ID matching
   its stage, contain a concrete requirement, include exactly one
   `Context7: required` or `Context7: not-applicable` line, and include at least
   one exact `Verify` command or `Verify manual` criterion. Every stage must have
   exactly one exact `Stage gate` command. Prefer automated verification and use
   commands available in the inspected repository.
6. Show a concise final summary containing the destination, files, stages,
   TODO count, gates, and important assumptions. Ask for explicit confirmation
   to write it. If the user requests changes, apply them and repeat the summary
   and confirmation.
7. Only after confirmation, call `workflow_create` exactly once with the path
   and complete file contents. The tool is authorized only by this explicit
   `/workflow create` command, and a path supplied to the command is enforced.
   Return only its result. Do not start the workflow.

For every other first token, call `workflow_control` exactly once. Map the first
token to `action` as described below.

Map the first token to `action`. For `validate` and `start`, pass the path and
numeric turn limits; for `start`, also pass `noConfirm` when `--no-confirm` is
present. For `attach` or `reset`, pass the workflow ID. For
`confirm`, pass the remaining text as evidence. For `skip confirm`, pass the
remaining text as reason. For `log`, pass an optional numeric limit. For
`doctor`, pass an optional workflow ID. For `recover`, pass the path, optional
branch/base values, and whether confirmation was requested. For `pause`, set
`immediate` only when the second token is `now`; plain `pause` requests the next
verified checkpoint. `list` opens an interactive TUI picker (dispatched via the tool so the picker
opens exactly once); use `list-plain` to get the text list programmatically. For `danger`, set `dangerMode`
to `toggle` when there is no second token, or to `on`/`off` when that explicit
second token is present. Danger mode requires an attached workflow and bypasses
command/edit approval prompts while active. For `rewind stage <stage> confirm`, pass
the stage and set `confirm` to true. Rewind is allowed only while paused, blocked, or stopped.
Do not delegate, browse, inspect
files, or explain the command before calling the tool. For `attach`, a
successful result starts with `◈ Attached`. If the result does
not start with that exact prefix, reproduce the exact result, then briefly
evaluate its likely cause and give the next safe action; never claim attachment
succeeded. For every other action, and for a successful attach, return only the
tool result.
