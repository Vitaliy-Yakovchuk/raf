#!/bin/sh
set -eu
: "${RAF_QA_HOME:?Set RAF_QA_HOME to an absolute separate stand HOME}"
case "$RAF_QA_HOME" in
  /*) ;;
  *) printf '%s\n' 'RAF_QA_HOME must be absolute' >&2; exit 1 ;;
esac
if [ -z "${GIT_CONFIG_GLOBAL:-}" ]; then
  if [ -f "$HOME/.gitconfig" ]; then
    GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
  else
    GIT_CONFIG_GLOBAL="${XDG_CONFIG_HOME:-$HOME/.config}/git/config"
  fi
fi
case "$GIT_CONFIG_GLOBAL" in
  /*) ;;
  *) printf '%s\n' 'GIT_CONFIG_GLOBAL must name an absolute existing global Git config' >&2; exit 1 ;;
esac
if [ ! -f "$GIT_CONFIG_GLOBAL" ] || [ ! -r "$GIT_CONFIG_GLOBAL" ]; then
  printf '%s\n' 'Set GIT_CONFIG_GLOBAL to a readable existing global Git config with commit identity; do not change repository config' >&2
  exit 1
fi
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec env -u TMUX -u TMUX_PANE -u ALLOW_MIGRATIONS \
  HOME="$RAF_QA_HOME" RAF_QA_HOME="$RAF_QA_HOME" GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" \
  node "$script_directory/../bin/raf.ts" "$@"
