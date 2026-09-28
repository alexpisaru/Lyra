"""HTTP surface of Lyra Voice, mounted on the Lyra API app (same auth/origin guard).

POST /api/voice/transcribe  raw audio/* body + X-Lyra-* id headers -> JSON text
POST /api/voice/speak       JSON {ids..., text}                  -> audio/wav

Both answer only the request that asked: this is how a spoken reply reaches the
originating device and no other. Bodies are non-simple content types (audio/*,
application/json), so a cross-site page cannot post them without a preflight.
"""

from __future__ import annotations

import asyncio

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from openjarvis.voice.providers import VoiceInputError, VoiceProviderError
from openjarvis.voice.service import VoiceIds, VoiceService

CLIENT_HEADER = "X-Lyra-Client-Id"
SESSION_HEADER = "X-Lyra-Voice-Session-Id"
TURN_HEADER = "X-Lyra-Voice-Turn-Id"
ID_HEADERS = (CLIENT_HEADER, SESSION_HEADER, TURN_HEADER)


class SpeakRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_id: str
    voice_session_id: str
    voice_turn_id: str
    text: str = Field(min_length=1, max_length=4000)


def install_voice_routes(app: FastAPI, guard, json_only) -> None:
    def _service() -> VoiceService:
        service = getattr(app.state, "voice", None)
        if service is None:
            raise HTTPException(503, "Lyra Voice is not enabled on this server")
        if service.load_error:
            raise HTTPException(503, f"Lyra Voice unavailable: {service.load_error}")
        return service

    def _ids(client_id, session_id, turn_id) -> VoiceIds:
        try:
            return VoiceIds.parse(client_id, session_id, turn_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    async def _read_limited(request: Request, limit: int) -> bytes:
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            raise HTTPException(413, "Utterance audio too large")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > limit:
                raise HTTPException(413, "Utterance audio too large")
        return bytes(body)

    @app.post("/api/voice/transcribe", dependencies=[Depends(guard)])
    async def voice_transcribe(request: Request):
        media_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if not media_type.startswith("audio/"):
            raise HTTPException(415, "Content-Type must be audio/*")
        headers = request.headers
        ids = _ids(*(headers.get(name) for name in ID_HEADERS))
        service = _service()
        audio = await _read_limited(request, service.max_audio_bytes)
        if not audio:
            raise HTTPException(400, "Empty utterance")
        try:
            result = await asyncio.to_thread(service.transcribe, ids, audio, media_type)
        except VoiceInputError as exc:
            raise HTTPException(400, str(exc)) from exc
        except VoiceProviderError as exc:
            raise HTTPException(503, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(502, "Speech recognition failed") from exc
        finally:
            del audio  # nothing kept after the request
        return {
            **ids.as_dict(),
            "text": result.text,
            "language": result.language,
            "duration": round(result.duration, 2),
        }

    @app.post("/api/voice/speak", dependencies=[Depends(guard), Depends(json_only)])
    async def voice_speak(body: SpeakRequest):
        ids = _ids(body.client_id, body.voice_session_id, body.voice_turn_id)
        service = _service()
        text = " ".join(body.text.split())
        if not text:
            raise HTTPException(400, "Nothing to say")
        if len(text) > service.max_speech_chars:
            raise HTTPException(413, "Text chunk too long for one speech request")
        try:
            audio = await asyncio.to_thread(service.speak, ids, text)
        except VoiceProviderError as exc:
            raise HTTPException(503, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(502, "Speech synthesis failed") from exc
        return Response(
            audio.data,
            media_type=audio.media_type,
            headers={
                "Cache-Control": "no-store",
                CLIENT_HEADER: ids.client_id,
                SESSION_HEADER: ids.voice_session_id,
                TURN_HEADER: ids.voice_turn_id,
            },
        )
