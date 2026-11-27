#!/usr/bin/env python3
"""
GMusic Offline Parallel Audio Quality Generator
- Parallel song processing with live per-song & overall Rich dashboard
- Real-time FFmpeg transcode progress + Drive download/upload progress
- CPU & Memory limit enforcement + FFmpeg thread capping
- Automatic resume after Ctrl+C via local SQLite state (and optional MongoDB sync)
- Full file logging (audio_processor.log) without cluttering the live UI
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload
import psutil
from rich.console import Group
from rich.live import Live
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskID,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)
from rich.table import Table

try:
    from pymongo import ASCENDING, MongoClient
except ImportError:
    MongoClient = None  # Optional if using local SQLite state only

SCOPES = [
    # The worker receives a folder ID directly instead of using Google Picker,
    # so Drive's per-file drive.file grant cannot authorize the existing Music
    # folder as a write destination.
    "https://www.googleapis.com/auth/drive",
]

QUALITY_PROFILES: Dict[str, Dict[str, Any]] = {
    "low": {"folder_name": "Low", "bitrate_kbps": 64, "ffmpeg_bitrate": "64k"},
    "medium": {"folder_name": "Medium", "bitrate_kbps": 128, "ffmpeg_bitrate": "128k"},
    "high": {"folder_name": "High", "bitrate_kbps": 256, "ffmpeg_bitrate": "256k"},
}

SUPPORTED_EXTENSIONS = {
    ".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma", ".aiff", ".alac"
}

CHUNK_SIZE = 8 * 1024 * 1024  # 8 MiB (multiple of 256 KiB)

STOP_EVENT = threading.Event()
ACTIVE_PROCS: set[subprocess.Popen] = set()
PROCS_LOCK = threading.Lock()


def setup_logging(log_file: str = "audio_processor.log", verbose: bool = False) -> logging.Logger:
    """Logs strictly to file so the live Rich terminal UI stays clean."""
    level = logging.DEBUG if verbose else logging.INFO
    logger = logging.getLogger("gmusic")
    logger.setLevel(level)
    logger.handlers.clear()

    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setLevel(level)
    fh.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] [%(threadName)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logger.addHandler(fh)
    logging.getLogger("googleapiclient.discovery").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    return logger


logger = logging.getLogger("gmusic")


def handle_interrupt(signum: int, frame: Any) -> None:
    if not STOP_EVENT.is_set():
        logger.warning("Interrupt (Ctrl+C) received. Stopping workers cleanly...")
        STOP_EVENT.set()
        with PROCS_LOCK:
            for p in list(ACTIVE_PROCS):
                try:
                    p.terminate()
                except Exception:
                    pass
    else:
        logger.error("Second interrupt received. Forcing exit.")
        os._exit(1)


signal.signal(signal.SIGINT, handle_interrupt)
if hasattr(signal, "SIGTERM"):
    signal.signal(signal.SIGTERM, handle_interrupt)


@dataclass
class Config:
    root_folder_id: str
    original_folder_id: str
    owner_id: str
    quality_folder_ids: Dict[str, Optional[str]]
    credentials_path: str
    token_path: str
    oauth_local_port: int
    sqlite_path: str
    mongodb_uri: Optional[str]
    mongodb_db_name: str
    max_workers: int
    ffmpeg_threads: int
    max_cpu_percent: float
    max_mem_percent: float
    ffmpeg_timeout: int
    min_free_disk_mb: int


def load_config(args: argparse.Namespace) -> Config:
    repo_root = Path(__file__).resolve().parents[1]
    load_dotenv(repo_root / ".env")
    orig_id = os.getenv("GMUSIC_ORIGINAL_FOLDER_ID", "").strip()
    root_id = os.getenv("GMUSIC_ROOT_FOLDER_ID", "").strip() or orig_id

    if not orig_id:
        raise ValueError("GMUSIC_ORIGINAL_FOLDER_ID must be set in the repository .env")

    workers = args.workers or int(os.getenv("MAX_WORKERS", "3"))
    cpu_cores = os.cpu_count() or 4
    default_ff_threads = max(1, cpu_cores // max(1, workers))

    return Config(
        root_folder_id=root_id,
        original_folder_id=orig_id,
        quality_folder_ids={
            "low": os.getenv("GMUSIC_LOW_FOLDER_ID", "").strip() or None,
            "medium": os.getenv("GMUSIC_MEDIUM_FOLDER_ID", "").strip() or None,
            "high": os.getenv("GMUSIC_HIGH_FOLDER_ID", "").strip() or None,
        },
        credentials_path=os.getenv("GOOGLE_CREDENTIALS_PATH")
        or os.getenv("GDRIVE_CREDENTIALS_PATH")
        or str(repo_root / "credentials1.json"),
        token_path=os.getenv("GOOGLE_TOKEN_PATH", str(Path(__file__).resolve().parent / "token.json")),
        oauth_local_port=max(1024, min(65535, int(os.getenv("GOOGLE_OAUTH_LOCAL_PORT", "8765")))),
        sqlite_path=os.getenv("LOCAL_STATE_DB", str(Path(__file__).resolve().parent / "gmusic_state.db")),
        mongodb_uri=os.getenv("MONGO_URI", "").strip() or os.getenv("MONGODB_URI", "").strip() or None,
        mongodb_db_name=os.getenv("MONGO_DB", "").strip() or os.getenv("MONGODB_DB_NAME", "Gmusic"),
        owner_id=os.getenv("GMUSIC_DRIVE_OWNER_ID", "shared").strip() or "shared",
        max_workers=max(1, workers),
        ffmpeg_threads=max(1, args.ffmpeg_threads or int(os.getenv("FFMPEG_THREADS", str(default_ff_threads)))),
        max_cpu_percent=float(args.max_cpu or os.getenv("MAX_CPU_PERCENT", "80")),
        max_mem_percent=float(args.max_mem or os.getenv("MAX_MEM_PERCENT", "80")),
        ffmpeg_timeout=max(30, int(os.getenv("FFMPEG_TIMEOUT_SECONDS", "300"))),
        min_free_disk_mb=max(256, int(os.getenv("MIN_FREE_DISK_MB", "1024"))),
    )


class ResourceLimiter:
    """Monitors CPU & RAM usage and pauses new heavy tasks if limits are exceeded."""

    def __init__(self, max_cpu: float, max_mem: float):
        self.max_cpu = max_cpu
        self.max_mem = max_mem
        self.current_cpu = 0.0
        self.current_mem = 0.0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._poll_loop, daemon=True, name="ResourceMonitor")
        self._thread.start()

    def _poll_loop(self) -> None:
        psutil.cpu_percent(interval=None)
        while not self._stop.is_set():
            cpu = psutil.cpu_percent(interval=0.5)
            mem = psutil.virtual_memory().percent
            with self._lock:
                self.current_cpu = cpu
                self.current_mem = mem

    def wait_for_headroom(self, on_throttle=None) -> None:
        while not STOP_EVENT.is_set():
            with self._lock:
                cpu, mem = self.current_cpu, self.current_mem
            if cpu <= self.max_cpu and mem <= self.max_mem:
                return
            if on_throttle:
                on_throttle(cpu, mem)
            time.sleep(1.0)

    def snapshot(self) -> Tuple[float, float]:
        with self._lock:
            return self.current_cpu, self.current_mem

    def stop(self) -> None:
        self._stop.set()


def source_version(md5: Optional[str], modified_time: Optional[str], size: Optional[int]) -> str:
    value = f"md5:{md5}" if md5 else f"mtime:{modified_time or 'unknown'}:size:{size or 'unknown'}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class StateStore:
    """Thread-safe local SQLite state for instant resume, with optional MongoDB sync."""

    def __init__(self, sqlite_path: str, mongodb_uri: Optional[str], mongodb_db_name: str, owner_id: str):
        self.sqlite_path = sqlite_path
        self.owner_id = owner_id
        self._lock = threading.Lock()
        self._init_sqlite()

        self.mongo_col = None
        if mongodb_uri and MongoClient is not None:
            client = MongoClient(mongodb_uri, serverSelectionTimeoutMS=10000)
            self.mongo_col = client[mongodb_db_name]["quality_renditions"]
            self.mongo_col.create_index(
                [("ownerId", ASCENDING), ("driveFileId", ASCENDING), ("sourceVersion", ASCENDING), ("quality", ASCENDING)],
                unique=True,
                name="uniq_owner_source_quality",
            )
            logger.info("Connected to MongoDB (%s.quality_renditions)", mongodb_db_name)

    def _init_sqlite(self) -> None:
        with sqlite3.connect(self.sqlite_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS renditions (
                    original_id TEXT NOT NULL,
                    quality TEXT NOT NULL,
                    original_filename TEXT,
                    original_md5 TEXT,
                    original_modified TEXT,
                    actual_bitrate_kbps INTEGER,
                    rendition_drive_id TEXT,
                    rendition_filename TEXT,
                    generated_size INTEGER,
                    duration_seconds REAL,
                    status TEXT NOT NULL,
                    error_message TEXT,
                    processed_at TEXT,
                    PRIMARY KEY (original_id, quality)
                )
                """
            )
            conn.commit()

    def get_rendition(self, original_id: str, quality: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            with sqlite3.connect(self.sqlite_path) as conn:
                conn.row_factory = sqlite3.Row
                row = conn.execute(
                    "SELECT * FROM renditions WHERE original_id = ? AND quality = ?",
                    (original_id, quality),
                ).fetchone()
                if row:
                    return dict(row)

        if self.mongo_col is not None:
            doc = self.mongo_col.find_one(
                {"ownerId": self.owner_id, "driveFileId": original_id, "quality": quality},
                sort=[("updatedAt", -1)],
            )
            if doc:
                return {
                    "original_id": doc.get("driveFileId"),
                    "quality": doc.get("quality"),
                    "original_md5": doc.get("sourceMd5Checksum"),
                    "original_modified": doc.get("sourceModifiedTime"),
                    "rendition_drive_id": doc.get("renditionDriveFileId"),
                    "status": doc.get("status"),
                }
        return None

    def upsert_rendition(self, doc: Dict[str, Any]) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._lock:
            with sqlite3.connect(self.sqlite_path) as conn:
                conn.execute(
                    """
                    INSERT INTO renditions (
                        original_id, quality, original_filename, original_md5, original_modified,
                        actual_bitrate_kbps, rendition_drive_id, rendition_filename,
                        generated_size, duration_seconds, status, error_message, processed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(original_id, quality) DO UPDATE SET
                        original_filename=excluded.original_filename,
                        original_md5=excluded.original_md5,
                        original_modified=excluded.original_modified,
                        actual_bitrate_kbps=excluded.actual_bitrate_kbps,
                        rendition_drive_id=excluded.rendition_drive_id,
                        rendition_filename=excluded.rendition_filename,
                        generated_size=excluded.generated_size,
                        duration_seconds=excluded.duration_seconds,
                        status=excluded.status,
                        error_message=excluded.error_message,
                        processed_at=excluded.processed_at
                    """,
                    (
                        doc["originalDriveFileId"],
                        doc["quality"],
                        doc.get("originalFilename"),
                        doc.get("originalMd5Checksum"),
                        doc.get("originalModifiedTime"),
                        doc.get("actualBitrateKbps"),
                        doc.get("renditionDriveFileId"),
                        doc.get("renditionFilename"),
                        doc.get("generatedFileSize"),
                        doc.get("durationSeconds"),
                        doc["status"],
                        doc.get("errorMessage"),
                        now_iso,
                    ),
                )
                conn.commit()

        if self.mongo_col is not None:
            version = source_version(
                doc.get("originalMd5Checksum"),
                doc.get("originalModifiedTime"),
                doc.get("sourceSize"),
            )
            rendition_id = hashlib.sha256(
                f"{self.owner_id}\0{doc['originalDriveFileId']}\0{version}\0{doc['quality']}".encode()
            ).hexdigest()
            now = datetime.now(timezone.utc)
            mongo_doc = {
                "ownerId": self.owner_id,
                "driveFileId": doc["originalDriveFileId"],
                "sourceVersion": version,
                "sourceMd5Checksum": doc.get("originalMd5Checksum"),
                "sourceModifiedTime": doc.get("originalModifiedTime"),
                "sourceSize": doc.get("sourceSize"),
                "quality": doc["quality"],
                "targetBitrateKbps": doc.get("targetBitrateKbps", QUALITY_PROFILES[doc["quality"]]["bitrate_kbps"]),
                "actualBitrateKbps": doc.get("actualBitrateKbps"),
                "codec": "mp3",
                "durationMs": int(float(doc.get("durationSeconds") or 0) * 1000) or None,
                "fileSize": doc.get("generatedFileSize"),
                "renditionDriveFileId": doc.get("renditionDriveFileId"),
                "renditionFilename": doc.get("renditionFilename"),
                "status": doc["status"],
                "errorCode": "rendition_generation_failed" if doc.get("status") == "failed" else None,
                "updatedAt": now,
            }
            if doc.get("status") == "ready":
                mongo_doc["readyAt"] = now
            self.mongo_col.update_one(
                {"_id": rendition_id},
                {"$set": mongo_doc, "$setOnInsert": {"createdAt": now}},
                upsert=True,
            )


def get_drive_credentials(credentials_path: str, token_path: str, oauth_local_port: int) -> Credentials:
    creds: Optional[Credentials] = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path)
        if not set(SCOPES).issubset(set(creds.scopes or [])):
            creds = None

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(credentials_path):
                raise FileNotFoundError(f"OAuth credentials file not found: {credentials_path}")
            flow = InstalledAppFlow.from_client_secrets_file(credentials_path, SCOPES)
            creds = flow.run_local_server(
                host="localhost",
                port=oauth_local_port,
                redirect_uri_trailing_slash=True,
            )
        with open(token_path, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
    return creds


class DriveClient:
    def __init__(self, creds: Credentials):
        self.creds = creds
        self._local = threading.local()

    @property
    def service(self):
        if not hasattr(self._local, "service"):
            self._local.service = build("drive", "v3", credentials=self.creds, cache_discovery=False)
        return self._local.service

    def ensure_quality_folders(self, root_id: str, configured_ids: Dict[str, Optional[str]]) -> Dict[str, str]:
        resolved: Dict[str, str] = {}
        for quality, meta in QUALITY_PROFILES.items():
            if configured_ids.get(quality):
                resolved[quality] = configured_ids[quality]
                continue
            folder_name = meta["folder_name"]
            q = (
                f"name = '{folder_name}' and '{root_id}' in parents "
                "and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
            )
            res = self.service.files().list(q=q, fields="files(id)", pageSize=5).execute()
            files = res.get("files", [])
            if files:
                resolved[quality] = files[0]["id"]
            else:
                created = self.service.files().create(
                    body={
                        "name": folder_name,
                        "mimeType": "application/vnd.google-apps.folder",
                        "parents": [root_id],
                    },
                    fields="id",
                ).execute()
                resolved[quality] = created["id"]
                logger.info("Created '%s' folder: %s", folder_name, resolved[quality])
        return resolved

    def list_original_files(self, original_folder_id: str, file_id: Optional[str] = None) -> List[Dict[str, Any]]:
        fields = "id, name, mimeType, size, md5Checksum, modifiedTime, trashed"
        if file_id:
            return [self.service.files().get(fileId=file_id, fields=fields).execute()]

        files: List[Dict[str, Any]] = []
        page_token: Optional[str] = None
        query = (
            f"'{original_folder_id}' in parents "
            "and mimeType != 'application/vnd.google-apps.folder' and trashed = false"
        )
        while True:
            resp = self.service.files().list(
                q=query,
                fields=f"nextPageToken, files({fields})",
                pageSize=200,
                orderBy="name_natural",
                pageToken=page_token,
            ).execute()
            files.extend(resp.get("files", []))
            page_token = resp.get("nextPageToken")
            if not page_token:
                break
        return files

    def download_file(self, file_id: str, dest_path: Path, on_progress=None) -> None:
        request = self.service.files().get_media(fileId=file_id)
        with open(dest_path, "wb") as fh:
            downloader = MediaIoBaseDownload(fh, request, chunksize=CHUNK_SIZE)
            done = False
            while not done:
                if STOP_EVENT.is_set():
                    raise InterruptedError("Download interrupted")
                status, done = self._retry(downloader.next_chunk)
                if status and on_progress:
                    on_progress(status.progress() * 100.0)
        if not dest_path.exists() or dest_path.stat().st_size == 0:
            raise IOError("Downloaded file is empty")

    def find_existing_rendition(self, folder_id: str, filename: str) -> Optional[str]:
        q = f"name = '{filename}' and '{folder_id}' in parents and trashed = false"
        res = self.service.files().list(q=q, fields="files(id)", pageSize=1).execute()
        files = res.get("files", [])
        return files[0]["id"] if files else None

    def upload_resumable(
        self,
        local_path: Path,
        filename: str,
        folder_id: str,
        app_properties: Dict[str, str],
        existing_id: Optional[str] = None,
        on_progress=None,
    ) -> Dict[str, Any]:
        media = MediaFileUpload(str(local_path), mimetype="audio/mpeg", chunksize=CHUNK_SIZE, resumable=True)
        if existing_id:
            req = self.service.files().update(
                fileId=existing_id,
                body={"name": filename, "appProperties": app_properties},
                media_body=media,
                fields="id, size",
            )
        else:
            req = self.service.files().create(
                body={"name": filename, "parents": [folder_id], "appProperties": app_properties},
                media_body=media,
                fields="id, size",
            )

        response = None
        while response is None:
            if STOP_EVENT.is_set():
                raise InterruptedError("Upload interrupted")
            status, response = self._retry(req.next_chunk)
            if status and on_progress:
                on_progress(status.progress() * 100.0)

        if not response or not response.get("id"):
            raise RuntimeError("Drive upload did not return a file ID")
        return response

    @staticmethod
    def _retry(fn, retries: int = 5):
        delay = 1.5
        for attempt in range(1, retries + 1):
            try:
                return fn()
            except HttpError as err:
                if err.resp and err.resp.status in (429, 500, 502, 503, 504) and attempt < retries:
                    time.sleep(delay)
                    delay *= 2
                else:
                    raise
            except (ConnectionError, TimeoutError, OSError):
                if attempt < retries:
                    time.sleep(delay)
                    delay *= 2
                else:
                    raise


def probe_audio(file_path: Path) -> Dict[str, Any]:
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,bit_rate:format=duration,bit_rate",
        "-of", "json", str(file_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        raise ValueError(f"ffprobe failed: {proc.stderr.strip()}")
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams", [])
    if not streams:
        raise ValueError("No audio stream found")
    fmt = data.get("format", {})
    duration = float(fmt.get("duration") or 0.0)
    if duration <= 0.1:
        raise ValueError("Invalid audio duration")
    raw_br = streams[0].get("bit_rate") or fmt.get("bit_rate")
    br_kbps = int(int(raw_br) / 1000) if raw_br and str(raw_br).isdigit() else None
    return {"codec": streams[0].get("codec_name", "unknown"), "duration": duration, "bitrate_kbps": br_kbps}


def transcode_with_progress(
    input_path: Path,
    output_path: Path,
    bitrate: str,
    duration: float,
    ffmpeg_threads: int,
    timeout: int,
    on_progress=None,
) -> Dict[str, Any]:
    cmd = [
        "ffmpeg", "-y", "-v", "error",
        "-threads", str(ffmpeg_threads),
        "-i", str(input_path),
        "-vn", "-map", "0:a:0",
        "-c:a", "libmp3lame", "-b:a", bitrate,
        "-ar", "44100", "-ac", "2", "-write_xing", "1", "-id3v2_version", "3",
        "-progress", "pipe:1", "-nostats",
        str(output_path),
    ]

    creationflags = subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 0
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=creationflags,
    )
    with PROCS_LOCK:
        ACTIVE_PROCS.add(proc)

    stderr_parts: List[str] = []
    stderr_lock = threading.Lock()
    timed_out = threading.Event()

    def drain_stderr() -> None:
        assert proc.stderr is not None
        while True:
            chunk = os.read(proc.stderr.fileno(), 4096).decode("utf-8", errors="replace")
            if not chunk:
                return
            with stderr_lock:
                stderr_parts.append(chunk)
                joined = ''.join(stderr_parts)
                if len(joined) > 8192:
                    stderr_parts[:] = [joined[-8192:]]

    def stop_timed_out_process() -> None:
        if proc.poll() is None:
            timed_out.set()
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()

    stderr_reader = threading.Thread(target=drain_stderr, daemon=True, name="FFmpegStderr")
    stderr_reader.start()
    timeout_timer = threading.Timer(timeout, stop_timed_out_process)
    timeout_timer.daemon = True
    timeout_timer.start()
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            if STOP_EVENT.is_set():
                raise InterruptedError("FFmpeg interrupted")
            line = line.strip()
            if line.startswith("out_time_us=") and duration > 0 and on_progress:
                val = line.split("=", 1)[1]
                if val.isdigit():
                    pct = min(100.0, (int(val) / 1_000_000.0 / duration) * 100.0)
                    on_progress(pct)
            elif line == "progress=end" and on_progress:
                on_progress(100.0)
        if STOP_EVENT.is_set():
            raise InterruptedError("FFmpeg interrupted")
        proc.wait(timeout=10)
        if timed_out.is_set():
            raise TimeoutError(f"FFmpeg timed out after {timeout}s")
    except BaseException:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        raise
    finally:
        timeout_timer.cancel()
        if proc.poll() is None:
            proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        stderr_reader.join(timeout=5)
        with stderr_lock:
            stderr = ''.join(stderr_parts)
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()
        with PROCS_LOCK:
            ACTIVE_PROCS.discard(proc)

    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg error ({proc.returncode}): {stderr.strip()}")
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise RuntimeError("FFmpeg produced empty file")

    return probe_audio(output_path)


def is_current(doc: Optional[Dict[str, Any]], md5: Optional[str], mod_time: str) -> bool:
    if not doc or doc.get("status") not in ("ready", "skipped_no_upscale"):
        return False
    if doc.get("status") == "ready" and not doc.get("rendition_drive_id"):
        return False
    if md5 and doc.get("original_md5"):
        return doc["original_md5"] == md5
    return doc.get("original_modified") == mod_time


class Dashboard:
    """Thread-safe Rich live dashboard showing overall + per-song parallel progress + CPU/RAM."""

    def __init__(self, total_songs: int, limiter: ResourceLimiter, max_workers: int):
        self.limiter = limiter
        self.max_workers = max_workers
        self.stats = {"processed": 0, "skipped": 0, "failed": 0, "total": total_songs}
        self._lock = threading.Lock()

        self.overall_progress = Progress(
            SpinnerColumn(),
            TextColumn("[bold cyan]{task.description}"),
            BarColumn(bar_width=35),
            TaskProgressColumn(),
            TextColumn("• [green]{task.completed}/{task.total} songs"),
            TimeElapsedColumn(),
            TimeRemainingColumn(),
        )
        self.overall_task = self.overall_progress.add_task("Overall Library", total=total_songs)

        self.song_progress = Progress(
            SpinnerColumn(),
            TextColumn("[bold white]{task.fields[song]:<28.28}"),
            TextColumn("[yellow]{task.fields[stage]:<18.18}"),
            BarColumn(bar_width=24),
            TaskProgressColumn(),
            TimeElapsedColumn(),
        )

    def add_song_task(self, song_name: str) -> TaskID:
        with self._lock:
            return self.song_progress.add_task("", total=100.0, song=song_name, stage="Queued")

    def update_song(self, task_id: TaskID, stage: str, completed: float) -> None:
        with self._lock:
            self.song_progress.update(task_id, stage=stage, completed=completed)

    def remove_song_task(self, task_id: TaskID) -> None:
        with self._lock:
            self.song_progress.remove_task(task_id)

    def record_outcome(self, outcome: str) -> None:
        with self._lock:
            if outcome == "processed":
                self.stats["processed"] += 1
            elif outcome in ("skipped_current", "skipped_non_audio", "dry_run"):
                self.stats["skipped"] += 1
            elif outcome != "interrupted":
                self.stats["failed"] += 1
            if outcome != "interrupted":
                self.overall_progress.advance(self.overall_task, 1)

    def render(self) -> Panel:
        cpu, mem = self.limiter.snapshot()
        with self._lock:
            s = dict(self.stats)

        cpu_color = "red" if cpu > self.limiter.max_cpu else "green"
        mem_color = "red" if mem > self.limiter.max_mem else "green"

        header = Table.grid(expand=True)
        header.add_column(justify="left")
        header.add_column(justify="right")
        header.add_row(
            f"[bold]Workers:[/bold] {self.max_workers}  |  "
            f"[green]Processed: {s['processed']}[/green]  "
            f"[cyan]Skipped: {s['skipped']}[/cyan]  "
            f"[red]Failed: {s['failed']}[/red]",
            f"[bold]CPU:[/bold] [{cpu_color}]{cpu:4.1f}%[/{cpu_color}] (max {self.limiter.max_cpu:.0f}%)  |  "
            f"[bold]RAM:[/bold] [{mem_color}]{mem:4.1f}%[/{mem_color}] (max {self.limiter.max_mem:.0f}%)",
        )

        body = Group(
            header,
            self.overall_progress,
            Panel(self.song_progress, title="Active Songs (Parallel)", border_style="blue"),
        )
        return Panel(body, title="[bold magenta]GMusic Offline Audio Processor[/bold magenta]", border_style="magenta")


def process_song(
    file_meta: Dict[str, Any],
    drive: DriveClient,
    store: StateStore,
    quality_folders: Dict[str, str],
    config: Config,
    limiter: ResourceLimiter,
    dashboard: Dashboard,
    dry_run: bool = False,
    force: bool = False,
) -> str:
    if STOP_EVENT.is_set():
        return "interrupted"

    orig_id = file_meta["id"]
    orig_name = file_meta["name"]
    orig_md5 = file_meta.get("md5Checksum")
    orig_mod = file_meta.get("modifiedTime", "")
    orig_size = int(file_meta.get("size") or 0)

    ext = Path(orig_name).suffix.lower()
    mime = file_meta.get("mimeType", "")
    if ext not in SUPPORTED_EXTENSIONS and not mime.startswith("audio/"):
        return "skipped_non_audio"
    if orig_size == 0:
        logger.warning("Skipping 0-byte file: %s (%s)", orig_name, orig_id)
        return "failed"

    qualities = ("low", "medium", "high")
    current_renditions = {q: store.get_rendition(orig_id, q) for q in qualities}
    needed = [
        q for q in qualities
        if force or not is_current(current_renditions[q], orig_md5, orig_mod)
    ]
    if not needed:
        logger.info("[SKIP] Already complete: %s (%s)", orig_name, orig_id)
        return "skipped_current"

    if dry_run:
        logger.info("[DRY-RUN] Would process %s for %s", orig_name, needed)
        return "dry_run"

    task_id = dashboard.add_song_task(orig_name)
    if not force:
        for q in needed:
            store.upsert_rendition({
                "originalDriveFileId": orig_id,
                "originalFilename": orig_name,
                "originalMd5Checksum": orig_md5,
                "originalModifiedTime": orig_mod,
                "sourceSize": orig_size,
                "quality": q,
                "status": "pending",
            })
    work_dir = Path(tempfile.mkdtemp(prefix=f"gmusic_{orig_id[:8]}_"))
    try:
        # Check disk space
        free_mb = shutil.disk_usage(work_dir).free // (1024 * 1024)
        if free_mb < config.min_free_disk_mb:
            raise RuntimeError(f"Low disk space: {free_mb} MB free")

        # 1. Download (0% -> 100%)
        dashboard.update_song(task_id, "Downloading", 0.0)
        local_src = work_dir / f"source{ext or '.audio'}"
        drive.download_file(orig_id, local_src, on_progress=lambda p: dashboard.update_song(task_id, "Downloading", p))

        src_info = probe_audio(local_src)
        src_br = src_info["bitrate_kbps"]
        is_lossless = src_info["codec"] in {"flac", "alac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "wavpack"}

        # 2. Convert & Upload each needed quality
        for q in needed:
            if STOP_EVENT.is_set():
                return "interrupted"

            prof = QUALITY_PROFILES[q]
            target_kbps = prof["bitrate_kbps"]

            if not is_lossless and src_br and src_br <= target_kbps:
                logger.info("[NO-UPSCALE] %s (%s) source is %dkbps; skipping %s", orig_name, orig_id, src_br, q)
                if not (force and is_current(current_renditions[q], orig_md5, orig_mod)):
                    store.upsert_rendition({
                        "originalDriveFileId": orig_id,
                        "originalFilename": orig_name,
                        "originalMd5Checksum": orig_md5,
                        "originalModifiedTime": orig_mod,
                        "sourceSize": orig_size,
                        "quality": q,
                        "actualBitrateKbps": src_br,
                        "targetBitrateKbps": target_kbps,
                        "status": "skipped_no_upscale",
                    })
                continue

            # Enforce CPU & RAM limits before launching FFmpeg
            limiter.wait_for_headroom(
                on_throttle=lambda c, m: dashboard.update_song(task_id, f"Wait CPU/RAM", 0.0)
            )

            target_name = f"{orig_id}_{prof['ffmpeg_bitrate']}.mp3"
            local_out = work_dir / target_name

            if not force:
                store.upsert_rendition({
                    "originalDriveFileId": orig_id,
                    "originalFilename": orig_name,
                    "originalMd5Checksum": orig_md5,
                    "originalModifiedTime": orig_mod,
                    "sourceSize": orig_size,
                    "quality": q,
                    "targetBitrateKbps": target_kbps,
                    "status": "processing",
                })

            stage_enc = f"FFmpeg {prof['ffmpeg_bitrate']}"
            dashboard.update_song(task_id, stage_enc, 0.0)
            out_info = transcode_with_progress(
                local_src,
                local_out,
                prof["ffmpeg_bitrate"],
                src_info["duration"],
                config.ffmpeg_threads,
                config.ffmpeg_timeout,
                on_progress=lambda p, st=stage_enc: dashboard.update_song(task_id, st, p),
            )

            stage_up = f"Upload {prof['ffmpeg_bitrate']}"
            dashboard.update_song(task_id, stage_up, 0.0)
            folder_id = quality_folders[q]
            existing_id = drive.find_existing_rendition(folder_id, target_name)

            uploaded = drive.upload_resumable(
                local_out,
                target_name,
                folder_id,
                {
                    "gmusicOriginalId": orig_id,
                    "gmusicQuality": q,
                    "gmusicSourceMd5": orig_md5 or "",
                    "gmusicSourceVersion": source_version(orig_md5, orig_mod, orig_size),
                },
                existing_id=existing_id,
                on_progress=lambda p, st=stage_up: dashboard.update_song(task_id, st, p),
            )

            store.upsert_rendition({
                "originalDriveFileId": orig_id,
                "originalFilename": orig_name,
                "originalMd5Checksum": orig_md5,
                "originalModifiedTime": orig_mod,
                "sourceSize": orig_size,
                "quality": q,
                "targetBitrateKbps": target_kbps,
                "actualBitrateKbps": out_info["bitrate_kbps"] or target_kbps,
                "renditionDriveFileId": uploaded["id"],
                "renditionFilename": target_name,
                "generatedFileSize": int(uploaded.get("size") or local_out.stat().st_size),
                "durationSeconds": out_info["duration"],
                "status": "ready",
            })
            logger.info("[DONE] %s -> %s (Drive ID: %s)", orig_name, q.upper(), uploaded["id"])
            local_out.unlink(missing_ok=True)

        return "processed"

    except InterruptedError:
        return "interrupted"
    except Exception as exc:
        logger.error("[ERROR] %s (%s): %s", orig_name, orig_id, exc)
        for q in needed:
            if not is_current(store.get_rendition(orig_id, q), orig_md5, orig_mod):
                store.upsert_rendition({
                    "originalDriveFileId": orig_id,
                    "originalFilename": orig_name,
                    "originalMd5Checksum": orig_md5,
                    "originalModifiedTime": orig_mod,
                    "sourceSize": orig_size,
                    "quality": q,
                    "status": "failed",
                    "errorMessage": str(exc),
                })
        return "failed"
    finally:
        dashboard.remove_song_task(task_id)
        shutil.rmtree(work_dir, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GMusic Parallel Offline Audio Processor")
    p.add_argument("--workers", type=int, default=None, help="Parallel songs to process at once (default: 3)")
    p.add_argument("--ffmpeg-threads", type=int, default=None, help="CPU threads per FFmpeg process")
    p.add_argument("--max-cpu", type=float, default=None, help="Pause new FFmpeg jobs if CPU %% exceeds this (default: 80)")
    p.add_argument("--max-mem", type=float, default=None, help="Pause new FFmpeg jobs if RAM %% exceeds this (default: 80)")
    p.add_argument("--limit", type=int, default=None, help="Process only the first N songs")
    p.add_argument("--file-id", type=str, default=None, help="Process a single Drive file ID")
    p.add_argument("--dry-run", action="store_true", help="Preview what would be processed")
    p.add_argument("--force", action="store_true", help="Regenerate all qualities, preserving existing links until replacement")
    p.add_argument("--verbose", action="store_true", help="Verbose file logging")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    setup_logging(verbose=args.verbose)

    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            print(f"ERROR: '{tool}' not found in PATH. Install FFmpeg first.", file=sys.stderr)
            return 1

    config = load_config(args)
    creds = get_drive_credentials(config.credentials_path, config.token_path, config.oauth_local_port)
    drive = DriveClient(creds)
    store = StateStore(config.sqlite_path, config.mongodb_uri, config.mongodb_db_name, config.owner_id)
    limiter = ResourceLimiter(config.max_cpu_percent, config.max_mem_percent)

    quality_folders = drive.ensure_quality_folders(config.root_folder_id, config.quality_folder_ids)
    files = drive.list_original_files(config.original_folder_id, file_id=args.file_id)
    if args.limit and args.limit > 0:
        files = files[: args.limit]

    dashboard = Dashboard(len(files), limiter, config.max_workers)
    logger.info("Starting run: %d songs, workers=%d, max_cpu=%.0f%%, max_mem=%.0f%%",
                len(files), config.max_workers, config.max_cpu_percent, config.max_mem_percent)

    try:
        with Live(dashboard.render(), refresh_per_second=6) as live:
            def ui_refresher():
                while not STOP_EVENT.is_set() and not ui_done.is_set():
                    live.update(dashboard.render())
                    time.sleep(0.2)

            ui_done = threading.Event()
            refresher = threading.Thread(target=ui_refresher, daemon=True)
            refresher.start()

            with ThreadPoolExecutor(max_workers=config.max_workers, thread_name_prefix="SongWorker") as pool:
                futures = [
                    pool.submit(
                        process_song,
                        f,
                        drive,
                        store,
                        quality_folders,
                        config,
                        limiter,
                        dashboard,
                        dry_run=args.dry_run,
                        force=args.force,
                    )
                    for f in files
                ]
                for fut in as_completed(futures):
                    outcome = fut.result()
                    dashboard.record_outcome(outcome)
                    live.update(dashboard.render())
                    if STOP_EVENT.is_set():
                        for pending in futures:
                            pending.cancel()
                        break

            ui_done.set()
            live.update(dashboard.render())
    finally:
        limiter.stop()

    logger.info("Run finished. Stats: %s", dashboard.stats)
    return 130 if STOP_EVENT.is_set() else 0


if __name__ == "__main__":
    sys.exit(main())
