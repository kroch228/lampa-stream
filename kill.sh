#!/bin/sh
# Force-kill any hung Lampa-Stream / Electron instance.
# Use this if the app freezes and won't close normally.
#
# Electron spawns child processes (GPU, utility, network) that don't always die
# with the main process — so we match broadly and kill the whole group.

# Main + any with the debug port
pkill -9 -f "lampa-stream/node_modules/electron" 2>/dev/null
pkill -9 -f "remote-debugging-port=9223" 2>/dev/null
# Any lingering electron binary invoked from this project dir
ps -ef 2>/dev/null \
  | grep -E "lampa-stream/(node_modules/electron/dist/electron|launch\.sh)" \
  | grep -v grep | grep -v kill.sh \
  | awk '{print $2}' \
  | while read p; do kill -9 "$p" 2>/dev/null; done

echo "Lampa-Stream остановлен."
sleep 0.5
# Confirm
if pgrep -f "lampa-stream/node_modules/electron" >/dev/null 2>&1; then
  echo "⚠ некоторые процессы ещё живы — проверьте: ps aux | grep lampa-stream"
else
  echo "✓ все процессы очищены."
fi
