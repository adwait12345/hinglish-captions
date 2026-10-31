#!/bin/bash
# Double-click to open the Hinglish caption maker in your browser.
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  PY=""
  for p in python3.13 python3.12 python3.11 python3.10; do
    if command -v "$p" >/dev/null; then PY="$p"; break; fi
  done
  if [ -z "$PY" ]; then
    echo "Python 3.10+ is needed. Install it with: brew install python"
    read -n 1 -s -r -p "Press any key to close"; exit 1
  fi
  "$PY" -m venv .venv && .venv/bin/pip install -r requirements.txt
fi
.venv/bin/python app.py
