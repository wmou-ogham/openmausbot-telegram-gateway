"""Long-running local Whisper for the Telegram gateway.

One JSON object per line on stdin and stdout. The model stays loaded so a
second voice note does not pay the load cost again. large-v3 with no forced
language is the setting for Chinese-English technical speech.
"""

import json
import os
import sys

from faster_whisper import WhisperModel

CACHE = os.environ.get("OMB_STT_CACHE") or os.path.join(
    os.environ.get("OMB_DATA_DIR", os.path.expanduser("~/.openmausbot")),
    "stt",
    "cache",
)
os.environ["HF_HOME"] = CACHE
os.makedirs(CACHE, exist_ok=True)

MODEL_NAME = os.environ.get("OMB_STT_MODEL", "large-v3")
DEVICE = os.environ.get("OMB_STT_DEVICE", "cpu")
COMPUTE = os.environ.get("OMB_STT_COMPUTE", "int8")


def cpu_threads():
    """faster-whisper defaults to 4 CPU threads. Use the rest of this machine."""
    raw = os.environ.get("OMB_STT_CPU_THREADS", "").strip()
    if raw:
        return max(1, int(raw))
    count = os.cpu_count() or 4
    return max(1, count - 2)
PROMPT = os.environ.get(
    "OMB_STT_PROMPT",
    "中文與 English 夾雜的技術對話，保留 API、timeout、path、token、函式名稱。",
)


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    threads = cpu_threads()
    model = WhisperModel(
        MODEL_NAME,
        device=DEVICE,
        compute_type=COMPUTE,
        cpu_threads=threads,
        download_root=CACHE,
    )
    emit({
        "ready": True,
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute": COMPUTE,
        "cpu_threads": threads,
    })
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = {}
        try:
            job = json.loads(line)
            segments, _info = model.transcribe(
                job["path"],
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=False,
                language=None,
                initial_prompt=PROMPT,
                without_timestamps=True,
            )
            text = "".join(segment.text for segment in segments).strip()
            emit({"id": job.get("id"), "text": text})
        except Exception as error:  # noqa: BLE001 - report any file/model failure to the gateway
            emit({"id": job.get("id"), "error": str(error)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        emit({"error": str(error)})
        sys.exit(1)
