#!/bin/bash
# Double-click in Finder (macOS) to start a local server + open the prototype.
# Closes the terminal window when you Ctrl+C the server.

cd "$(dirname "$0")"
PORT=8765

# Free the port if a previous run is still bound.
if lsof -i ":$PORT" >/dev/null 2>&1; then
  echo "Port $PORT is in use. Stopping the existing process..."
  lsof -t -i ":$PORT" | xargs kill 2>/dev/null
  sleep 0.5
fi

echo "Starting prototype at http://localhost:$PORT/"
echo "Press Ctrl+C to stop."
echo ""

# Open the browser after the server has a moment to bind.
( sleep 0.7 && open "http://localhost:$PORT/" ) &

python3 -m http.server $PORT
