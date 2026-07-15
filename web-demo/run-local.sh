#!/bin/bash
# Serve the web demo locally (ES modules need http, not file://) and open it.
cd "$(dirname "$0")"
PORT=${1:-8090}
( sleep 1; open "http://localhost:$PORT" ) &
python3 -m http.server "$PORT"
