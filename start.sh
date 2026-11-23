#!/usr/bin/env sh
# Mac / Linux launcher. Usage: ./start.sh   (add --lan to reach it from your phone)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org and run this again."
  exit 1
fi
if [ ! -f .dev.vars ]; then
  echo "The file .dev.vars is missing. Copy .dev.vars.example to .dev.vars and paste your API keys into it."
  exit 1
fi
exec node server.mjs --open "$@"
