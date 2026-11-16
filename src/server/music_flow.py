#!/usr/bin/env python3
"""Music & Audio Flow Analyzer for Framer + Lemo-Opuscar MCP.

Turns any audio or video track into:
1. A structured Music Flow JSON (BPM, beat grid, downbeats, 3-band energy curve,
   silences, hit cues, energy sections, motion guidance, and ready-to-use timeline.js).
2. A visual Music Flow PNG (Waveform + 3-Band Spectrogram Strip + Beat/Section Timeline)
   so vision-capable AI models like Claude Web can literally "see" the music flow.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw
from scipy.signal import butter, find_peaks, sosfilt

SR = 48000
HOP_SEC = 0.02  # 50 Hz frame rate for envelope
HOP_SAMPLES = int(SR * HOP_SEC)


def _find_ffmpeg() -> str:
    env_ff = os.environ.get("FFMPEG_BIN")
    if env_ff and os.path.isfile(env_ff):
        return env_ff
    script_dir = Path(__file__).resolve().parent
    lemo_ff = script_dir.parent.parent / "lemo-opuscar" / ".bin" / "ffmpeg"
    if lemo_ff.is_file():
        return str(lemo_ff)
    which_ff = shutil.which("ffmpeg")
    if which_ff:
        return which_ff
    raise RuntimeError("ffmpeg executable not found")


def _load_audio_mono_stereo(input_path: Path) -> tuple[np.ndarray, np.ndarray, float]:
    """Load audio as mono float32 and stereo (N, 2) float32 @ 48 kHz."""
    ext = input_path.suffix.lower()
    samples: np.ndarray | None = None
    sr: int = SR

    if ext in {".wav", ".flac", ".ogg"}:
        try:
            data, file_sr = sf.read(str(input_path), dtype="float32", always_2d=True)
            if file_sr == SR:
                samples = data
                sr = file_sr
        except Exception:
            samples = None

    if samples is None:
        ffmpeg_bin = _find_ffmpeg()
        cmd = [
            ffmpeg_bin,
            "-v",
            "error",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "2",
            "-ar",
            str(SR),
            "-f",
            "f32le",
            "pipe:1",
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False)
        if proc.returncode != 0 or len(proc.stdout) == 0:
            err = proc.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(
                f"No readable audio stream found in {input_path.name}"
                + (f": {err}" if err else "")
            )
        raw = np.frombuffer(proc.stdout, dtype=np.float32)
        n_frames = len(raw) // 2
        if n_frames == 0:
            raise RuntimeError(f"Decoded audio is empty for {input_path.name}")
        samples = raw[: n_frames * 2].reshape(n_frames, 2)
        sr = SR

    if samples.shape[1] == 1:
        stereo = np.repeat(samples, 2, axis=1)
    else:
        stereo = samples[:, :2]
    mono = 0.5 * (stereo[:, 0] + stereo[:, 1])
    duration_sec = float(len(mono)) / float(sr)
    return mono.astype(np.float32), stereo.astype(np.float32), duration_sec


def _bandpass(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    sos = butter(order, [lo, hi], btype="bandpass", fs=SR, output="sos")
    return sosfilt(sos, x)


def _frame_rms_and_peaks(
    signal: np.ndarray, hop: int = HOP_SAMPLES
) -> tuple[np.ndarray, np.ndarray]:
    n_frames = max(1, int(math.ceil(len(signal) / hop)))
    padded_len = n_frames * hop
    if len(signal) < padded_len:
        padded = np.pad(signal, (0, padded_len - len(signal)))
    else:
        padded = signal[:padded_len]
    blocks = padded.reshape(n_frames, hop)
    rms = np.sqrt(np.mean(blocks * blocks, axis=1) + 1e-12)
    peaks = np.max(np.abs(blocks), axis=1)
    return rms, peaks


def _smooth(arr: np.ndarray, win: int = 5) -> np.ndarray:
    if len(arr) < win or win <= 1:
        return arr
    kernel = np.ones(win, dtype=np.float64) / float(win)
    return np.convolve(arr, kernel, mode="same")


def _estimate_bpm_and_beats(
    onset_env: np.ndarray, duration_sec: float
) -> tuple[float, list[float], list[float]]:
    if duration_sec < 1.5 or np.max(onset_env) < 1e-6:
        bpm = 120.0
        beat_step = 60.0 / bpm
        beats = [round(t, 3) for t in np.arange(0.0, duration_sec, beat_step)]
        downbeats = beats[::4]
        return bpm, beats, downbeats

    # Autocorrelation on mean-centered onset envelope between 72 and 176 BPM
    centered = onset_env - np.mean(onset_env)
    acf = np.correlate(centered, centered, mode="full")
    acf = acf[len(acf) // 2 :]

    min_lag = max(1, int(round((60.0 / 176.0) / HOP_SEC)))
    max_lag = min(len(acf) - 1, int(round((60.0 / 72.0) / HOP_SEC)))
    if max_lag <= min_lag:
        bpm = 120.0
    else:
        lags = np.arange(min_lag, max_lag + 1)
        scores = acf[lags].astype(np.float64)
        # Mild perceptual tempo prior favoring 95–140 BPM to avoid half/double-time errors
        bpms_for_lags = 60.0 / (lags * HOP_SEC)
        prior = np.exp(-0.5 * ((bpms_for_lags - 118.0) / 34.0) ** 2)
        weighted = np.maximum(scores, 0.0) * (0.65 + 0.35 * prior)
        best_idx = int(np.argmax(weighted))
        raw_bpm = float(bpms_for_lags[best_idx])
        nearest_int = round(raw_bpm)
        bpm = float(nearest_int) if abs(raw_bpm - nearest_int) < 1.1 else round(raw_bpm, 1)

    beat_period = 60.0 / bpm
    period_frames = max(1, int(round(beat_period / HOP_SEC)))

    # Align beat phase to maximize onset energy on beat grid
    best_phase = 0
    best_score = -1.0
    for phase in range(period_frames):
        idxs = np.arange(phase, len(onset_env), period_frames)
        score = float(np.sum(onset_env[idxs]))
        if score > best_score:
            best_score = score
            best_phase = phase

    t0 = best_phase * HOP_SEC
    beats: list[float] = []
    t = t0
    while t < duration_sec - 0.01:
        beats.append(round(float(t), 3))
        t += beat_period
    downbeats = beats[::4]
    return bpm, beats, downbeats


def _detect_silences(rms_db: np.ndarray, duration_sec: float) -> list[list[float]]:
    if len(rms_db) == 0:
        return []
    peak_db = float(np.max(rms_db))
    if peak_db < -60.0:
        return [[0.0, round(duration_sec, 2)]]

    thresh_db = max(-52.0, min(-34.0, peak_db - 28.0))
    is_silent = rms_db < thresh_db

    # Close brief non-silent blips < 0.10s and bridge brief gaps
    raw_regions: list[list[float]] = []
    start_idx: int | None = None
    for i, silent in enumerate(is_silent):
        if silent and start_idx is None:
            start_idx = i
        elif not silent and start_idx is not None:
            t0 = start_idx * HOP_SEC
            t1 = i * HOP_SEC
            if t1 - t0 >= 0.25:
                raw_regions.append([round(t0, 2), round(t1, 2)])
            start_idx = None
    if start_idx is not None:
        t0 = start_idx * HOP_SEC
        t1 = duration_sec
        if t1 - t0 >= 0.25:
            raw_regions.append([round(t0, 2), round(t1, 2)])

    merged: list[list[float]] = []
    for reg in raw_regions:
        if merged and reg[0] - merged[-1][1] <= 0.12:
            merged[-1][1] = reg[1]
        else:
            merged.append(reg)
    return merged


def _detect_cues(
    onset_norm: np.ndarray,
    bass_rms: np.ndarray,
    mid_rms: np.ndarray,
    high_rms: np.ndarray,
    duration_sec: float,
) -> list[dict[str, Any]]:
    if len(onset_norm) < 4 or np.max(onset_norm) < 0.05:
        return []

    min_dist = max(1, int(round(0.55 / HOP_SEC)))
    peaks, props = find_peaks(onset_norm, distance=min_dist, prominence=0.14)
    if len(peaks) == 0:
        return []

    proms = props.get("prominences", onset_norm[peaks])
    ranked = sorted(zip(peaks, proms), key=lambda pair: float(pair[1]), reverse=True)[:16]
    ranked.sort(key=lambda pair: int(pair[0]))

    cues: list[dict[str, Any]] = []
    b_scale = max(float(np.percentile(bass_rms, 90)), 1e-6)
    m_scale = max(float(np.percentile(mid_rms, 90)), 1e-6)
    h_scale = max(float(np.percentile(high_rms, 90)), 1e-6)

    for idx, prom in ranked:
        t = round(float(idx * HOP_SEC), 2)
        if t > duration_sec:
            continue
        hi = min(len(bass_rms), idx + 4)
        lo = max(0, idx - 3)
        pre_lo = max(0, idx - 8)
        b_jump = max(0.0, float(np.max(bass_rms[lo:hi]) - np.min(bass_rms[pre_lo:lo + 1]))) / b_scale
        m_jump = max(0.0, float(np.max(mid_rms[lo:hi]) - np.min(mid_rms[pre_lo:lo + 1]))) / m_scale
        h_jump = max(0.0, float(np.max(high_rms[lo:hi]) - np.min(high_rms[pre_lo:lo + 1]))) / h_scale

        if b_jump >= m_jump and b_jump >= h_jump:
            dominant = "bass"
            label = "bass_drop" if b_jump > 0.35 else "low_impact"
        elif h_jump > b_jump * 1.15 and h_jump > m_jump * 1.15:
            dominant = "high"
            label = "bright_accent"
        else:
            dominant = "mid"
            label = "impact_hit" if onset_norm[idx] > 0.55 else "phrase_entry"

        cues.append(
            {
                "t": t,
                "strength": round(float(min(1.0, onset_norm[idx])), 3),
                "prominence": round(float(prom), 3),
                "dominantBand": dominant,
                "label": label,
            }
        )
    return cues


def _guidance_for_level(level: str, is_first: bool, is_last: bool) -> str:
    if level == "silence":
        return "Silence / tension breath — freeze motion, clear screen, or hold pause before next hit."
    if is_first and level in {"low", "medium"}:
        return "Hook opening — establish subject quickly in first 2-3s, align title entrance to first beats."
    if is_last and level in {"low", "medium"}:
        return "Outro / resolve — slow camera settle, hold CTA / brand card cleanly for reading."
    if level == "peak":
        return "Peak climax — bold hero reveal, dynamic camera push/zoom, and crisp visual slams on downbeats."
    if level == "high":
        return "High energy — rhythmic cuts every 2-4 beats, kinetic typography, and reactive visual pulses."
    if level == "medium":
        return "Steady build — progressive reveals, tracked camera motion, and beat-synced transitions."
    return "Low energy — spacious framing, subtle motion, let voiceover or ambience breathe."


def _segment_sections(
    rms_db: np.ndarray,
    bass_rms: np.ndarray,
    mid_rms: np.ndarray,
    high_rms: np.ndarray,
    silences: list[list[float]],
    bpm: float,
    duration_sec: float,
) -> list[dict[str, Any]]:
    if duration_sec <= 0.0:
        return []

    # Quantile-based energy tiers over non-silent frames
    non_silent = rms_db[rms_db > -52.0]
    if len(non_silent) < 5:
        return [
            {
                "id": "bed_1",
                "t0": 0.0,
                "t1": round(duration_sec, 2),
                "bpm": bpm,
                "avgRmsDb": round(float(np.mean(rms_db)), 1),
                "bassEnergyRatio": 0.33,
                "energyLevel": "silence",
                "motionGuidance": _guidance_for_level("silence", True, True),
            }
        ]

    q25, q55, q82 = np.percentile(non_silent, [25, 55, 82])

    # Build grid boundaries: 0, silence boundaries, and ~4s macro windows
    win_sec = max(2.5, min(6.0, duration_sec / 6.0))
    cuts = {0.0, round(duration_sec, 2)}
    for s0, s1 in silences:
        cuts.add(round(s0, 2))
        cuts.add(round(s1, 2))

    # Add macro cuts between silences
    t = win_sec
    while t < duration_sec - 1.5:
        near_silence = any(abs(t - s) < 1.2 for pair in silences for s in pair)
        if not near_silence:
            cuts.add(round(t, 2))
        t += win_sec

    sorted_cuts = sorted(c for c in cuts if 0.0 <= c <= round(duration_sec, 2))
    raw_secs: list[dict[str, Any]] = []
    for a, b in zip(sorted_cuts[:-1], sorted_cuts[1:]):
        if b - a < 0.2:
            continue
        i0 = max(0, int(round(a / HOP_SEC)))
        i1 = min(len(rms_db), max(i0 + 1, int(round(b / HOP_SEC))))
        avg_db = float(np.mean(rms_db[i0:i1]))
        b_sum = float(np.sum(bass_rms[i0:i1]))
        m_sum = float(np.sum(mid_rms[i0:i1]))
        h_sum = float(np.sum(high_rms[i0:i1]))
        tot_band = max(1e-9, b_sum + m_sum + h_sum)

        is_sil = any(abs(a - s0) < 0.08 and abs(b - s1) < 0.08 for s0, s1 in silences)
        if is_sil or avg_db < -48.0:
            level = "silence"
        elif avg_db >= q82:
            level = "peak"
        elif avg_db >= q55:
            level = "high"
        elif avg_db >= q25:
            level = "medium"
        else:
            level = "low"

        raw_secs.append(
            {
                "t0": round(a, 2),
                "t1": round(b, 2),
                "avgRmsDb": round(avg_db, 1),
                "bassEnergyRatio": round(b_sum / tot_band, 2),
                "energyLevel": level,
            }
        )

    # Merge adjacent non-silence sections that share the same energyLevel
    merged: list[dict[str, Any]] = []
    for sec in raw_secs:
        if (
            merged
            and merged[-1]["energyLevel"] == sec["energyLevel"]
            and sec["energyLevel"] != "silence"
            and (sec["t1"] - merged[-1]["t0"]) <= max(8.0, duration_sec * 0.35)
        ):
            prev = merged[-1]
            d1 = prev["t1"] - prev["t0"]
            d2 = sec["t1"] - sec["t0"]
            prev["t1"] = sec["t1"]
            prev["avgRmsDb"] = round((prev["avgRmsDb"] * d1 + sec["avgRmsDb"] * d2) / (d1 + d2), 1)
            prev["bassEnergyRatio"] = round(
                (prev["bassEnergyRatio"] * d1 + sec["bassEnergyRatio"] * d2) / (d1 + d2), 2
            )
        else:
            merged.append(sec)

    sections: list[dict[str, Any]] = []
    for idx, sec in enumerate(merged):
        is_first = idx == 0
        is_last = idx == len(merged) - 1
        lvl = sec["energyLevel"]
        if lvl == "silence":
            sec_id = f"silence_{idx + 1}"
        elif is_first:
            sec_id = "hook"
        elif is_last:
            sec_id = "outro"
        elif lvl == "peak":
            sec_id = f"peak_{idx + 1}"
        elif lvl == "high":
            sec_id = f"drive_{idx + 1}"
        else:
            sec_id = f"build_{idx + 1}"

        sections.append(
            {
                "id": sec_id,
                "t0": sec["t0"],
                "t1": sec["t1"],
                "bpm": bpm,
                "avgRmsDb": sec["avgRmsDb"],
                "bassEnergyRatio": sec["bassEnergyRatio"],
                "energyLevel": lvl,
                "motionGuidance": _guidance_for_level(lvl, is_first, is_last),
            }
        )
    return sections


def _build_timeline_js(
    duration_sec: float,
    bpm: float,
    sections: list[dict[str, Any]],
    cues: list[dict[str, Any]],
    source_name: str,
) -> str:
    beat = round(60.0 / bpm, 4)
    bar = round(beat * 4.0, 4)
    lines = [
        f"// Auto-generated music flow timeline from {source_name} ({bpm} BPM · {duration_sec:.2f} s).",
        f"export const DUR = {duration_sec:.2f};",
        f"export const BPM = {bpm};",
        f"export const BEAT = {beat};",
        f"export const BAR = {bar};",
        "",
        "export const SECS = [",
    ]
    for sec in sections:
        lines.append(
            f"  {{ id: '{sec['id']}', t0: {sec['t0']:.2f}, t1: {sec['t1']:.2f}, "
            f"bpm: {sec['bpm']}, energy: '{sec['energyLevel']}' }},"
        )
    lines.append("];")
    lines.append("")
    lines.append("export const CUES = {")
    used_names: dict[str, int] = {}
    for cue in cues:
        base = cue["label"]
        count = used_names.get(base, 0) + 1
        used_names[base] = count
        key = f"{base}_{count}"
        lines.append(f"  {key}: {cue['t']:.2f}, // {cue['dominantBand']} (strength {cue['strength']})")
    lines.append("};")
    return "\n".join(lines) + "\n"


def _render_flow_png(
    out_png: Path,
    source_name: str,
    duration_sec: float,
    bpm: float,
    peaks: np.ndarray,
    rms_db: np.ndarray,
    bass_rms: np.ndarray,
    mid_rms: np.ndarray,
    high_rms: np.ndarray,
    beats: list[float],
    downbeats: list[float],
    silences: list[list[float]],
    cues: list[dict[str, Any]],
    sections: list[dict[str, Any]],
) -> None:
    W, H = 1600, 560
    MARGIN_L = 56
    MARGIN_R = 24
    PLOT_W = W - MARGIN_L - MARGIN_R

    img = Image.new("RGB", (W, H), (11, 13, 19))
    draw = ImageDraw.Draw(img, "RGBA")

    def tx(t: float) -> int:
        if duration_sec <= 0:
            return MARGIN_L
        return int(MARGIN_L + max(0.0, min(1.0, t / duration_sec)) * PLOT_W)

    # Header bar
    draw.rectangle([0, 0, W, 48], fill=(18, 22, 33))
    draw.line([0, 48, W, 48], fill=(39, 46, 66), width=1)
    header = (
        f"MUSIC FLOW MAP  |  {source_name}  |  "
        f"{duration_sec:.2f}s  |  {bpm} BPM  |  "
        f"{len(sections)} sections · {len(cues)} cues · {len(silences)} silences"
    )
    draw.text((20, 16), header, fill=(238, 241, 248))

    # Lane geometry
    L1_TOP, L1_BOT = 64, 210     # Waveform + RMS + Silence
    L2_TOP, L2_BOT = 230, 356    # 3-Band Frequency Flow
    L3_TOP, L3_BOT = 376, 514    # Beat Grid + Cues + Sections

    for top, bot, title in [
        (L1_TOP, L1_BOT, "WAVEFORM & LOUDNESS (dBFS)"),
        (L2_TOP, L2_BOT, "FREQUENCY ENERGY: BASS (Amber) · MID (Green) · HIGH (Cyan)"),
        (L3_TOP, L3_BOT, "BEAT GRID · CUES · FLOW SECTIONS"),
    ]:
        draw.rectangle([MARGIN_L, top, W - MARGIN_R, bot], fill=(16, 20, 30), outline=(39, 46, 66))
        draw.text((MARGIN_L + 8, top - 15), title, fill=(154, 164, 188))

    # Shaded silence regions across lanes 1 & 2
    for s0, s1 in silences:
        x0, x1 = tx(s0), tx(s1)
        if x1 <= x0:
            x1 = x0 + 2
        draw.rectangle([x0, L1_TOP + 1, x1, L1_BOT - 1], fill=(244, 63, 94, 42))
        draw.rectangle([x0, L2_TOP + 1, x1, L2_BOT - 1], fill=(244, 63, 94, 32))
        draw.text((x0 + 4, L1_TOP + 6), "SILENCE", fill=(253, 164, 175))

    # Lane 1: Waveform & RMS curve
    n_cols = PLOT_W
    n_frames = len(peaks)
    mid_y = (L1_TOP + L1_BOT) // 2
    half_h = (L1_BOT - L1_TOP) // 2 - 8
    peak_max = max(float(np.max(peaks)), 1e-4)

    rms_pts: list[tuple[int, int]] = []
    for px in range(n_cols):
        f0 = int(px * n_frames / n_cols)
        f1 = max(f0 + 1, int((px + 1) * n_frames / n_cols))
        p_val = float(np.max(peaks[f0:min(n_frames, f1)])) / peak_max
        bar_h = max(1, int(p_val * half_h))
        x = MARGIN_L + px
        draw.line([x, mid_y - bar_h, x, mid_y + bar_h], fill=(96, 165, 250, 145), width=1)

        db_val = float(np.mean(rms_db[f0:min(n_frames, f1)]))
        norm_db = max(0.0, min(1.0, (db_val + 56.0) / 52.0))
        ry = int(L1_BOT - 6 - norm_db * (L1_BOT - L1_TOP - 14))
        rms_pts.append((x, ry))

    if len(rms_pts) > 1:
        draw.line(rms_pts, fill=(245, 158, 11, 235), width=2)

    draw.text((8, L1_TOP + 4), "0dB", fill=(111, 122, 148))
    draw.text((8, mid_y - 6), "-24", fill=(111, 122, 148))
    draw.text((8, L1_BOT - 16), "-56", fill=(111, 122, 148))

    # Lane 2: 3-Band Spectrogram Strip (Bass, Mid, High)
    b_ref = max(float(np.percentile(bass_rms, 98)), 1e-5)
    m_ref = max(float(np.percentile(mid_rms, 98)), 1e-5)
    h_ref = max(float(np.percentile(high_rms, 98)), 1e-5)
    band_h = (L2_BOT - L2_TOP - 12) // 3
    y_bass = L2_TOP + 4
    y_mid = y_bass + band_h + 2
    y_high = y_mid + band_h + 2

    for px in range(n_cols):
        f0 = int(px * n_frames / n_cols)
        f1 = max(f0 + 1, int((px + 1) * n_frames / n_cols))
        b_v = min(1.0, float(np.mean(bass_rms[f0:min(n_frames, f1)])) / b_ref)
        m_v = min(1.0, float(np.mean(mid_rms[f0:min(n_frames, f1)])) / m_ref)
        h_v = min(1.0, float(np.mean(high_rms[f0:min(n_frames, f1)])) / h_ref)
        x = MARGIN_L + px
        bh = max(1, int(b_v * (band_h - 2)))
        mh = max(1, int(m_v * (band_h - 2)))
        hh = max(1, int(h_v * (band_h - 2)))
        draw.line([x, y_bass + band_h - bh, x, y_bass + band_h], fill=(245, 158, 11, int(80 + 175 * b_v)))
        draw.line([x, y_mid + band_h - mh, x, y_mid + band_h], fill=(16, 185, 129, int(80 + 175 * m_v)))
        draw.line([x, y_high + band_h - hh, x, y_high + band_h], fill=(56, 189, 248, int(80 + 175 * h_v)))

    draw.text((8, y_bass + band_h // 2 - 6), "BASS", fill=(245, 158, 11))
    draw.text((8, y_mid + band_h // 2 - 6), "MID", fill=(16, 185, 129))
    draw.text((8, y_high + band_h // 2 - 6), "HIGH", fill=(56, 189, 248))

    # Lane 3: Sections, Beat Grid & Cues
    sec_colors = {
        "silence": (127, 29, 29, 130),
        "low": (30, 58, 138, 110),
        "medium": (6, 95, 70, 125),
        "high": (180, 83, 9, 135),
        "peak": (190, 24, 93, 145),
    }
    sec_top = L3_BOT - 44
    for sec in sections:
        x0, x1 = tx(sec["t0"]), tx(sec["t1"])
        if x1 - x0 < 2:
            continue
        col = sec_colors.get(sec["energyLevel"], (45, 55, 72, 120))
        draw.rectangle([x0 + 1, sec_top, x1 - 1, L3_BOT - 4], fill=col, outline=(148, 163, 184, 100))
        if x1 - x0 > 55:
            lbl = f"{sec['id']} ({sec['energyLevel']})"
            draw.text((x0 + 6, sec_top + 6), lbl, fill=(241, 245, 249))
            draw.text((x0 + 6, sec_top + 22), f"{sec['t0']:.1f}-{sec['t1']:.1f}s", fill=(203, 213, 225))

    downbeat_set = set(downbeats)
    for bt in beats:
        x = tx(bt)
        is_db = bt in downbeat_set
        line_col = (251, 191, 36, 150) if is_db else (148, 163, 184, 55)
        y_end = sec_top - 2
        draw.line([x, L3_TOP + 2, x, y_end], fill=line_col, width=2 if is_db else 1)

    for idx, cue in enumerate(cues):
        x = tx(cue["t"])
        draw.line([x, L1_TOP + 1, x, sec_top - 2], fill=(248, 113, 113, 110), width=1)
        y_pin = L3_TOP + 8 + (idx % 4) * 18
        draw.polygon([(x - 5, y_pin - 4), (x + 5, y_pin - 4), (x, y_pin + 4)], fill=(248, 113, 113))
        short_lbl = cue["label"].replace("_", " ")
        text_x = min(x + 6, W - MARGIN_R - 115)
        draw.text((text_x, y_pin - 6), f"{cue['t']:.1f}s {short_lbl}", fill=(254, 202, 202))

    # Time ruler along bottom
    step = 1.0 if duration_sec <= 16 else (2.0 if duration_sec <= 36 else 5.0)
    t_mark = 0.0
    while t_mark <= duration_sec + 1e-6:
        x = tx(t_mark)
        draw.line([x, L3_BOT, x, L3_BOT + 6], fill=(148, 163, 184))
        draw.text((max(MARGIN_L, x - 10), L3_BOT + 10), f"{t_mark:.0f}s", fill=(154, 164, 188))
        t_mark += step

    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(out_png), format="PNG", optimize=True)


def analyze_music_flow(
    input_path: Path,
    out_json: Path | None = None,
    out_png: Path | None = None,
) -> dict[str, Any]:
    mono, stereo, duration_sec = _load_audio_mono_stereo(input_path)
    bass_sig = _bandpass(mono, 20.0, 160.0)
    mid_sig = _bandpass(mono, 160.0, 2500.0)
    high_sig = _bandpass(mono, 2500.0, 16000.0)

    rms, peaks = _frame_rms_and_peaks(mono)
    bass_rms, _ = _frame_rms_and_peaks(bass_sig)
    mid_rms, _ = _frame_rms_and_peaks(mid_sig)
    high_rms, _ = _frame_rms_and_peaks(high_sig)

    rms_db = 20.0 * np.log10(np.maximum(rms, 1e-6))

    # Multi-band positive spectral flux onset envelope
    log_b = np.log1p(bass_rms * 25.0)
    log_m = np.log1p(mid_rms * 25.0)
    log_h = np.log1p(high_rms * 25.0)
    flux = np.zeros_like(rms)
    if len(rms) > 1:
        diff_b = np.maximum(0.0, np.diff(log_b))
        diff_m = np.maximum(0.0, np.diff(log_m))
        diff_h = np.maximum(0.0, np.diff(log_h))
        flux[1:] = diff_b * 1.25 + diff_m * 1.0 + diff_h * 0.75
    flux_smooth = _smooth(flux, 3)
    flux_max = float(np.max(flux_smooth))
    onset_norm = flux_smooth / flux_max if flux_max > 1e-8 else flux_smooth

    bpm, beats, downbeats = _estimate_bpm_and_beats(onset_norm, duration_sec)
    silences = _detect_silences(rms_db, duration_sec)
    cues = _detect_cues(onset_norm, bass_rms, mid_rms, high_rms, duration_sec)
    sections = _segment_sections(
        rms_db, bass_rms, mid_rms, high_rms, silences, bpm, duration_sec
    )
    timeline_js = _build_timeline_js(duration_sec, bpm, sections, cues, input_path.name)

    # Compact ~20 Hz envelope curve for UI / JSON inspection
    step = max(1, int(round(len(rms_db) / min(300, max(30, int(duration_sec * 10))))))
    curve = []
    b_max = max(float(np.max(bass_rms)), 1e-6)
    m_max = max(float(np.max(mid_rms)), 1e-6)
    h_max = max(float(np.max(high_rms)), 1e-6)
    for i in range(0, len(rms_db), step):
        curve.append(
            {
                "t": round(float(i * HOP_SEC), 2),
                "rmsDb": round(float(rms_db[i]), 1),
                "bass": round(float(bass_rms[i] / b_max), 3),
                "mid": round(float(mid_rms[i] / m_max), 3),
                "high": round(float(high_rms[i] / h_max), 3),
                "onset": round(float(onset_norm[i]), 3),
            }
        )

    summary: dict[str, Any] = {
        "sourceName": input_path.name,
        "durationSec": round(duration_sec, 3),
        "sampleRate": SR,
        "channels": int(stereo.shape[1]),
        "bpm": bpm,
        "beatIntervalSec": round(60.0 / bpm, 4),
        "beats": beats,
        "downbeats": downbeats,
        "silences": silences,
        "cues": cues,
        "sections": sections,
        "energyCurve": curve,
        "timelineJs": timeline_js,
    }

    if out_png is not None:
        _render_flow_png(
            out_png=out_png,
            source_name=input_path.name,
            duration_sec=duration_sec,
            bpm=bpm,
            peaks=peaks,
            rms_db=rms_db,
            bass_rms=bass_rms,
            mid_rms=mid_rms,
            high_rms=high_rms,
            beats=beats,
            downbeats=downbeats,
            silences=silences,
            cues=cues,
            sections=sections,
        )
        summary["flowImagePath"] = str(out_png)

    if out_json is not None:
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze audio/video music flow")
    parser.add_argument("input", help="Path to audio or video file")
    parser.add_argument("--out-json", dest="out_json", help="Output JSON path")
    parser.add_argument("--out-png", dest="out_png", help="Output spectrogram PNG path")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    if not input_path.is_file():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        return 2

    out_json = Path(args.out_json).resolve() if args.out_json else None
    out_png = Path(args.out_png).resolve() if args.out_png else None

    try:
        summary = analyze_music_flow(input_path, out_json=out_json, out_png=out_png)
    except Exception as exc:
        print(f"music_flow error: {exc}", file=sys.stderr)
        return 1

    if out_json is None:
        print(json.dumps(summary, indent=2))
    else:
        print(
            json.dumps(
                {
                    "ok": True,
                    "sourceName": summary["sourceName"],
                    "durationSec": summary["durationSec"],
                    "bpm": summary["bpm"],
                    "sections": len(summary["sections"]),
                    "cues": len(summary["cues"]),
                    "outJson": str(out_json),
                    "outPng": str(out_png) if out_png else None,
                }
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
