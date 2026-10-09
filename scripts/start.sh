#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# One process owns the OCR worker. HTTP requests are served by four threads.
exec .venv/bin/gunicorn --workers 1 --threads 4 --timeout 120 --bind "${APP_HOST:-127.0.0.1}:${PORT:-8000}" run:app
