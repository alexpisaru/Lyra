"""Lyra Voice HTTP surface with fake STT/TTS providers (no models, no audio stack)."""

import logging
from pathlib import Path
import threading
from unittest.mock import MagicMock

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from openjarvis.api import create_app  # noqa: E402
from openjarvis.core.config import JarvisConfig, VoiceConfig  # noqa: E402
from openjarvis.system.builder import SystemBuilder  # noqa: E402
from openjarvis.voice import (  # noqa: E402
    SpeechAudio,
    Transcription,
    VoiceIds,
    VoiceInputError,
    VoiceProviderError,
    VoiceService,
)

KEY = "k" * 24
IDS = {
    "client_id": "client-aaaaaaaa",
    "voice_session_id": "session-11111111",
    "voice_turn_id": "turn-00000001",
}
HEADERS = {
    "X-Lyra-Client-Id": IDS["client_id"],
    "X-Lyra-Voice-Session-Id": IDS["voice_session_id"],
    "X-Lyra-Voice-Turn-Id": IDS["voice_turn_id"],
}


class FakeSTT:
    name = "fake-stt"

    def __init__(self, text="ciao Lyra", error=None):
        self.text = text
        self.error = error
        self.seen = []

    def load(self):
        pass

    def transcribe(self, audio, media_type):
        self.seen.append((len(audio), media_type))
        if self.error:
            raise self.error
        return Transcription(self.text, "it", 1.5)


class FakeTTS:
    name = "fake-tts"

    def __init__(self, error=None):
        self.error = error
        self.spoken = []

    def load(self):
        if isinstance(self.error, VoiceProviderError):
            raise self.error

    def synthesize(self, text):
        self.spoken.append(text)
        if self.error:
            raise self.error
        return SpeechAudio(b"RIFF....WAVEfake", "audio/wav")


@pytest.fixture
def voice_app(tmp_path):
    opened = []

    def factory(stt=None, tts=None, *, service=True, **api):
        cfg = JarvisConfig()
        cfg.tools.workspace = str(tmp_path / "workspace")
        cfg.memory.db_path = str(tmp_path / "state" / "memory.db")
        cfg.api.enabled = True
        for key, value in api.items():
            setattr(cfg.api, key, value)
        cfg.validate()
        system = SystemBuilder(cfg).build()
        system.engine.generate = MagicMock(return_value={"content": "ok"})
        health = MagicMock()
        health.health.return_value = True
        health.list_models.return_value = [cfg.intelligence.model]
        voice = None
        if service:
            voice = VoiceService(stt or FakeSTT(), tts or FakeTTS(), max_audio_bytes=50_000)
        client = TestClient(create_app(cfg, system=system, health_engine=health, voice=voice))
        client.__enter__()
        opened.append((client, system))
        return client, voice, system

    yield factory
    for client, system in opened:
        client.__exit__(None, None, None)
        system.close()


def transcribe(client, audio=b"\x1aE\xdf\xa3 fake webm", headers=HEADERS, ctype="audio/webm"):
    return client.post(
        "/api/voice/transcribe", content=audio, headers={**headers, "Content-Type": ctype}
    )


def test_status_reports_voice(voice_app):
    client, voice, _ = voice_app()
    body = client.get("/api/status").json()
    assert body["voice"] == {
        "enabled": True,
        "ready": True,
        "stt": "fake-stt",
        "tts": "fake-tts",
        "error": None,
    }
    client, _, _ = voice_app(service=False)
    assert client.get("/api/status").json()["voice"] == {"enabled": False}


def test_transcribe_returns_text_for_the_same_ids(voice_app):
    client, voice, _ = voice_app()
    response = transcribe(client, ctype="audio/mp4;codecs=mp4a.40.2")
    assert response.status_code == 200
    assert response.json() == {**IDS, "text": "ciao Lyra", "language": "it", "duration": 1.5}
    assert voice.stt.seen == [(len(b"\x1aE\xdf\xa3 fake webm"), "audio/mp4")]


def test_transcribe_does_not_touch_the_conversation_or_broadcast(voice_app):
    client, _, system = voice_app()
    emitted = []
    client.app.state.hub.emit = emitted.append
    assert transcribe(client).status_code == 200
    assert emitted == []  # no WebSocket fan-out of voice traffic
    assert client.app.state.history == []  # the chat path is the client's next step
    system.engine.generate.assert_not_called()


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {**HEADERS, "X-Lyra-Voice-Turn-Id": "short"},
        {**HEADERS, "X-Lyra-Client-Id": "bad id with spaces"},
    ],
)
def test_transcribe_requires_ids(voice_app, headers):
    client, _, _ = voice_app()
    assert transcribe(client, headers=headers).status_code == 400


@pytest.mark.parametrize("ctype", ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])
def test_transcribe_rejects_simple_cross_site_content_types(voice_app, ctype):
    client, voice, _ = voice_app()
    assert transcribe(client, ctype=ctype).status_code == 415
    assert voice.stt.seen == []


def test_transcribe_limits_and_empty_audio(voice_app):
    client, voice, _ = voice_app()
    assert transcribe(client, audio=b"x" * 50_001).status_code == 413
    assert transcribe(client, audio=b"").status_code == 400
    assert voice.stt.seen == []


def test_transcribe_failures_map_to_clean_errors(voice_app):
    client, _, _ = voice_app(stt=FakeSTT(error=VoiceInputError("Audio could not be decoded")))
    assert transcribe(client).status_code == 400
    client, _, _ = voice_app(stt=FakeSTT(error=RuntimeError("boom")))
    response = transcribe(client)
    assert response.status_code == 502 and "boom" not in response.text


def test_voice_disabled_or_unloadable_is_503(voice_app):
    client, _, _ = voice_app(service=False)
    assert transcribe(client).status_code == 503
    client, _, _ = voice_app(tts=FakeTTS(error=VoiceProviderError("Piper voice not found")))
    assert client.get("/api/status").json()["voice"]["error"] == "Piper voice not found"
    assert transcribe(client).status_code == 503
    speak = client.post("/api/voice/speak", json={**IDS, "text": "ciao"})
    assert speak.status_code == 503


def test_speak_returns_wav_only_to_the_requester_with_its_ids(voice_app):
    client, voice, _ = voice_app()
    emitted = []
    client.app.state.hub.emit = emitted.append
    response = client.post("/api/voice/speak", json={**IDS, "text": "  Ecco   fatto.  "})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-lyra-client-id"] == IDS["client_id"]
    assert response.headers["x-lyra-voice-session-id"] == IDS["voice_session_id"]
    assert response.headers["x-lyra-voice-turn-id"] == IDS["voice_turn_id"]
    assert response.content.startswith(b"RIFF")
    assert voice.tts.spoken == ["Ecco fatto."]
    assert emitted == []


def test_speak_validation(voice_app):
    client, voice, _ = voice_app()
    assert client.post("/api/voice/speak", json={**IDS, "text": "x" * 601}).status_code == 413
    assert client.post("/api/voice/speak", json={**IDS, "text": "   "}).status_code == 400
    bad = {**IDS, "voice_session_id": "nope", "text": "ciao"}
    assert client.post("/api/voice/speak", json=bad).status_code == 400
    extra = {**IDS, "text": "ciao", "broadcast": True}
    assert client.post("/api/voice/speak", json=extra).status_code == 422
    form = client.post("/api/voice/speak", content="text=ciao", headers={"Content-Type": "text/plain"})
    assert form.status_code == 415
    client, _, _ = voice_app(tts=FakeTTS(error=RuntimeError("boom")))
    assert client.post("/api/voice/speak", json={**IDS, "text": "ciao"}).status_code == 502
    assert voice.tts.spoken == []


def test_voice_routes_use_the_api_guard(voice_app):
    client, voice, _ = voice_app(api_key=KEY)
    assert transcribe(client).status_code == 401
    assert client.post("/api/voice/speak", json={**IDS, "text": "ciao"}).status_code == 401
    auth = {**HEADERS, "Authorization": f"Bearer {KEY}"}
    assert transcribe(client, headers=auth).status_code == 200
    evil = {**auth, "Origin": "https://evil.example"}
    assert transcribe(client, headers=evil).status_code == 403
    assert len(voice.stt.seen) == 1


def test_parallel_clients_get_their_own_answers(voice_app):
    """Two devices speaking at once: each response carries only its own ids."""
    client, _, _ = voice_app()
    results = {}

    def device(name):
        ids = {**HEADERS, "X-Lyra-Client-Id": f"client-{name * 8}"}
        results[name] = transcribe(client, headers=ids).json()["client_id"]

    threads = [threading.Thread(target=device, args=(n,)) for n in "ab"]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results == {"a": "client-aaaaaaaa", "b": "client-bbbbbbbb"}


def test_nothing_sensitive_is_logged(voice_app, caplog):
    client, _, _ = voice_app(stt=FakeSTT(text="il mio segreto"))
    with caplog.at_level(logging.DEBUG):
        transcribe(client, audio=b"RAWAUDIOBYTES")
        client.post("/api/voice/speak", json={**IDS, "text": "la mia risposta"})
    logged = caplog.text
    assert "segreto" not in logged and "risposta" not in logged and "RAWAUDIO" not in logged


def test_voice_ids_parse():
    assert VoiceIds.parse(*IDS.values()).as_dict() == IDS
    with pytest.raises(ValueError):
        VoiceIds.parse("a", None, "c")


def test_voice_config_validation(tmp_path):
    assert VoiceConfig().validate().enabled is False
    with pytest.raises(ValueError, match="tts_voice"):
        VoiceConfig(enabled=True).validate()
    with pytest.raises(ValueError, match="absolute"):
        VoiceConfig(tts_voice="voices/it.onnx").validate()
    with pytest.raises(ValueError, match="stt_provider"):
        VoiceConfig(stt_provider="cloud").validate()
    with pytest.raises(ValueError, match="limits"):
        VoiceConfig(max_audio_bytes=10).validate()
    cfg = VoiceConfig(enabled=True, tts_voice=str(tmp_path / "it_IT-paola-medium.onnx"))
    assert cfg.validate().enabled


def test_missing_voice_runtime_is_reported_not_crashing(tmp_path):
    """Without the [voice] extra the API still starts and reports why voice is off."""
    from openjarvis.voice.faster_whisper_stt import FasterWhisperSTT
    from openjarvis.voice.piper_tts import PiperTTS

    service = VoiceService(
        FasterWhisperSTT("small", models_dir=str(tmp_path)), PiperTTS(str(tmp_path / "none.onnx"))
    )
    service.warm()
    status = service.status()
    assert status["ready"] is False and status["error"]


def test_whisper_uses_configured_language_and_inference_params(monkeypatch):
    """Italian is always passed explicitly; beam_size/vad_filter come from config."""
    import sys
    import types

    calls = {}

    class FakeWhisperModel:
        def __init__(self, name, **kwargs):
            calls["init"] = (name, kwargs)

        def transcribe(self, samples, **kwargs):
            calls["transcribe"] = kwargs
            segment = types.SimpleNamespace(text=" Che ore sono? ", no_speech_prob=0.1)
            return iter([segment]), types.SimpleNamespace(language=kwargs["language"])

    package = types.ModuleType("faster_whisper")
    package.WhisperModel = FakeWhisperModel
    audio = types.ModuleType("faster_whisper.audio")
    audio.decode_audio = lambda _file, sampling_rate: [0.0] * (2 * sampling_rate)
    monkeypatch.setitem(sys.modules, "faster_whisper", package)
    monkeypatch.setitem(sys.modules, "faster_whisper.audio", audio)

    default = VoiceService.from_config(VoiceConfig(enabled=True, tts_voice=str(Path.cwd() / "v.onnx")))
    result = default.stt.transcribe(b"audio", "audio/webm")
    assert result.text == "Che ore sono?" and result.language == "it"
    assert calls["transcribe"]["language"] == "it"
    assert calls["transcribe"]["beam_size"] == 1 and calls["transcribe"]["vad_filter"] is True
    assert calls["init"][1]["local_files_only"] is True  # never downloads by default

    tuned = VoiceConfig(
        enabled=True, tts_voice=str(Path.cwd() / "v.onnx"), stt_beam_size=5, stt_vad_filter=False
    )
    VoiceService.from_config(tuned.validate()).stt.transcribe(b"audio", "audio/webm")
    assert calls["transcribe"]["beam_size"] == 5 and calls["transcribe"]["vad_filter"] is False
    assert calls["transcribe"]["language"] == "it"
    with pytest.raises(ValueError, match="limits"):
        VoiceConfig(stt_beam_size=0).validate()
