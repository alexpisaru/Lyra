"""SpeechToTextProvider on faster-whisper (CTranslate2, CPU int8).

Chosen for local Italian recognition on CPU: Whisper "small" is the smallest
size with solid Italian, and int8 keeps it around 0.5 GB of RAM. Audio is
decoded in memory by PyAV (bundled with faster-whisper, no system ffmpeg), so
webm/opus and mp4/aac from MediaRecorder both work. Nothing touches the disk.
"""

from __future__ import annotations

import io
import threading
from pathlib import Path

from openjarvis.voice.providers import (
    Transcription,
    VoiceInputError,
    VoiceProviderError,
)

# Whisper's well-known hallucinations on silence/noise (mostly subtitle credits).
_HALLUCINATIONS = (
    "sottotitoli",
    "amara.org",
    "grazie per la visione",
    "iscriviti al canale",
    "thanks for watching",
)


def _is_hallucination(text: str) -> bool:
    low = text.lower()
    return any(marker in low for marker in _HALLUCINATIONS)


class FasterWhisperSTT:
    name = "faster-whisper"

    def __init__(
        self,
        model: str = "small",
        *,
        compute_type: str = "int8",
        threads: int = 0,
        language: str = "it",
        beam_size: int = 1,
        vad_filter: bool = True,
        models_dir: str = "",
        allow_download: bool = False,
        max_seconds: float = 30.0,
    ):
        self.model_name = model
        self.compute_type = compute_type
        self.threads = threads
        # Always explicit (Lyra's voice language): Whisper never auto-detects here.
        self.language = language
        self.beam_size = beam_size
        self.vad_filter = vad_filter
        self.models_dir = models_dir or None
        self.allow_download = allow_download
        self.max_seconds = max_seconds
        self._model = None
        self._load_lock = threading.Lock()
        # One utterance at a time: the model is CPU-bound, parallel runs only slow both.
        self._run_lock = threading.Lock()

    def load(self) -> None:
        with self._load_lock:
            if self._model is not None:
                return
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:
                raise VoiceProviderError(
                    "faster-whisper is not installed (pip install '.[voice]')"
                ) from exc
            try:
                self._model = WhisperModel(
                    self.model_name,
                    device="cpu",
                    compute_type=self.compute_type,
                    cpu_threads=self.threads,
                    download_root=self.models_dir,
                    local_files_only=not self.allow_download
                    and not Path(self.model_name).is_absolute(),
                )
            except Exception as exc:
                raise VoiceProviderError(
                    f"Speech model {self.model_name!r} is not available locally"
                    " (see docs/VOICE.md for the download step)"
                ) from exc

    def transcribe(self, audio: bytes, media_type: str) -> Transcription:
        self.load()
        from faster_whisper.audio import decode_audio

        try:
            samples = decode_audio(io.BytesIO(audio), sampling_rate=16000)
        except Exception as exc:
            raise VoiceInputError("Audio could not be decoded") from exc
        duration = len(samples) / 16000
        if duration > self.max_seconds:
            raise VoiceInputError("Utterance too long")
        if duration < 0.2:
            return Transcription("", self.language, duration)
        with self._run_lock:
            segments, info = self._model.transcribe(
                samples,
                language=self.language,
                beam_size=self.beam_size,
                condition_on_previous_text=False,
                vad_filter=self.vad_filter,  # trims silence the client VAD kept around the speech
                without_timestamps=True,
            )
            parts = [
                s.text.strip()
                for s in segments
                if s.no_speech_prob < 0.6 and s.text.strip() and not _is_hallucination(s.text)
            ]
        text = " ".join(parts).strip()
        return Transcription(text, getattr(info, "language", self.language), duration)
