#!/usr/bin/env bash
set -euo pipefail

NODE_EXE=$(command -v node)
BACKEND_PID=
FRONTEND_PID=

kill_port() {
  local port="$1"
  local pids

  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
  fi
}

cleanup() {
  trap - EXIT INT TERM

  if [[ -n "$BACKEND_PID" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi

  if [[ -n "$FRONTEND_PID" ]]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi

  kill_port 3001
  kill_port 5173
}

trap cleanup EXIT INT TERM

kill_port 3001
kill_port 5173

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

while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  wait "$BACKEND_PID"
else
  wait "$FRONTEND_PID"
fi
