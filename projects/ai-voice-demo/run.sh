#!/bin/bash
# Cross-platform runner: starts a local server on :8765 and opens the browser.

cd "$(dirname "$0")"
PORT=8765

# Stop any previous server on the same port (best effort).
if command -v lsof >/dev/null 2>&1; then
  lsof -t -i ":$PORT" 2>/dev/null | xargs -r kill 2>/dev/null
  sleep 0.3
fi

echo "Starting prototype at http://localhost:$PORT/"
echo "Press Ctrl+C to stop."
echo ""

# Open the browser after the server has a moment to bind.
open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"
  elif command -v start >/dev/null 2>&1; then start "$1"
  fi
}
( sleep 0.7 && open_url "http://localhost:$PORT/" ) &

python3 -m http.server $PORT 2>/dev/null || python -m http.server $PORT
