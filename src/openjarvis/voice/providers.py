"""Narrow provider interfaces for Lyra Voice.

Lyra Voice is a transport: speech in, text through the normal chat path, speech
out. Providers only turn audio into text and text into audio; they know nothing
about Lyra Core, conversations or clients.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class VoiceProviderError(RuntimeError):
    """A provider could not load or process a request (message is safe to show)."""


class VoiceInputError(ValueError):
    """The uploaded audio itself is unusable (undecodable, too long...)."""


@dataclass(frozen=True)
class Transcription:
    text: str
    language: str | None = None
    duration: float = 0.0  # seconds of audio


@dataclass(frozen=True)
class SpeechAudio:
    data: bytes
    media_type: str = "audio/wav"


class SpeechToTextProvider(Protocol):
    name: str

    def load(self) -> None:
        """Load the model (idempotent, may be slow). Raise VoiceProviderError."""

    def transcribe(self, audio: bytes, media_type: str) -> Transcription:
        """Transcribe one complete utterance. Raw audio is never stored."""


class TextToSpeechProvider(Protocol):
    name: str

    def load(self) -> None:
        """Load the voice (idempotent, may be slow). Raise VoiceProviderError."""

    def synthesize(self, text: str) -> SpeechAudio:
        """Speak one short chunk of text."""
