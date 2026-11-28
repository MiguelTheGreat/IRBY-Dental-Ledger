#!/usr/bin/env sh
# Creates ocr-model/.venv and installs the OCR model's Python packages (RapidOCR, OpenCV,
# Keras / TensorFlow). IRBY Dental Ledger starts this interpreter automatically afterwards.
#
#   sh ocr-model/setup-ocr.sh            # or: PYTHON=/usr/bin/python3.11 sh ocr-model/setup-ocr.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
fi
[ -n "$PY" ] || { echo "Python 3.10 - 3.12 not found" >&2; exit 1; }
echo "Creating $VENV with $PY"
"$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$HERE/requirements.txt"
echo "Checking the model loads..."
"$VENV/bin/python" "$HERE/infer.py" --health
echo "Done. Start IRBY Dental Ledger normally; it launches the OCR server from $VENV/bin/python."
