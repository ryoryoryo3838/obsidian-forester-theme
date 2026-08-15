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
vault=${1:-$HOME/wiki.miya-lis.net}

if [ ! -d "$vault/.obsidian" ]; then
	echo "not an Obsidian vault: $vault" >&2
	exit 1
fi

theme_dir=$vault/.obsidian/themes/Forester
plugin_dir=$vault/.obsidian/plugins/forester

if [ ! -f "$repo/plugin/main.js" ]; then
	echo "plugin/main.js is missing; run 'npm run build' in plugin/ first" >&2
	exit 1
fi

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
	replace "$theme_dir"
	replace "$plugin_dir"
	ln -s "$repo/theme" "$theme_dir"
	ln -s "$repo/plugin" "$plugin_dir"
	echo "linked $theme_dir -> $repo/theme"
	echo "linked $plugin_dir -> $repo/plugin"
else
	[ -L "$theme_dir" ] && rm -f "$theme_dir"
	[ -L "$plugin_dir" ] && rm -f "$plugin_dir"
	mkdir -p "$theme_dir/fonts" "$plugin_dir"

	cp "$repo/theme/manifest.json" "$repo/theme/theme.css" "$theme_dir/"
	cp "$repo/theme/fonts/"*.woff2 "$theme_dir/fonts/"
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
