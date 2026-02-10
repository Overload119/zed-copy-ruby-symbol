# Cursor-Aware Ruby FQN Copy (Zed Task + Sorbet LSP)

This project provides a Zed task that reads the active cursor location, asks Sorbet LSP for symbols in the current file, builds a Ruby fully qualified name, and copies it to the clipboard.

## What it does

- Cursor on a method:
  - `class A; def my_name; end; end` -> `A.my_name`
- Cursor on a nested constant:
  - `module B; class A; X = 1; end; end` -> `B::A::X`

If multiple symbols contain the cursor, the script picks the first deterministic match (smallest containing range, then source order).

## Requirements

- Zed with project tasks enabled.
- Python 3.
- Sorbet LSP available in your project or shell path.
  - Default command used by the script: `bundle exec srb tc --lsp`
- macOS for clipboard copy (`pbcopy`).

## Included task

The task is defined in `.zed/tasks.json`:

- Label: `Ruby: Copy FQN at Cursor`
- Runs:
  - `python3 scripts/copy_ruby_fqn.py --file "$ZED_FILE" --row "$ZED_ROW" --column "$ZED_COLUMN"`

Run it from command palette via `task: spawn`, then pick `Ruby: Copy FQN at Cursor`.

## Optional keybinding

Add this to your `keymap.json` to trigger the task directly:

```json
[
  {
    "context": "Workspace",
    "bindings": {
      "cmd-alt-y": ["task::Spawn", { "task_name": "Ruby: Copy FQN at Cursor" }]
    }
  }
]
```

## Notes and limitations

- This uses tasks because current Zed extension APIs do not expose direct active editor cursor access for custom extension commands.
- Sorbet can return different symbol shapes depending on project/file state. If no symbol contains the cursor, the task exits with a clear error.
- Clipboard integration is currently macOS-only (`pbcopy`).

## Script options

`scripts/copy_ruby_fqn.py` supports:

- `--file`
- `--row`
- `--column`
- `--lsp-command` (override default Sorbet command)
- `--timeout-seconds`
