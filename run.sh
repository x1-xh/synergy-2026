#!/usr/bin/env bash
set -e

echo "starting backend..."
cd backend
uv run uvicorn main:app --reload --port 8000 &
backend_pid=$!
cd ..

sleep 1

echo "starting frontend..."
cd frontend
bun dev &
frontend_pid=$!
cd ..

echo ""
echo "backend: http://localhost:8000/up"
echo "frontend: http://localhost:3000"
echo ""
echo "press ctrl+c to stop."

trap "kill $backend_pid $frontend_pid 2>/dev/null; exit" sigint sigterm
wait
