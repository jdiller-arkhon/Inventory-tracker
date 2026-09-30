#!/usr/bin/env sh
# Start the inventory tracker (macOS / Linux). Opens your browser automatically.
cd "$(dirname "$0")"
exec python3 app.py "$@"
