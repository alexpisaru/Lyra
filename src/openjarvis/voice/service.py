"""Lyra Voice service: STT and TTS for one client's voice turn.

Not a runtime and not a conversation: the client sends the transcript through
the same POST /api/chat as typed Chat, so Lyra Core, history and tools are
untouched. This layer only converts audio <-> text for the device that asked.

Routing: every request carries client_id / voice_session_id / voice_turn_id and
the answer goes back only in the HTTP response to that request. Nothing is
broadcast (no WebSocket fan-out), nothing is stored: audio lives in memory for
the duration of the request, and neither audio nor text is logged.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from dataclasses import dataclass

from openjarvis.voice.providers import (
    SpeechAudio,
    SpeechToTextProvider,
    TextToSpeechProvider,
    Transcription,
    VoiceProviderError,
)

log = logging.getLogger("lyra.voice")

_ID = re.compile(r"[A-Za-z0-9-]{8,64}")


@dataclass(frozen=True)
class VoiceIds:
    client_id: str
    voice_session_id: str
    voice_turn_id: str

    @classmethod
    def parse(cls, client_id, voice_session_id, voice_turn_id) -> VoiceIds:
        values = (client_id, voice_session_id, voice_turn_id)
        if not all(isinstance(v, str) and _ID.fullmatch(v) for v in values):
            raise ValueError("client_id, voice_session_id and voice_turn_id are required ids")
        return cls(*values)

    def as_dict(self) -> dict:
        return {
            "client_id": self.client_id,
            "voice_session_id": self.voice_session_id,
            "voice_turn_id": self.voice_turn_id,
        }


class VoiceService:
    def __init__(
        self,
        stt: SpeechToTextProvider | None,
        tts: TextToSpeechProvider | None,
        *,
        max_audio_bytes: int = 4_000_000,
        max_speech_chars: int = 600,
    ):
        self.stt = stt
        self.tts = tts
        self.max_audio_bytes = max_audio_bytes
        self.max_speech_chars = max_speech_chars
        self.load_error: str | None = None
        self._warm = threading.Event()

    @classmethod
    def from_config(cls, voice) -> VoiceService | None:
        if not voice.enabled:
            return None
        from openjarvis.voice.faster_whisper_stt import FasterWhisperSTT
        from openjarvis.voice.piper_tts import PiperTTS

        stt = FasterWhisperSTT(
            voice.stt_model,
            compute_type=voice.stt_compute_type,
            threads=voice.stt_threads,
            language=voice.stt_language,
            beam_size=voice.stt_beam_size,
            vad_filter=voice.stt_vad_filter,
            models_dir=voice.models_dir,
            allow_download=voice.allow_download,
            max_seconds=voice.max_audio_seconds,
        )
        return cls(
            stt,
            PiperTTS(voice.tts_voice),
            max_audio_bytes=voice.max_audio_bytes,
            max_speech_chars=voice.max_speech_chars,
        )

    @property
    def ready(self) -> bool:
        return self._warm.is_set() and self.load_error is None

    def warm(self) -> None:
        """Load both models ahead of the first turn. Failures are kept, not raised."""
        try:
            for provider in (self.stt, self.tts):
                if provider is not None:
                    provider.load()
            self.load_error = None
        except VoiceProviderError as exc:
            self.load_error = str(exc)
            log.warning("Lyra Voice unavailable: %s", exc)
        finally:
            self._warm.set()

    def status(self) -> dict:
        return {
            "enabled": True,
            "ready": self.ready,
            "stt": getattr(self.stt, "name", None),
            "tts": getattr(self.tts, "name", None),
            "error": self.load_error,
        }

    def transcribe(self, ids: VoiceIds, audio: bytes, media_type: str) -> Transcription:
        if self.stt is None:
            raise VoiceProviderError("Speech recognition is not configured")
        started = time.monotonic()
        result = self.stt.transcribe(audio, media_type)
        # Ids and timings only: never audio or transcript text.
        log.info(
            "voice turn %s/%s: %.1fs audio, stt %.2fs",
            ids.voice_session_id[:8],
            ids.voice_turn_id[:8],
            result.duration,
            time.monotonic() - started,
        )
        return result

    def speak(self, ids: VoiceIds, text: str) -> SpeechAudio:
        if self.tts is None:
            raise VoiceProviderError("Speech synthesis is not configured")
        started = time.monotonic()
        audio = self.tts.synthesize(text)
        log.info(
            "voice turn %s/%s: tts %d chars in %.2fs",
            ids.voice_session_id[:8],
            ids.voice_turn_id[:8],
            len(text),
            time.monotonic() - started,
        )
        return audio
