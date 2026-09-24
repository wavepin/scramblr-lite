#!/bin/bash
set -euo pipefail
NODE_EXE=$(which node.exe)

BACKEND_PID=""
FRONTEND_PID=""
MODEL_PID=""

if [ -f backend/.env ]; then
  set -a
  # Strip CRLF if the file was edited on Windows.
  source <(sed 's/\r$//' backend/.env)
  set +a
fi

PYTHON_EXE=$(which python.exe)
MODEL_SERVICE_URL="${MODEL_SERVICE_URL:-http://127.0.0.1:8000}"
MODEL_SERVICE_ADDRESS="${MODEL_SERVICE_URL#*://}"
MODEL_SERVICE_ADDRESS="${MODEL_SERVICE_ADDRESS%%/*}"
MODEL_SERVICE_HOST="${MODEL_SERVICE_HOST:-${MODEL_SERVICE_ADDRESS%%:*}}"
if [[ "$MODEL_SERVICE_ADDRESS" == *:* ]]; then
  MODEL_SERVICE_PORT="${MODEL_SERVICE_PORT:-${MODEL_SERVICE_ADDRESS##*:}}"
else
  MODEL_SERVICE_PORT="${MODEL_SERVICE_PORT:-8000}"
fi
export MODEL_SERVICE_URL


cleanup() {
  trap - EXIT INT TERM
  for pid in "$MODEL_PID" "$BACKEND_PID" "$FRONTEND_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "$MODEL_PID" "$BACKEND_PID" "$FRONTEND_PID"; do
    if [ -n "$pid" ]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
  kill_port "$MODEL_SERVICE_PORT"
  kill_port 3001
  kill_port 5173
}

trap cleanup EXIT INT TERM

kill_port() {
  local port="$1"
  powershell.exe -NoProfile -Command "Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id \$_ -Force }" >/dev/null 2>&1 || true
}

(
  cd backend
  "$PYTHON_EXE" -m uvicorn src.model_service:app --host "$MODEL_SERVICE_HOST" --port "$MODEL_SERVICE_PORT"
) &
MODEL_PID=$!

(
  cd backend
  "$NODE_EXE" src/server.js
) &
BACKEND_PID=$!

(
  cd frontend
  "$NODE_EXE" ./node_modules/vite/bin/vite.js -- --strictPort
) &
FRONTEND_PID=$!

wait -n "$MODEL_PID" "$BACKEND_PID" "$FRONTEND_PID"
