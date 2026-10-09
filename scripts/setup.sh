#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check -r requirements-dev.lock.txt
for executable in tesseract pdftoppm; do
  command -v "$executable" >/dev/null || { echo "Falta $executable. Instale tesseract-ocr e poppler-utils com o gestor de pacotes do sistema." >&2; exit 1; }
done
mkdir -p .tools/tessdata
if ! test -f .tools/tessdata/por.traineddata; then
  curl --fail --show-error --location --proto '=https' https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/por.traineddata -o .tools/tessdata/por.traineddata
fi
printf '%s\n' 'c4932b937207a9514b7514d518b931a99938c02a28a5a5a553f8599ed58b7deb  .tools/tessdata/por.traineddata' | sha256sum -c -
# Discover the installed language data without assuming a platform-specific path.
TESSDATA_DIRECTORY=$(tesseract --list-langs 2>&1 | sed -n 's/^List of available languages in "\([^"]*\)".*/\1/p')
for language in eng osd; do
  if ! test -f ".tools/tessdata/$language.traineddata"; then
    test -n "$TESSDATA_DIRECTORY"
    cp "$TESSDATA_DIRECTORY/$language.traineddata" ".tools/tessdata/$language.traineddata"
  fi
done
tesseract --list-langs --tessdata-dir .tools/tessdata
.venv/bin/python -m pip check
