# Copy Ruby Symbol

This project provides a Zed task that reads the active cursor location, asks Sorbet LSP for symbols in the current file, builds a Ruby reference name, and copies it to the clipboard.

## What it does

- Cursor on a method:
  - `class A; def my_name; end; end` -> `A.my_name`
- Cursor on a nested constant:
  - `module B; class A; X = 1; end; end` -> `B::A::X`

If multiple symbols contain the cursor, the script picks the first deterministic match (smallest containing range, then source order). It copies directly to the clipboard.

## Requirements

- Zed with project tasks enabled.
- [Bun](https://bun.sh/) to build the executable.
- macOS for clipboard copy (`pbcopy`).

## Installation

1. **Run the install script** from your Ruby project root:
   ```sh
   curl -fsSL https://raw.githubusercontent.com/your-repo/zed-copy-ruby-symbol/main/install.sh | bash
   ```
   (Or clone and run locally: `bash /path/to/install.sh`)

   This builds `.zed/bin/copy-ruby-reference` and `.zed/tasks.json` (merges if already exists).

   For local development, run `bun run build` to compile `src/copy-ruby-reference.ts` into `bin/copy-ruby-reference`.

2. **Add a keybinding** to `~/.config/zed/keymap.json` (manual step):
   ```json
   {
     "context": "Editor",
     "bindings": {
       "alt-c": ["task::Spawn", { "task_name": "Ruby: Copy Reference Name" }]
     }
   }
   ```

3. **Restart Zed** — the task will appear in `task: spawn`.

## Notes and limitations

- This uses tasks because current Zed extension APIs do not expose direct active editor cursor access for custom extension commands.
- Sorbet can return different symbol shapes depending on project/file state. If no symbol contains the cursor, the task exits with a clear error.
- Clipboard integration is currently macOS-only (`pbcopy`).

## Script options

`src/copy-ruby-reference.ts` (compiled to `bin/copy-ruby-reference`) supports:

- `--file`
- `--row`
- `--column`
- `--lsp-command` (override default Sorbet command)
- `--timeout-seconds`

## TODO: Testing

```sh
bun run test
```

Tests build the CLI into `bin/` and run it against files in `example/`.
