"""ElevenLabs & external Connector voice ingestion for Lemo-Opuscar:
    python src/server/tts_elevenlabs.py <lines.json> <out_dir> [--voice Adam] [--model eleven_multilingual_v2] [--api-key ...]

Supports two seamless modes for each line in lines.json:
1. Connector / Pre-generated Audio: If a line has "audio_base64" (data URI or raw base64)
   or "audio_url" (https:// or http:// URL returned by an ElevenLabs MCP connector),
   it decodes/downloads and converts it directly to 24 kHz mono WAV.
2. Direct ElevenLabs Text-to-Speech API: Otherwise, synthesizes using ElevenLabs
   /v1/text-to-speech/<voice_id> (using --api-key or ELEVENLABS_API_KEY env var).

Writes out_dir/<id>.wav (24 kHz mono, silence-trimmed) and out_dir/dur.json.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Optional, Tuple

import numpy as np
import soundfile as sf

SR = 24000

PREMADE_VOICES = {
    'rachel': '21m00Tcm4TlvDq8ikWAM',
    'adam': 'pNInz6obpgDQGcFmaJgB',
    'antoni': 'ErXwobaYiN019PkySvjV',
    'josh': 'TxGEqnHWrfWFTfGW9XjX',
    'arnold': 'VR6AewLTigWG4xSOukaG',
    'bella': 'EXAVITQu4vr4xnSDxMaL',
    'domi': 'AZnzlk1XvdvUeBnXmlld',
    'elli': 'MF3mGyEYCl7XYWbV9V6O',
    'george': 'JBFqnCBsd6RMkjVDRZzb',
    'brian': 'nPczCjzI2devNBz1zQrb',
    'sarah': 'EXAVITQu4vr4xnSDxMaL',
    'charlie': 'IKne3meq5aSn9XLyUdCD',
    'daniel': 'onwK4e9ZLuTAKqWW03F9',
    'lily': 'pFZP5JQG7iQjIQuC4Bku',
    'matilda': 'XrExE9yKIg1WjnnlVkGX',
    'river': 'SAz9YHcvj6GT2YYXdXww',
}
DEFAULT_VOICE_ID = PREMADE_VOICES['adam']


def fetch_account_voices(api_key: str) -> dict[str, str]:
    """Fetch user's ElevenLabs voice list (name -> voice_id) so custom/cloned names resolve."""
    req = urllib.request.Request(
        'https://api.elevenlabs.io/v1/voices',
        headers={'xi-api-key': api_key, 'Accept': 'application/json'},
        method='GET',
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
            mapping: dict[str, str] = {}
            for v in payload.get('voices', []):
                name = str(v.get('name', '')).strip().lower()
                vid = str(v.get('voice_id', '')).strip()
                if name and vid:
                    mapping[name] = vid
            return mapping
    except Exception:
        return {}


def resolve_voice_id(
    voice: Optional[str],
    api_key: str,
    account_cache: dict[str, str],
) -> str:
    if not voice or not voice.strip():
        return DEFAULT_VOICE_ID
    raw = voice.strip()
    lower = raw.lower()

    # Map Edge Neural voice strings automatically when switching engines
    if 'neural' in lower:
        return DEFAULT_VOICE_ID

    if lower in PREMADE_VOICES:
        return PREMADE_VOICES[lower]

    if re.fullmatch(r'[A-Za-z0-9]{18,}', raw):
        return raw

    if api_key and not account_cache:
        account_cache.update(fetch_account_voices(api_key))
    if lower in account_cache:
        return account_cache[lower]

    return DEFAULT_VOICE_ID


def decode_audio_bytes(raw_bytes: bytes) -> Optional[Tuple[np.ndarray, int]]:
    try:
        proc = subprocess.run(
            ['ffmpeg', '-y', '-loglevel', 'error', '-i', 'pipe:0', '-ar', str(SR), '-ac', '1', '-f', 'wav', '-'],
            input=raw_bytes,
            capture_output=True,
            check=True,
        )
    except FileNotFoundError:
        sys.exit('tts_elevenlabs.py: ffmpeg is required to decode audio.')
    except subprocess.CalledProcessError:
        return None
    try:
        audio, sr = sf.read(io.BytesIO(proc.stdout), dtype='float32')
    except Exception:
        return None
    return (audio, sr) if len(audio) > 0 else None


def decode_audio_file(file_path: str) -> Optional[Tuple[np.ndarray, int]]:
    if not os.path.exists(file_path):
        return None
    try:
        proc = subprocess.run(
            ['ffmpeg', '-y', '-loglevel', 'error', '-i', file_path, '-ar', str(SR), '-ac', '1', '-f', 'wav', '-'],
            capture_output=True,
            check=True,
        )
    except FileNotFoundError:
        sys.exit('tts_elevenlabs.py: ffmpeg is required to decode audio.')
    except subprocess.CalledProcessError:
        return None
    try:
        audio, sr = sf.read(io.BytesIO(proc.stdout), dtype='float32')
    except Exception:
        return None
    return (audio, sr) if len(audio) > 0 else None


def plausible(decoded: Optional[Tuple[np.ndarray, int]]) -> bool:
    if decoded is None:
        return False
    audio, sr = decoded
    return len(audio) >= 0.1 * sr and float(np.abs(audio).max()) > 1e-4


def download_url(url: str) -> bytes:
    if not (url.startswith('https://') or url.startswith('http://')):
        raise ValueError(f'Unsupported audio_url scheme (expected http/https): {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'FramerStudio/1.0'})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read()


def synthesize_elevenlabs(
    text: str,
    voice_id: str,
    model_id: str,
    api_key: str,
    stability: float,
    similarity_boost: float,
    cache_path: str,
) -> None:
    part = cache_path + '.part'
    url = f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128'
    body = json.dumps({
        'text': text,
        'model_id': model_id,
        'voice_settings': {
            'stability': stability,
            'similarity_boost': similarity_boost,
        },
    }).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            'xi-api-key': api_key,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        if not data:
            raise OSError('ElevenLabs API returned empty audio response')
        with open(part, 'wb') as f:
            f.write(data)
        os.replace(part, cache_path)
    finally:
        if os.path.exists(part):
            os.remove(part)


def trim_silence(y: np.ndarray, sr: int) -> np.ndarray:
    nz = np.where(np.abs(y) > (np.abs(y).max() if len(y) else 0) * 0.02)[0]
    if len(nz):
        start = max(0, int(nz[0]) - int(0.03 * sr))
        end = int(nz[-1]) + int(0.10 * sr)
        return y[start:end]
    return y


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('lines', help='Path to lines.json')
    ap.add_argument('out_dir', help='Destination voices/ directory')
    ap.add_argument('--voice', default='Adam', help='Default ElevenLabs voice name or voice_id')
    ap.add_argument('--model', default='eleven_multilingual_v2', help='ElevenLabs model_id')
    ap.add_argument('--api-key', default='', help='ElevenLabs API key (falls back to ELEVENLABS_API_KEY env)')
    args = ap.parse_args()

    api_key = (args.api_key or os.environ.get('ELEVENLABS_API_KEY') or '').strip()
    with open(args.lines, encoding='utf-8') as f:
        lines = json.load(f)

    cache_dir = os.path.join(args.out_dir, '.cache')
    os.makedirs(cache_dir, exist_ok=True)
    dur: dict[str, float] = {}
    account_voices: dict[str, str] = {}

    for line in lines:
        line_id = str(line['id'])
        raw_b64 = line.get('audio_base64')
        raw_url = line.get('audio_url')
        decoded: Optional[Tuple[np.ndarray, int]] = None

        if isinstance(raw_b64, str) and raw_b64.strip():
            payload_b64 = raw_b64.strip()
            if ';base64,' in payload_b64:
                payload_b64 = payload_b64.split(';base64,', 1)[1]
            decoded = decode_audio_bytes(base64.b64decode(payload_b64))
            if decoded is None:
                sys.exit(f"tts_elevenlabs.py: failed to decode audio_base64 for line '{line_id}'")
        elif isinstance(raw_url, str) and raw_url.strip():
            try:
                audio_bytes = download_url(raw_url.strip())
            except Exception as err:
                sys.exit(f"tts_elevenlabs.py: failed to download audio_url for line '{line_id}': {err}")
            decoded = decode_audio_bytes(audio_bytes)
            if decoded is None:
                sys.exit(f"tts_elevenlabs.py: downloaded audio_url for line '{line_id}' could not be decoded by ffmpeg")
        else:
            if not api_key:
                sys.exit(
                    f"tts_elevenlabs.py: line '{line_id}' has no audio_url/audio_base64 and no ELEVENLABS_API_KEY was provided. "
                    "Either pass audio_url/audio_base64 from Claude's ElevenLabs Connector onto each line, or pass elevenlabs_api_key / set ELEVENLABS_API_KEY."
                )
            voice_id = resolve_voice_id(line.get('voice') or args.voice, api_key, account_voices)
            say = str(line.get('say') or line['text'])
            stability = float(line.get('stability', 0.5))
            similarity = float(line.get('similarity_boost', 0.75))
            cache_key = hashlib.sha1(
                json.dumps([voice_id, args.model, stability, similarity, say], ensure_ascii=False).encode('utf-8')
            ).hexdigest()[:16]
            mp3_path = os.path.join(cache_dir, f'{cache_key}.mp3')
            decoded = decode_audio_file(mp3_path)
            if not plausible(decoded):
                decoded = None
                if os.path.exists(mp3_path):
                    os.remove(mp3_path)
            if decoded is None:
                try:
                    synthesize_elevenlabs(say, voice_id, args.model, api_key, stability, similarity, mp3_path)
                except urllib.error.HTTPError as err:
                    detail = err.read().decode('utf-8', errors='replace')[:240]
                    sys.exit(f"tts_elevenlabs.py: ElevenLabs API HTTP {err.code} for line '{line_id}': {detail}")
                except Exception as err:
                    sys.exit(f"tts_elevenlabs.py: ElevenLabs request failed for line '{line_id}': {err}")
                decoded = decode_audio_file(mp3_path)
                if decoded is None:
                    sys.exit(f"tts_elevenlabs.py: ElevenLabs audio for line '{line_id}' could not be decoded by ffmpeg")

        y, sr = decoded
        y = trim_silence(y, sr)
        out_wav = os.path.join(args.out_dir, f'{line_id}.wav')
        sf.write(out_wav, y, sr)
        dur[line_id] = round(len(y) / sr, 3)
        print(line_id, dur[line_id], line.get('text', ''))

    with open(os.path.join(args.out_dir, 'dur.json'), 'w', encoding='utf-8') as f:
        json.dump(dur, f, indent=1)


if __name__ == '__main__':
    main()

