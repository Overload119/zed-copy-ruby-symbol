#!/bin/bash
set -e

PROJECT_DIR="${1:-.}"
TMP_DIR="$PROJECT_DIR/.zed-copy-ruby-symbol-tmp"

rm -rf "$TMP_DIR"
git clone --depth 1 https://github.com/Overload119/zed-copy-ruby-symbol.git "$TMP_DIR"

BIN_DIR="$PROJECT_DIR/.zed/bin"
TASKS_FILE="$PROJECT_DIR/.zed/tasks.json"

mkdir -p "$BIN_DIR"

if [ -f "$BIN_DIR/copy-ruby-reference" ]; then
  echo "Binary already installed, skipping build."
else
  bun build --compile "$TMP_DIR/src/copy-ruby-reference.ts" --outfile "$BIN_DIR/copy-ruby-reference"
  echo "Built binary at $BIN_DIR/copy-ruby-reference"
fi

NEW_TASK='{
  "label": "Ruby: Copy Reference Name",
  "command": "ZED_SYMBOL=\"$ZED_SYMBOL\" .zed/bin/copy-ruby-reference --file \"$ZED_FILE\" --row \"$ZED_ROW\" --column \"$ZED_COLUMN\""
}'

if [ -f "$TASKS_FILE" ]; then
  EXISTING=$(cat "$TASKS_FILE")
  if echo "$EXISTING" | grep -q "Ruby: Copy Reference Name"; then
    echo "Task already exists in $TASKS_FILE, skipping."
  else
    echo "$EXISTING" | jq ". + [$NEW_TASK]" > "$TASKS_FILE"
    echo "Added task to existing $TASKS_FILE"
  fi
else
  echo "[$NEW_TASK]" > "$TASKS_FILE"
  echo "Created $TASKS_FILE"
fi

rm -rf "$TMP_DIR"

echo "Done! Add this to your keymap.json (~/.config/zed/keymap.json):"
echo '{ "context": "Editor", "bindings": { "alt-c": ["task::Spawn", { "task_name": "Ruby: Copy Reference Name" }] } }'