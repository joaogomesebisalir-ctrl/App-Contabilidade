#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP_WORKER=0 .venv/bin/flask --app run backup
