#!/bin/sh
set -eu
: "${RAF_QA_HOME:?Set RAF_QA_HOME to an absolute separate stand HOME}"
case "$RAF_QA_HOME" in
  /*) ;;
  *) printf '%s\n' 'RAF_QA_HOME must be absolute' >&2; exit 1 ;;
esac
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec env -u TMUX -u TMUX_PANE -u ALLOW_MIGRATIONS \
  HOME="$RAF_QA_HOME" RAF_QA_HOME="$RAF_QA_HOME" \
  node "$script_directory/../bin/raf.ts" "$@"
