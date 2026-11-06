#!/bin/sh
# Install the committed Huntaway code (HEAD of this checkout) for the current user: a read-only copy under
# ~/.local/share/huntaway/app/<commit> and a `huntaway` command in ~/.local/bin. No network, no sudo, nothing outside
# your home folder. Run it again after pulling to move the command to the new commit (old copies stay until removed).
#   sh scripts/install-local.sh [--alias NAME] [--standalone | --router --fleet-aliases LIST]
# --alias names this machine (letters, digits, spaces, '_' and '-', at most 32; for example Studio or My Mac mini).
# --standalone is for a machine without the Router: `huntaway status` reports this machine only, and `huntaway ask`
# uses your own API key. --router is for a Router setup: `ask` runs through the pipe on your subscriptions, and
# --fleet-aliases (required with it) names the machines in the Router's fleet reading (nodeid=Name,nodeid=Name).
# Each choice is written into the `huntaway` command; without either, `ask` uses your own API key.
set -eu
umask 077                                  # everything this script creates is the owner's alone (the command: 755)
usage() { echo "usage: sh scripts/install-local.sh [--alias NAME] [--standalone | --router --fleet-aliases LIST]" >&2; exit 2; }
alias_name=""
standalone=0
router=0
fleet_aliases=""
fleet_given=0
while [ $# -gt 0 ]; do
  case "$1" in
    --alias) [ $# -ge 2 ] || usage; alias_name=$2; shift 2 ;;
    --standalone) standalone=1; shift ;;
    --router) router=1; shift ;;
    --fleet-aliases) [ $# -ge 2 ] || usage; fleet_aliases=$2; fleet_given=1; shift 2 ;;
    *) usage ;;
  esac
done
if [ "$standalone" = 1 ] && [ "$router" = 1 ]; then usage; fi
if [ "$fleet_given" = 1 ] && [ "$router" != 1 ]; then usage; fi
# A Router install reads the fleet, so it needs the machines' names: without them every `status` would fail.
if [ "$router" = 1 ] && [ -z "$fleet_aliases" ]; then
  echo "huntaway: --router needs --fleet-aliases nodeid=Name,... (the machines in the Router's fleet reading)" >&2; exit 2
fi
# The fleet names are written into the command as one single-quoted word, and hold only node ids (a-z, 0-9, '-'), '=',
# alias characters and commas; the product checks the exact shape when it reads them.
if [ -n "$fleet_aliases" ]; then
  left=$(printf '%s.' "$fleet_aliases" | LC_ALL=C tr -d 'A-Za-z0-9 _=,-')
  if [ "$left" != "." ] || [ "${#fleet_aliases}" -gt 512 ]; then
    echo "huntaway: --fleet-aliases takes nodeid=Name pairs separated by commas" >&2; exit 2
  fi
fi
# The alias goes into the command inside double quotes, so it may hold only letters, digits, spaces, '_' and '-',
# start with a letter or digit, and not end with a space: nothing a shell would expand, escape or end a quote with.
# `tr` in the C locale deletes exactly the allowed bytes; anything left over (a backslash, a newline, a non-ASCII
# letter) refuses it. The '.' sentinel keeps a trailing newline from being dropped by the command substitution.
if [ -n "$alias_name" ]; then
  leftover=$(printf '%s.' "$alias_name" | LC_ALL=C tr -d 'A-Za-z0-9 _-')
  first=$(printf '%s' "$alias_name" | LC_ALL=C cut -c1)
  first_left=$(printf '%s.' "$first" | LC_ALL=C tr -d 'A-Za-z0-9')
  case "$alias_name" in *' ') trailing=1 ;; *) trailing=0 ;; esac
  if [ "$leftover" != "." ] || [ "$first_left" != "." ] || [ "$trailing" = 1 ] || [ "${#alias_name}" -gt 32 ]; then
    echo "huntaway: the alias may use letters, digits, spaces, '_' and '-', at most 32, starting with a letter or digit and not ending with a space" >&2
    exit 2
  fi
fi
if [ "$standalone" = 1 ] && [ -z "$alias_name" ]; then
  echo "huntaway: --standalone needs --alias NAME (the name this machine reports as)" >&2; exit 2
fi

MARKER="installed by scripts/install-local.sh"
# Only this checkout decides what is installed: no inherited git setting (a location, a namespace, injected config)
# may redirect it, so every GIT_* variable is dropped.
for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
nl='
'
case "${HOME:-}" in /*) ;; *) echo "huntaway: HOME must be an absolute path" >&2; exit 1 ;; esac
case "$HOME" in *"$nl"*) echo "huntaway: HOME must not contain a newline" >&2; exit 1 ;; esac
# Node refuses to load code from a path containing a backslash, so such a home could never run Huntaway.
case "$HOME" in *\\*) echo "huntaway: HOME must not contain a backslash (Node cannot load code from such a path)" >&2; exit 1 ;; esac
while :; do case "$HOME" in */) HOME=${HOME%/} ;; *) break ;; esac; done
[ -n "$HOME" ] && [ -d "$HOME" ] || { echo "huntaway: HOME must be an existing folder other than /" >&2; exit 1; }

# Quote a value for the generated wrapper: single quotes, with any single quote written as '\''.
q() { printf "'%s'" "$(printf '%s' "$1" | LC_ALL=C sed "s/'/'\\\\''/g")"; }

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
node_bin=$(command -v node || true)
case "$node_bin" in /*) ;; *) echo "huntaway: node must be on PATH as an absolute path" >&2; exit 1 ;; esac
case "$node_bin" in *"$nl"*|*\\*) echo "huntaway: the node path must not contain a newline or a backslash" >&2; exit 1 ;; esac
if ! "$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  echo "huntaway: Node 22.18 or later is required" >&2; exit 1
fi
rev=$(git -C "$here" rev-parse --short=12 HEAD 2>/dev/null) || { echo "huntaway: install from a git checkout" >&2; exit 1; }
# The copy is exactly HEAD, so uncommitted edits would silently be missing: refuse them unless asked.
changes=$(git -C "$here" status --porcelain --untracked-files=no 2>/dev/null) || { echo "huntaway: git status failed" >&2; exit 1; }
if [ -n "$changes" ]; then
  if [ "${HUNTAWAY_INSTALL_ALLOW_DIRTY:-}" != 1 ]; then
    echo "huntaway: commit your changes first (the installed copy is the last commit, $rev)" >&2; exit 1
  fi
  echo "huntaway: note: installing the last commit, $rev; your uncommitted changes are not included" >&2
fi

root="$HOME/.local/share/huntaway"
dest="$root/app/$rev"
wrapper="$HOME/.local/bin/huntaway"
# Never replace or follow something that isn't ours: no symbolic link anywhere on Huntaway's paths.
for p in "$HOME/.local" "$HOME/.local/share" "$root" "$root/app" "$HOME/.local/bin"; do
  if [ -L "$p" ]; then echo "huntaway: refusing: a symbolic link sits where Huntaway installs" >&2; exit 1; fi
done
# Ours only if line 2 has the form this script writes: "# huntaway <commit>, installed by scripts/install-local.sh".
ours() { [ -f "$1" ] && [ ! -L "$1" ] && case "$(sed -n 2p "$1")" in "# huntaway "*", $MARKER") true ;; *) false ;; esac; }
if [ -e "$wrapper" ] || [ -L "$wrapper" ]; then
  ours "$wrapper" || { echo "huntaway: refusing: ~/.local/bin/huntaway exists and was not installed by this script" >&2; exit 1; }
fi
if [ -L "$dest" ]; then echo "huntaway: refusing: the install folder is a symbolic link" >&2; exit 1; fi

mkdir -p "$root/app" "$HOME/.local/bin"
chmod 700 "$root"
tmp="" tmpw="" fleet_checked=0
cleanup() {
  [ -z "$tmp" ] || { chmod -R u+w "$tmp" 2>/dev/null || true; rm -rf "$tmp" "$tmp.tar"; }
  [ -z "$tmpw" ] || rm -f "$tmpw"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
complete() { [ -f "$1/bin/huntaway.ts" ] && [ -f "$1/package.json" ] && [ -d "$1/src" ]; }
# The product's own reader of the fleet's names decides whether they are usable, run on the very code being installed:
# the installer never writes names that every `huntaway status` would refuse (a malformed pair, a repeat, none at all).
# It runs that code as the command itself will (same node, same environment), so it crosses no new trust boundary.
# The `--` keeps a list that starts with '-' from being read as an option of node's.
fleet_names_ok() {
  [ -n "$fleet_aliases" ] || return 0
  "$node_bin" --experimental-strip-types --disable-warning=ExperimentalWarning --input-type=module -e '
import { pathToFileURL } from "node:url";
const { fleetAliases } = await import(pathToFileURL(process.argv[1]).href);
const machines = fleetAliases(process.argv[2]);
process.exit(machines !== null && machines.length > 0 ? 0 : 3);' -- "$1/src/status/snapshot.ts" "$fleet_aliases" && r=0 || r=$?
  case "$r" in
    0) ;;
    3) echo "huntaway: --fleet-aliases takes nodeid=Name pairs separated by commas: node ids in lower-case letters, digits and '-'; each Name a valid alias; none repeated" >&2; exit 2 ;;
    *) echo "huntaway: could not check the fleet names" >&2; exit 1 ;;
  esac
}
# Atomic rename(2) through node: it never moves anything INTO an existing folder (unlike mv).
rename_into() { "$node_bin" -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$1" "$2" 2>/dev/null; }
older_than_an_hour() { [ -n "$(find "$1" -maxdepth 0 -mmin +60 2>/dev/null)" ]; }

# Leftovers of an install killed outright (kill -9, power loss) over an hour ago, under exactly the names this script
# uses. A stale copy folder is first renamed away (only one process can win that rename), so a slow install that
# wakes up finds its folder gone and fails plainly, instead of having it deleted while it moves it into place.
for d in "$root/app"/.install.??????; do
  [ -d "$d" ] && [ ! -L "$d" ] && older_than_an_hour "$d" || continue
  grave="$root/app/.stale.$$.${d##*/}"
  if rename_into "$d" "$grave"; then chmod -R u+w "$grave" 2>/dev/null || true; rm -rf "$grave"; fi
done
for f in "$root/app"/.install.??????.tar; do
  if [ -f "$f" ] && [ ! -L "$f" ] && older_than_an_hour "$f"; then rm -f "$f"; fi
done
# A renamed-away folder whose deletion was itself cut short: only this sweep ever makes these.
for d in "$root/app"/.stale.*; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then { chmod -R u+w "$d" && rm -rf "$d"; } 2>/dev/null || true; fi
done
# In the shared ~/.local/bin, only a temp command of ours: empty (killed before writing) or with our line 2.
for f in "$HOME/.local/bin"/.huntaway.??????; do
  [ -f "$f" ] && [ ! -L "$f" ] && older_than_an_hour "$f" || continue
  if [ ! -s "$f" ] || ours "$f"; then rm -f "$f"; fi
done

if [ ! -d "$dest" ]; then
  tmp=$(mktemp -d "$root/app/.install.XXXXXX")
  # Exactly the committed files (as exported by git; no export-ignore attributes are used here). The archive is its
  # own step so a git failure stops the install instead of feeding tar an empty stream.
  git -C "$here" archive -o "$tmp.tar" HEAD bin src contract package.json
  tar -x -f "$tmp.tar" -C "$tmp"
  rm -f "$tmp.tar"
  # The copy holds regular files and folders only: a committed symbolic link could point anywhere. Checked before
  # anything reads the copy, and a failing check refuses rather than passes.
  links=$(find "$tmp" -type l -print) || { echo "huntaway: could not check the code copy" >&2; exit 1; }
  [ -z "$links" ] || { echo "huntaway: refusing: the code copy contains a symbolic link" >&2; exit 1; }
  complete "$tmp" || { echo "huntaway: the code copy is incomplete" >&2; exit 1; }
  fleet_names_ok "$tmp"
  fleet_checked=1
  chmod -R a-w "$tmp"
  chmod u+w "$tmp"
  if rename_into "$tmp" "$dest"; then
    chmod a-w "$dest"
    tmp=""
  elif [ -d "$dest" ] && [ ! -L "$dest" ] && complete "$dest"; then
    : # another install of the same commit won the race; use its copy (cleanup removes ours)
  else
    echo "huntaway: could not place the code copy" >&2; exit 1
  fi
fi

complete "$dest" || { echo "huntaway: the installed copy for $rev is incomplete; remove it and run the installer again" >&2; exit 1; }
[ "$fleet_checked" = 1 ] || fleet_names_ok "$dest"

tmpw=$(mktemp "$HOME/.local/bin/.huntaway.XXXXXX")
# printf, never echo: some shells' echo turns backslash sequences in a path into quotes or control characters.
{
  printf '%s\n' '#!/bin/sh'
  printf '%s\n' "# huntaway $rev, $MARKER"
  [ -z "$alias_name" ] || printf '%s\n' ": \"\${HUNTAWAY_ALIAS:=$alias_name}\"; export HUNTAWAY_ALIAS"
  if [ "$standalone" = 1 ]; then
    printf '%s\n' ': "${HUNTAWAY_FLEET_CMD:=none}"; export HUNTAWAY_FLEET_CMD'
    printf '%s\n' ': "${HUNTAWAY_ENGINE:=anthropic}"; export HUNTAWAY_ENGINE'
  fi
  if [ "$router" = 1 ]; then
    printf '%s\n' ': "${HUNTAWAY_ENGINE:=pipe}"; export HUNTAWAY_ENGINE'
    # The Router's fleet helper, at its standard place: named here explicitly, since nothing runs it by default.
    printf '%s\n' "[ -n \"\${HUNTAWAY_FLEET_CMD-}\" ] || HUNTAWAY_FLEET_CMD=$(q "$HOME/.local/bin/compute-router-subscriptions"); export HUNTAWAY_FLEET_CMD"
    # Written as a quoted word, like the helper path: nothing in it is ever expanded by the shell.
    printf '%s\n' "[ -n \"\${HUNTAWAY_FLEET_ALIASES-}\" ] || HUNTAWAY_FLEET_ALIASES=$(q "$fleet_aliases"); export HUNTAWAY_FLEET_ALIASES"
  fi
  printf '%s\n' "exec $(q "$node_bin") --experimental-strip-types --disable-warning=ExperimentalWarning $(q "$dest/bin/huntaway.ts") \"\$@\""
} > "$tmpw"
chmod 755 "$tmpw"
rename_into "$tmpw" "$wrapper" || { echo "huntaway: could not place ~/.local/bin/huntaway" >&2; exit 1; }
tmpw=""
echo "huntaway $rev installed: ~/.local/bin/huntaway"
case "$node_bin" in "$HOME"/*) shown_node="~/${node_bin#"$HOME"/}" ;; *) shown_node=$node_bin ;; esac
printf '%s\n' "it runs with the node at $shown_node; run this installer again if you change Node versions"
case ":${PATH:-}:" in *":$HOME/.local/bin:"*) ;; *) echo "note: add ~/.local/bin to your PATH to run \`huntaway\`" ;; esac
