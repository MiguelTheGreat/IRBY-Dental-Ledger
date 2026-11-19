"""
One-shot command-line entry point for OCR_PROVIDER=command.

    python ocr-model/infer.py path/to/scan.jpg   -> prints one JSON object to stdout
    python ocr-model/infer.py --health           -> {"ready": ..., "detail": ...}

In the web app's .env:
    OCR_PROVIDER=command
    OCR_COMMAND=python ocr-model/infer.py {image}

Note: the model is loaded for every scan. If loading is slow (> a few seconds),
use server.py with OCR_PROVIDER=http instead so the model stays in memory.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model  # noqa: E402


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: infer.py <image path> | --health"}))
        return 2
    model.load()
    if sys.argv[1] == "--health":
        ok, detail = model.ready()
        print(json.dumps({"ready": ok, "detail": detail}))
        return 0
    with open(sys.argv[1], "rb") as fh:
        result = model.predict(fh.read())
    if not isinstance(result, dict):
        result = {"text": str(result)}
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
