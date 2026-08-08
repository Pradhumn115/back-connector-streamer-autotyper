#!/usr/bin/env bash
# macOS double-click entry point.
#
# Finder can only launch .command files, and it runs them from an arbitrary
# working directory — so this just anchors itself next to the repo and hands
# off to install.sh, which does the real work on both macOS and Linux.
cd "$(dirname "$0")" || exit 1
chmod +x ./install.sh 2>/dev/null
./install.sh "$@"
status=$?
echo
if [ $status -ne 0 ]; then
  echo "Install exited with status $status."
fi
# Finder-launched Terminal windows close on exit and take the output with them,
# so hold the window open until the user has read it.
read -r -p "Press Return to close this window… " _
exit $status
