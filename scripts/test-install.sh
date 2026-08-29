#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fixture=$tmp/repo
vault=$tmp/vault
mkdir -p "$fixture/scripts" "$fixture/plugin" "$vault/.obsidian"
cp "$repo/scripts/install.sh" "$fixture/scripts/install.sh"
cp "$repo/manifest.json" "$fixture/manifest.json"
cp "$repo/theme.css" "$fixture/theme.css"
cp "$repo/plugin/manifest.json" "$fixture/plugin/manifest.json"
cp "$repo/plugin/styles.css" "$fixture/plugin/styles.css"
printf '%s\n' 'built plugin fixture' > "$fixture/plugin/main.js"

"$fixture/scripts/install.sh" "$vault"
theme_dir=$vault/.obsidian/themes/Forester
plugin_dir=$vault/.obsidian/plugins/forester
test -L "$theme_dir/manifest.json"
test -L "$theme_dir/theme.css"
test "$(readlink "$theme_dir/manifest.json")" = "$fixture/manifest.json"
test "$(readlink "$theme_dir/theme.css")" = "$fixture/theme.css"
test -L "$plugin_dir"

"$fixture/scripts/install.sh" "$vault"
test -L "$theme_dir/manifest.json"
test -L "$theme_dir/theme.css"
test "$(readlink "$theme_dir/manifest.json")" = "$fixture/manifest.json"
test "$(readlink "$theme_dir/theme.css")" = "$fixture/theme.css"
test -L "$plugin_dir"
test "$(readlink "$plugin_dir")" = "$fixture/plugin"

"$fixture/scripts/install.sh" --copy "$vault"
test ! -L "$theme_dir/manifest.json"
test ! -L "$theme_dir/theme.css"
test -f "$theme_dir/manifest.json"
test -f "$theme_dir/theme.css"
cmp "$fixture/manifest.json" "$theme_dir/manifest.json"
cmp "$fixture/theme.css" "$theme_dir/theme.css"
test ! -L "$plugin_dir"
test -f "$plugin_dir/manifest.json"
test -f "$plugin_dir/main.js"
test -f "$plugin_dir/styles.css"

echo "installer link and copy modes pass"
