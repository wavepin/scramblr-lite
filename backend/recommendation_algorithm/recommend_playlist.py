"""
Fixed-length playlist recommendation script.

Reads selected start/end songs from stdin, resolves endpoint vectors, walks
between them in Qdrant, and writes bridge-song metadata to stdout.

Input:
  {
    "startSong": { "name": "...", "artist": "..." },
    "endSong": { "name": "...", "artist": "..." },
    "bridgeCount": 10
  }

Output:
  [
    { "title": "...", "artist": "...", "tags": [...] }
  ]
"""

import json
import os
import re
import sys
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Sequence, TypeAlias

import librosa
import numpy as np
import requests
import torch
import yt_dlp
from numpy.typing import NDArray
from qdrant_client import QdrantClient, models
from transformers import ClapModel, ClapProcessor


FloatVector: TypeAlias = NDArray[np.floating[Any]]
FloatMatrix: TypeAlias = NDArray[np.floating[Any]]
VectorLike: TypeAlias = Sequence[float] | FloatVector
MatrixLike: TypeAlias = Sequence[Sequence[float]] | FloatMatrix
PointId: TypeAlias = models.ExtendedPointId

URL_BASE = "http://localhost:3001/"
QDRANT_URL = "https://e7463e3f-1d28-466a-9931-ede4a35ce4ee.us-east4-0.gcp.cloud.qdrant.io"
COLLECTION_NAME = os.getenv("QDRANT_COLLECTION_NAME", "youtubeDataset")
MODEL_NAME = "laion/larger_clap_music"
AUDIO_DIR = Path(__file__).resolve().parent / "_tmp_audio"

PLAYLIST_BRIDGE_COUNT = 10
SCALE_ENDPOINTS = 2
QUERY_SIMILARITY_WEIGHT = 0.75
PREFERENCE_SIMILARITY_WEIGHT = 0.25
AVOID_SIMILARITY_WEIGHT = 0.45
INITIAL_SUGGESTION_LIMIT = 50
SUGGESTION_LIMIT_STEP = 10
MAX_SUGGESTION_LIMIT = 250
SEARCH_LIMIT = 25


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def normalize_text(value: str | None) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", (value or "").lower())
    return " ".join(normalized.split())


def normalize_song(raw: Any, field_name: str) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise ValueError(f"{field_name} must be an object.")

    name = str(raw.get("name") or raw.get("title") or "").strip()
    artist = str(raw.get("artist") or "").strip()
    if not name or not artist:
        raise ValueError(f"{field_name}.name and {field_name}.artist are required.")

    return {"name": name, "artist": artist}


def ensure_audio_dir() -> Path:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    return AUDIO_DIR


def cleanup_audio_dir() -> None:
    if not AUDIO_DIR.exists():
        return

    for path in AUDIO_DIR.iterdir():
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def create_qdrant_client() -> QdrantClient:
    qdrant_api_key = os.getenv("QDRANT_API_KEY")
    if not qdrant_api_key:
        raise RuntimeError("QDRANT_API_KEY environment variable is not set.")

    return QdrantClient(url=QDRANT_URL, api_key=qdrant_api_key)


def ensure_text_index(
    client: QdrantClient,
    collection_name: str,
    field_name: str,
) -> None:
    client.create_payload_index(
        collection_name=collection_name,
        field_name=field_name,
        field_schema=models.TextIndexParams(
            type=models.TextIndexType.TEXT,
            tokenizer=models.TokenizerType.MULTILINGUAL,
            lowercase=True,
            ascii_folding=True,
        ),
        wait=True,
    )


def get_title_from_payload(payload: dict[str, Any]) -> str:
    return payload.get("song", "") or payload.get("title", "")


def get_song_key_from_values(title: str, artist: str) -> tuple[str, str]:
    return normalize_text(title), normalize_text(artist)


def get_song_key(payload: dict[str, Any]) -> tuple[str, str]:
    return get_song_key_from_values(get_title_from_payload(payload), payload.get("artist", ""))


def get_record_vector(record: models.Record) -> FloatVector | None:
    vector = record.vector
    if vector is None:
        return None

    if isinstance(vector, dict):
        vector = next(iter(vector.values()), None)
        if vector is None:
            return None

    return np.asarray(vector, dtype=np.float32)


def vector_array(vector: VectorLike | dict[str, Any] | None) -> FloatVector | None:
    if vector is None:
        return None
    if isinstance(vector, dict):
        vector = next(iter(vector.values()), None)
        if vector is None:
            return None
    return np.asarray(vector, dtype=np.float32)


def cosine_similarity(
    left: VectorLike | dict[str, Any] | None,
    right: VectorLike | dict[str, Any] | None,
) -> float:
    left_arr = vector_array(left)
    right_arr = vector_array(right)
    if left_arr is None or right_arr is None or left_arr.shape != right_arr.shape:
        return 0.0

    denominator = np.linalg.norm(left_arr) * np.linalg.norm(right_arr)
    if denominator == 0:
        return 0.0

    return float(np.dot(left_arr, right_arr) / denominator)


def matrix_array(
    matrix: MatrixLike | VectorLike | dict[str, Any] | None,
    vector_size: int | None = None,
) -> FloatMatrix | None:
    if matrix is None:
        return None
    if isinstance(matrix, dict):
        matrix = next(iter(matrix.values()), None)
        if matrix is None:
            return None

    arr = np.asarray(matrix, dtype=np.float32)
    if arr.size == 0:
        return None

    if arr.ndim == 1:
        if vector_size is not None and arr.size != vector_size:
            return None
        return arr.reshape(-1, 1)

    if arr.ndim != 2:
        return None

    if vector_size is not None:
        if arr.shape[0] == vector_size:
            return arr
        if arr.shape[1] == vector_size:
            return arr.T
        return None

    return arr


def max_matrix_similarity(
    vector: VectorLike | dict[str, Any] | None,
    matrix: MatrixLike | VectorLike | dict[str, Any] | None,
) -> float:
    vector_arr = vector_array(vector)
    if vector_arr is None:
        return 0.0

    matrix_arr = matrix_array(matrix, vector_arr.size)
    if matrix_arr is None:
        return 0.0

    vector_norm = np.linalg.norm(vector_arr)
    matrix_norms = np.linalg.norm(matrix_arr, axis=0)
    denominators = vector_norm * matrix_norms
    dots = vector_arr @ matrix_arr
    sims = np.divide(
        dots,
        denominators,
        out=np.zeros_like(dots, dtype=np.float32),
        where=denominators > 0,
    )
    return float(np.max(sims)) if sims.size else 0.0


def search_candidate_records(
    client: QdrantClient,
    title: str,
    artist: str,
    limit: int = SEARCH_LIMIT,
) -> list[models.Record]:
    records, _ = client.scroll(
        collection_name=COLLECTION_NAME,
        scroll_filter=models.Filter(
            must=[
                models.FieldCondition(
                    key="song",
                    match=models.MatchText(text=title),
                ),
                models.FieldCondition(
                    key="artist",
                    match=models.MatchText(text=artist),
                ),
            ]
        ),
        with_payload=True,
        with_vectors=True,
        limit=limit,
    )
    return records


def find_matching_record(
    client: QdrantClient,
    song: dict[str, str],
) -> models.Record | None:
    expected = get_song_key_from_values(song["name"], song["artist"])

    for record in search_candidate_records(client, song["name"], song["artist"]):
        payload = record.payload or {}
        if get_song_key(payload) == expected:
            return record

    return None


def search_youtube_url(title: str, artist: str) -> dict[str, Any] | None:
    try:
        response = requests.get(
            URL_BASE + "api/search/youtubeURL",
            params={"title": title, "artist": artist},
            timeout=20,
        )
        data = response.json()
    except (requests.RequestException, ValueError):
        return None

    if not response.ok:
        return None

    return data if isinstance(data, dict) and data.get("url") else None


def load_clap_resources() -> tuple[ClapModel, ClapProcessor, str]:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"Loading CLAP model on {device}...")
    model = ClapModel.from_pretrained(MODEL_NAME, local_files_only=False).to(device)
    processor = ClapProcessor.from_pretrained(MODEL_NAME)
    model.eval()
    log("Model loaded.")
    return model, processor, device


def get_mp3_from_url(url: str, song: dict[str, str]) -> tuple[np.ndarray | None, int | None]:
    ffmpeg_path = os.getenv("FFMPEG_PATH")
    if not ffmpeg_path:
        raise RuntimeError("FFMPEG_PATH is required when endpoint songs are not already in Qdrant.")

    ensure_audio_dir()
    ydl_opts = {
        "format": "bestaudio/best",
        "ffmpeg_location": ffmpeg_path,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
        "outtmpl": str(AUDIO_DIR / "%(title)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(url, download=True)
            filename = Path(ydl.prepare_filename(info)).with_suffix(".mp3")
            audio, sample_rate = librosa.load(filename, sr=48000, mono=True)
            start = sample_rate * 30 #skips first 30 seconds
            end = sample_rate * 90 #1 minute of audio after 30 seconds
            return audio[start:end], sample_rate
        except Exception as err:
            log(f"Failed to download endpoint audio for {song['artist']} - {song['name']}: {err}")
            return None, None


def embed_song_audio(
    song: dict[str, str],
    model: ClapModel,
    processor: ClapProcessor,
    device: str,
) -> FloatVector | None:
    yt_result = search_youtube_url(song["name"], song["artist"])
    if yt_result is None:
        return None

    audio, sample_rate = get_mp3_from_url(yt_result["url"], song)
    if audio is None or sample_rate is None:
        return None

    encoded = processor(
        audio=audio,
        sampling_rate=sample_rate,
        return_tensors="pt",
        padding=True,
    ).to(device)
    with torch.no_grad():
        return model.get_audio_features(**encoded).pooler_output[0].cpu().numpy()
        
def normalize(text: str) -> str:
    if not text:
        return ""

    text = text.lower()
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"\.mp3$", "", text)
    text = re.sub(r"\(.*?\)|\[.*?\]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return text.strip()

NAMESPACEURL = uuid.UUID(os.getenv("UUID_NAMESPACE"))
def make_id(artist, title):
    key = f"{normalize(artist)}::{normalize(title)}"
    return str(uuid.uuid5(NAMESPACEURL, key))


def upsert_endpoint_vector(
    client: QdrantClient,
    song: dict[str, str],
    vector: VectorLike,
) -> PointId:
    point_id = make_id(song["artist"], song["name"])
    client.upsert(
        collection_name=COLLECTION_NAME,
        points=[
            models.PointStruct(
                id=point_id,
                vector=np.asarray(vector, dtype=np.float32).tolist(),
                payload={
                    "artist": song["artist"],
                    "song": song["name"],
                    "title": song["name"],
                    "url": search_youtube_url(song["name"], song["artist"])["url"],
                    "path": "downloaded from playlist generation",
                },
            )
        ],
        wait=True,
    )
    return point_id


def resolve_song_vector(
    client: QdrantClient,
    song: dict[str, str],
    model_state: dict[str, Any],
) -> tuple[FloatVector, PointId | None]:
    record = find_matching_record(client, song)
    if record is not None:
        vector = get_record_vector(record)
        if vector is not None:
            return vector, record.id

    if "resources" not in model_state:
        model_state["resources"] = load_clap_resources()

    model, processor, device = model_state["resources"]
    vector = embed_song_audio(song, model, processor, device)
    if vector is None:
        raise RuntimeError(f"Could not resolve vector for {song['artist']} - {song['name']}.")

    point_id = upsert_endpoint_vector(client, song, vector)
    return np.asarray(vector, dtype=np.float32), point_id


def build_query_filter(history_ids: set[PointId]) -> models.Filter | None:
    if not history_ids:
        return None

    return models.Filter(
        must_not=[
            models.HasIdCondition(has_id=list(history_ids)),
        ],
    )


def query_similar_points(
    client: QdrantClient,
    query_vector: VectorLike,
    history_ids: set[PointId],
    limit: int,
) -> list[models.ScoredPoint]:
    return client.query_points(
        collection_name=COLLECTION_NAME,
        query=query_vector,
        query_filter=build_query_filter(history_ids),
        with_payload=True,
        with_vectors=True,
        limit=limit,
    ).points


def select_best_point(
    points: Sequence[models.ScoredPoint],
    seen_songs: set[tuple[str, str]],
    preference_vector: MatrixLike | VectorLike | None,
    avoid_vector: MatrixLike | VectorLike | None,
    query_similarity_weight: float,
    preference_similarity_weight: float,
    avoid_similarity_weight: float,
) -> models.ScoredPoint | None:
    best: models.ScoredPoint | None = None
    best_score = float("-inf")

    for point in points:
        payload = point.payload or {}
        song_key = get_song_key(payload)
        if song_key in seen_songs:
            continue

        preference_score = max(0.0, max_matrix_similarity(point.vector, preference_vector))
        avoid_score = max(0.0, max_matrix_similarity(point.vector, avoid_vector))
        score = (
            query_similarity_weight * float(point.score or 0.0)
            + preference_similarity_weight * preference_score
            - avoid_similarity_weight * avoid_score
        )

        if best is None or score > best_score:
            best = point
            best_score = score

    return best


def find_next_point(
    client: QdrantClient,
    query_vector: VectorLike,
    history_ids: set[PointId],
    seen_songs: set[tuple[str, str]],
    preference_vector: MatrixLike | VectorLike | None,
    avoid_vector: MatrixLike | VectorLike | None,
    query_similarity_weight: float,
    preference_similarity_weight: float,
    avoid_similarity_weight: float,
) -> models.ScoredPoint | None:
    limit = INITIAL_SUGGESTION_LIMIT
    fallback: models.ScoredPoint | None = None

    while limit <= MAX_SUGGESTION_LIMIT:
        suggestions = query_similar_points(
            client=client,
            query_vector=query_vector,
            history_ids=history_ids,
            limit=limit,
        )

        if suggestions:
            unseen = next(
                (
                    point
                    for point in suggestions
                    if get_song_key(point.payload or {}) not in seen_songs
                ),
                None,
            )
            if unseen is not None and fallback is None:
                fallback = unseen

            best = select_best_point(
                suggestions,
                seen_songs,
                preference_vector,
                avoid_vector,
                query_similarity_weight,
                preference_similarity_weight,
                avoid_similarity_weight,
            )
            if best is not None:
                return best

        limit += SUGGESTION_LIMIT_STEP

    return fallback


def build_interpolated_query(
    step_index: int,
    total_steps: int,
    start_vector: VectorLike,
    end_vector: VectorLike,
) -> FloatVector:
    progress = (step_index + 1) / (total_steps + 1)
    scaled_start = np.asarray(start_vector, dtype=np.float32) * SCALE_ENDPOINTS
    scaled_end = np.asarray(end_vector, dtype=np.float32) * SCALE_ENDPOINTS
    return scaled_start * (1 - progress) + scaled_end * progress


def run_playlist_chain(
    client: QdrantClient,
    start_vector: VectorLike,
    end_vector: VectorLike,
    bridge_count: int,
    endpoint_ids: set[PointId],
    endpoint_song_keys: set[tuple[str, str]],
    preference_vector: MatrixLike | VectorLike | None = None,
    avoid_vector: MatrixLike | VectorLike | None = None,
    query_similarity_weight: float = QUERY_SIMILARITY_WEIGHT,
    preference_similarity_weight: float = PREFERENCE_SIMILARITY_WEIGHT,
    avoid_similarity_weight: float = AVOID_SIMILARITY_WEIGHT,
) -> list[models.ScoredPoint]:
    history: list[models.ScoredPoint] = []
    history_ids: set[PointId] = set(endpoint_ids)
    seen_songs: set[tuple[str, str]] = set(endpoint_song_keys)

    for step_index in range(bridge_count):
        query_vector = build_interpolated_query(
            step_index=step_index,
            total_steps=bridge_count,
            start_vector=start_vector,
            end_vector=end_vector,
        )

        point = find_next_point(
            client=client,
            query_vector=query_vector,
            history_ids=history_ids,
            seen_songs=seen_songs,
            preference_vector=preference_vector,
            avoid_vector=avoid_vector,
            query_similarity_weight=query_similarity_weight,
            preference_similarity_weight=preference_similarity_weight,
            avoid_similarity_weight=avoid_similarity_weight,
        )
        if point is None:
            break

        history.append(point)
        history_ids.add(point.id)
        seen_songs.add(get_song_key(point.payload or {}))
        log(
            f"Bridge {step_index + 1}/{bridge_count}: "
            f"{get_title_from_payload(point.payload or {}) or '?'} - "
            f"{(point.payload or {}).get('artist', '?')}"
        )

    return history


def build_results(history: Sequence[models.ScoredPoint]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []

    for point in history:
        payload = point.payload or {}
        title = get_title_from_payload(payload)
        artist = payload.get("artist", "")
        if not title or not artist:
            continue

        results.append(
            {
                "title": title,
                "artist": artist,
                "tags": payload.get("tags", []),
            }
        )

    return results


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
        start_song = normalize_song(payload.get("startSong"), "startSong")
        end_song = normalize_song(payload.get("endSong"), "endSong")
        bridge_count = int(payload.get("bridgeCount") or PLAYLIST_BRIDGE_COUNT)
        preference_vector = np.asarray(
            payload.get("preference_matrix", payload.get("preference_vector", [])),
            dtype=np.float32,
        )
        avoid_vector = np.asarray(
            payload.get("avoid_matrix", payload.get("avoid_vector", [])),
            dtype=np.float32,
        )
    except (json.JSONDecodeError, TypeError, ValueError) as err:
        log(f"Invalid playlist input: {err}")
        sys.exit(1)

    if bridge_count < 1 or bridge_count > 25:
        log("bridgeCount must be between 1 and 25.")
        sys.exit(1)

    client = create_qdrant_client()
    ensure_text_index(client, COLLECTION_NAME, "artist")
    ensure_text_index(client, COLLECTION_NAME, "song")

    model_state: dict[str, Any] = {}

    try:
        start_vector, start_id = resolve_song_vector(client, start_song, model_state)
        end_vector, end_id = resolve_song_vector(client, end_song, model_state)

        if preference_vector.size == 0:
            preference_vector = np.zeros((start_vector.size, 1), dtype=np.float32)
        if avoid_vector.size == 0:
            avoid_vector = np.zeros((start_vector.size, 1), dtype=np.float32)

        endpoint_ids = {point_id for point_id in (start_id, end_id) if point_id is not None}
        endpoint_song_keys = {
            get_song_key_from_values(start_song["name"], start_song["artist"]),
            get_song_key_from_values(end_song["name"], end_song["artist"]),
        }

        history = run_playlist_chain(
            client=client,
            start_vector=start_vector,
            end_vector=end_vector,
            bridge_count=bridge_count,
            endpoint_ids=endpoint_ids,
            endpoint_song_keys=endpoint_song_keys,
            preference_vector=preference_vector,
            avoid_vector=avoid_vector,
        )
    except RuntimeError as err:
        log(str(err))
        cleanup_audio_dir()
        sys.exit(1)

    json.dump(build_results(history), sys.stdout)
    sys.stdout.flush()
    cleanup_audio_dir()


if __name__ == "__main__":
    main()
