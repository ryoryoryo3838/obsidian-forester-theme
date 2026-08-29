#!/bin/sh
# Install the theme and the plugin into an Obsidian vault.
#
#   ./scripts/install.sh [--copy] [VAULT]
#
# Default is symlinks, so `npm run dev` in plugin/ is picked up by Obsidian's
# "Reload app without saving" without re-copying.
#
# --copy installs real files instead. Use it for any vault that syncs to
# Obsidian mobile: a symlink committed to git or handed to a sync service does
# not resolve on a phone.
set -eu

mode=link
case ${1-} in
--copy)
	mode=copy
	shift
	;;
--*)
	echo "unknown option: $1" >&2
	exit 2
	;;
esac

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

for required in manifest.json theme.css plugin/main.js; do
  if [ ! -f "$repo/$required" ]; then
    if [ "$required" = plugin/main.js ]; then
      echo "plugin/main.js is missing; run 'npm run build' in plugin/ first" >&2
    else
      echo "$required is missing from the repository root" >&2
    fi
    exit 1
  fi
done

vault=${1:-$HOME/wiki.miya-lis.net}

if [ ! -d "$vault/.obsidian" ]; then
	echo "not an Obsidian vault: $vault" >&2
	exit 1
fi

theme_dir=$vault/.obsidian/themes/Forester
plugin_dir=$vault/.obsidian/plugins/forester

mkdir -p "$vault/.obsidian/themes" "$vault/.obsidian/plugins"

replace() {
	path=$1
	if [ -e "$path" ] && [ ! -L "$path" ] && [ "$mode" = link ]; then
		echo "refusing to replace non-symlink: $path" >&2
		exit 1
	fi
	rm -rf "$path"
}

if [ "$mode" = link ]; then
  if [ -L "$theme_dir" ] || { [ -e "$theme_dir" ] && [ ! -d "$theme_dir" ]; }; then
    replace "$theme_dir"
  fi
  replace "$plugin_dir"
  mkdir -p "$theme_dir"
  replace "$theme_dir/manifest.json"
  replace "$theme_dir/theme.css"
  ln -s "$repo/manifest.json" "$theme_dir/manifest.json"
	ln -s "$repo/theme.css" "$theme_dir/theme.css"
	ln -s "$repo/plugin" "$plugin_dir"
	echo "linked $theme_dir -> $repo/{manifest.json,theme.css}"
	echo "linked $plugin_dir -> $repo/plugin"
else
	[ -L "$theme_dir" ] && rm -f "$theme_dir"
	[ -L "$plugin_dir" ] && rm -f "$plugin_dir"
	mkdir -p "$theme_dir" "$plugin_dir"

	[ -L "$theme_dir/manifest.json" ] && rm -f "$theme_dir/manifest.json"
	[ -L "$theme_dir/theme.css" ] && rm -f "$theme_dir/theme.css"
	cp "$repo/manifest.json" "$repo/theme.css" "$theme_dir/"
	cp "$repo/plugin/manifest.json" "$repo/plugin/main.js" \
		"$repo/plugin/styles.css" "$plugin_dir/"

	echo "copied theme  -> $theme_dir"
	echo "copied plugin -> $plugin_dir"
	echo
	echo "For mobile, these files must reach the phone. Note that"
	echo "$vault/.gitignore currently ignores /.obsidian, so obsidian-git will"
	echo "not carry them; un-ignore the two directories above, or use Obsidian Sync."
fi

echo
echo "Next: enable the theme (Appearance -> Themes -> Forester) and the"
echo "plugin (Community plugins -> Forester) in $vault."
