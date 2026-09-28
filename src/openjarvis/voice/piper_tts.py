"""TextToSpeechProvider on Piper (ONNX, CPU).

Chosen for fast local Italian speech on CPU: a "medium" Italian voice is about
60 MB and synthesizes much faster than real time, so a short sentence is ready
in a fraction of a second. Output is a WAV built in memory.
"""

from __future__ import annotations

import io
import threading
import wave
from pathlib import Path

from openjarvis.voice.providers import SpeechAudio, VoiceProviderError


class PiperTTS:
    name = "piper"

    def __init__(self, voice_path: str):
        self.voice_path = voice_path
        self._voice = None
        self._load_lock = threading.Lock()
        self._run_lock = threading.Lock()

    def load(self) -> None:
        with self._load_lock:
            if self._voice is not None:
                return
            try:
                from piper import PiperVoice
            except ImportError as exc:
                raise VoiceProviderError("piper-tts is not installed (pip install '.[voice]')") from exc
            path = Path(self.voice_path)
            if not path.is_file() or not path.with_name(path.name + ".json").is_file():
                raise VoiceProviderError(
                    "Piper voice not found: voice.tts_voice needs the .onnx and its .onnx.json"
                )
            try:
                self._voice = PiperVoice.load(str(path))
            except Exception as exc:
                raise VoiceProviderError("Piper voice could not be loaded") from exc

    def synthesize(self, text: str) -> SpeechAudio:
        self.load()
        buffer = io.BytesIO()
        with self._run_lock, wave.open(buffer, "wb") as wav:
            # piper-tts >= 1.3 names it synthesize_wav; 1.2 wrote WAV from synthesize.
            write = getattr(self._voice, "synthesize_wav", None) or self._voice.synthesize
            write(text, wav)
        return SpeechAudio(buffer.getvalue(), "audio/wav")
