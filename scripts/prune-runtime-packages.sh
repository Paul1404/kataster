#!/bin/sh
# Run only while building the immutable runtime image, after apt installation.
set -eu
export LC_ALL=C
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get upgrade --yes --no-install-recommends
selected=
plan=$(mktemp)
trap 'rm -f "$plan"' EXIT

# Keep dpkg's dependency model intact. Some of these packages are Debian
# Essential because a general-purpose OS needs them; this app image does not.
# A simulated purge must remove only this explicit allowlist, never an app
# dependency, libc, coreutils, the shell, certificates or C++ runtime libraries.
allowed='apt libapt-pkg7.0 libapt-pkg6.0 curl minisign gnupg gnupg-utils gnupg-l10n gpg gpg-agent gpgconf gpgsm gpgv gpg-wks-client dirmngr perl-base ncurses-bin ncurses-base mount util-linux bsdutils login libudev1 liblastlog2-2 libsmartcols1 libmount1 libblkid1 libuuid1 libxrender1 libx11-6 libx11-data'
for candidate in $allowed; do
  status=$(dpkg-query -W -f='${db:Status-Status}' "$candidate" 2>/dev/null || true)
  [ "$status" = installed ] || continue
  if ! apt-get --simulate --allow-remove-essential purge $selected "$candidate" >"$plan" 2>&1; then
    echo "Retaining $candidate: required by retained packages"
    continue
  fi
  safe=true
  for removed in $(awk '$1 == "Purg" || $1 == "Remv" {sub(/:.*/, "", $2); print $2}' "$plan"); do
    case " $allowed " in
      *" $removed "*) ;;
      *) safe=false ;;
    esac
  done
  if [ "$safe" = true ]; then
    selected="$selected $candidate"
  else
    echo "Retaining $candidate: purge would remove a runtime dependency"
  fi
done

mkdir -p /usr/local/share
: >/usr/local/share/runtime-pruning.txt
if [ -n "$selected" ]; then
  dpkg-query -W -f='${binary:Package}\t${Version}\n' $selected > /usr/local/share/runtime-pruning.txt
  DEBIAN_FRONTEND=noninteractive apt-get purge --yes --allow-remove-essential $selected
fi
audit=$(dpkg --audit)
[ -z "$audit" ] || { echo "$audit"; exit 1; }
for required in /bin/sh /usr/bin/env /usr/bin/id /usr/bin/mkdir /usr/bin/rm; do
  test -x "$required"
done
for removed in $selected; do
  status=$(dpkg-query -W -f='${db:Status-Status}' "$removed" 2>/dev/null || true)
  [ "$status" != installed ] || exit 1
done
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
echo "Runtime package pruning complete:$(wc -l </usr/local/share/runtime-pruning.txt) packages removed"
