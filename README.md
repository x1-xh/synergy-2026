# synergy 2026

## stack

- python / fastapi / uv
- nextjs / bun

## run

### backend

```sh
cd backend
uv sync
uv run uvicorn main:app --reload --port 8000
```

### frontend

in another terminal:

```sh
cd frontend
bun install
bun dev
```

open http://localhost:3000
