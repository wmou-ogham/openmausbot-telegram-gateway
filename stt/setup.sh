#!/bin/sh
# Local large-v3 Whisper for the Telegram gateway. The cache stays under ~/.openmausbot/stt.
set -eu
ROOT="${OMB_DATA_DIR:-$HOME/.openmausbot}/stt"
python3 -m venv "$ROOT/venv"
"$ROOT/venv/bin/pip" install -U pip
"$ROOT/venv/bin/pip" install 'faster-whisper==1.2.1' 'av>=14,<16'
echo "STT venv: $ROOT/venv"
echo "The large-v3 weights download on the first transcription."
