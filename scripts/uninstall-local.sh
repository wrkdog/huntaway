#!/bin/sh
# Remove the `huntaway` command and the installed code copies. Your run history (the request log, the run list and
# the install key) is kept unless you pass --purge-history, which deletes it permanently.
set -eu
usage() { echo "usage: sh scripts/uninstall-local.sh [--purge-history]" >&2; exit 2; }
purge=0
while [ $# -gt 0 ]; do
  case "$1" in --purge-history) purge=1; shift ;; *) usage ;; esac
done
case "${HOME:-}" in /*) ;; *) echo "huntaway: HOME must be an absolute path" >&2; exit 1 ;; esac
nl='
'
case "$HOME" in *"$nl"*) echo "huntaway: HOME must not contain a newline" >&2; exit 1 ;; esac
while :; do case "$HOME" in */) HOME=${HOME%/} ;; *) break ;; esac; done
[ -n "$HOME" ] && [ -d "$HOME" ] || { echo "huntaway: HOME must be an existing folder other than /" >&2; exit 1; }
MARKER="installed by scripts/install-local.sh"
kept_command=0
root="$HOME/.local/share/huntaway"
wrapper="$HOME/.local/bin/huntaway"
for p in "$HOME/.local" "$HOME/.local/share" "$root" "$root/app" "$HOME/.local/bin"; do
  if [ -L "$p" ]; then echo "huntaway: refusing: a symbolic link sits where Huntaway installs" >&2; exit 1; fi
done
# Ours only if line 2 has the form the installer writes: "# huntaway <commit>, installed by scripts/install-local.sh".
ours() { [ -f "$1" ] && [ ! -L "$1" ] && case "$(sed -n 2p "$1")" in "# huntaway "*", $MARKER") true ;; *) false ;; esac; }
if [ -e "$wrapper" ] || [ -L "$wrapper" ]; then
  if ours "$wrapper"; then
    rm -f "$wrapper"
  else
    echo "huntaway: leaving ~/.local/bin/huntaway alone: it was not installed by this script" >&2
    kept_command=1
  fi
fi
if [ -d "$root/app" ]; then chmod -R u+w "$root/app"; rm -rf "$root/app"; fi
if [ "$purge" = 1 ]; then
  # Every file Huntaway writes: the request log, the run list (and the older runs.json), the install key, and the
  # temporary names and markers they are created under.
  for f in requests.db runs.db spend.sqlite; do rm -f "$root/$f" "$root/$f-wal" "$root/$f-shm" "$root/$f-journal"; done
  rm -f "$root/runs.json" "$root/key"
  rm -rf "$root/requests.db.creating"
  rm -f "$root"/key.[0-9]*.tmp
  if rmdir "$root" 2>/dev/null || [ ! -e "$root" ]; then
    what="history deleted"
  else
    what="history deleted; other files were left in ~/.local/share/huntaway"
  fi
else
  what="history kept"
fi
if [ "$kept_command" = 1 ]; then echo "huntaway code removed; the other huntaway command was left alone; $what"
else echo "huntaway removed; $what"; fi
