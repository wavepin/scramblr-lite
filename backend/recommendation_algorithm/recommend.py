"""
Production recommendation script.
Reads user preferences as JSON from stdin, runs the CLAP + Qdrant
recommendation loop, and writes a JSON array of recommended songs to stdout.

Input (stdin JSON):
  {
    "genres": ["Jazz", "Pop"],
    "artists": ["Adele"],
    "songs": [{"name": "Hello", "artist": "Adele"}],
    "avoid_genres": ["Country"],
    "preference_matrix": [[...], ...],
    "recommendation_speed": "regular",
    "start_song": {"name": "Hello", "artist": "Adele"},
    "end_song": {"name": "1738", "artist": "Fetty Wap"}
  }

Output (stdout JSON):
  [ { "title": "...", "artist": "...", "tags": [...] }, ... ]
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Sequence, TypeAlias

import numpy as np
import torch
from numpy.typing import NDArray
from qdrant_client import QdrantClient, models
from transformers import ClapModel, ClapProcessor

from get_vector_from_preferences import (
    cleanup_created_files,
    ensure_audio_dir,
    get_mp3_from_url,
    search_youtube_url,
    upload_vector
)


FloatVector: TypeAlias = NDArray[np.floating[Any]]
FloatMatrix: TypeAlias = NDArray[np.floating[Any]]

VectorLike: TypeAlias = Sequence[float] | FloatVector
MatrixLike: TypeAlias = Sequence[Sequence[float]] | FloatMatrix
PointId: TypeAlias = models.ExtendedPointId

QDRANT_URL = "https://e7463e3f-1d28-466a-9931-ede4a35ce4ee.us-east4-0.gcp.cloud.qdrant.io"
COLLECTION_NAME = os.getenv("QDRANT_COLLECTION_NAME", "youtubeDataset")
MODEL_NAME = "laion/larger_clap_music"

PREFERENCE_SCALE = 0.45
ITERATIONS = 10
ALPHA = 0.2
QUERY_UPDATE_MODE = "legacy"
SCALE_ENDPOINTS = 1
QUERY_SIMILARITY_WEIGHT = 0.55
CONTINUITY_SIMILARITY_WEIGHT = 0.45
AVOID_SIMILARITY_WEIGHT = 1.2
AVOID_HARD_SIMILARITY_THRESHOLD = None
CONTINUITY_MIN_SIMILARITY = 0.18
INITIAL_SUGGESTION_LIMIT = 10
SUGGESTION_LIMIT_STEP = 10
MAX_SUGGESTION_LIMIT = 200
CANDIDATE_SCORE_THRESHOLD = 0.45
CANDIDATE_SCORE_FALLBACK_LIMIT = 150

def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def build_text_prompt(preferences: dict[str, Any], role: str) -> str:
    parts: list[str] = []

    if role == "start":
        if preferences.get("genres"):
            parts.append(", ".join(preferences["genres"]))
        if preferences.get("artists"):
            parts.append(", ".join(preferences["artists"]))
        if preferences.get("songs"):
            song_strs: list[str] = []
            for song in preferences["songs"][:3]:
                if song.get("artist"):
                    song_strs.append(f"{song['name']} by {song['artist']}")
                else:
                    song_strs.append(song["name"])
            parts.append(", ".join(song_strs))
    elif role == "end":
        return (
            "experimental electronic ambient world music classical jazz fusion "
            "avant-garde instrumental soundtrack cinematic lo-fi afrobeat reggae "
            "bossa nova"
        )

    return " ".join(parts) if parts else "popular music"


def create_qdrant_client() -> QdrantClient:
    qdrant_api_key = os.getenv("QDRANT_API_KEY")
    if not qdrant_api_key:
        log("QDRANT_API_KEY environment variable is not set.")
        # sys.exit(1)
        return

    return QdrantClient(
        url=QDRANT_URL,
        api_key=qdrant_api_key,
    )


def load_clap_resources() -> tuple[ClapModel, ClapProcessor, str]:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"Loading CLAP model on {device}...")
    model = ClapModel.from_pretrained(MODEL_NAME, local_files_only=False).to(device)
    processor = ClapProcessor.from_pretrained(MODEL_NAME)
    model.eval()
    log("Model loaded.")
    return model, processor, device


def embed_text(
    text: str,
    model: ClapModel,
    processor: ClapProcessor,
    device: str,
) -> FloatVector:
    encoded = processor(text=[text], return_tensors="pt").to(device)
    with torch.no_grad():
        return model.get_text_features(**encoded).pooler_output[0].cpu().numpy()


def normalize_vector(vector: VectorLike | None) -> FloatVector | None:
    if vector is None:
        return None
    arr = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = np.linalg.norm(arr)
    if norm == 0 or not np.isfinite(norm):
        return arr
    return arr / norm


def most_similar_matrix_column(
    vector: VectorLike | dict[str, Any] | None,
    matrix: MatrixLike | VectorLike | dict[str, Any] | None,
) -> FloatVector | None:
    vector_arr = vector_array(vector)
    if vector_arr is None:
        return None

    matrix_arr = matrix_array(matrix, vector_arr.size)
    if matrix_arr is None:
        return None

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
    if sims.size == 0:
        return None

    return matrix_arr[:, int(np.argmax(sims))]


def build_next_query(
    mode: str,
    step_index: int,
    total_steps: int,
    start_vector: VectorLike,
    end_vector: VectorLike,
    chosen_vector: VectorLike,
    alpha_value: float,
    endpoint_scale: int | float,
    preference_matrix: MatrixLike | VectorLike | None = None,
    avoid_matrix: MatrixLike | VectorLike | None = None,
    preference_scale: float = PREFERENCE_SCALE,
    avoid_scale: float = AVOID_SIMILARITY_WEIGHT,
) -> FloatVector:
    scaled_start: FloatVector = np.array(start_vector) * endpoint_scale
    scaled_end: FloatVector = np.array(end_vector) * endpoint_scale
    preference_col = most_similar_matrix_column(chosen_vector, preference_matrix)
    if preference_col is not None and preference_col.shape == scaled_end.shape:
        scaled_end = scaled_end + normalize_vector(preference_col) * preference_scale

    avoid_col = most_similar_matrix_column(chosen_vector, avoid_matrix)
    if avoid_col is not None and avoid_col.shape == scaled_end.shape:
        scaled_end = scaled_end - normalize_vector(avoid_col) * avoid_scale

    if mode == "legacy":
        return (
            (scaled_end - np.array(chosen_vector)) * alpha_value
            + np.array(chosen_vector)
        )

    if mode == "interpolate":
        if total_steps <= 1:
            progress = 1.0
        else:
            progress = min((step_index + 1) / (total_steps - 1), 1.0)
        return scaled_start * (1 - progress) + scaled_end * progress

    raise ValueError(f"Unknown query_update_mode: {mode}")


def build_query_filter(history_ids: set[PointId]) -> models.Filter | None:
    if not history_ids:
        return None

    return models.Filter(
        must_not=[
            models.HasIdCondition(has_id=list(history_ids)),
        ],
    )

def ensure_text_index(
    client: QdrantClient,
    collection_name: str,
    field_name: str,
) -> None:
    try:
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
    except Exception as err:
        log(f"Qdrant text index setup failed for {field_name}; continuing: {err}")


def search_payload_text(
    client: QdrantClient,
    collection_name: str,
    field_name: str,
    text: str,
    limit: int = 20,
    with_vectors: bool = True,
) -> list[models.Record]:
    try:
        records, _ = client.scroll(
            collection_name=collection_name,
            scroll_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key=field_name,
                        match=models.MatchText(text=text),
                    )
                ]
            ),
            with_payload=True,
            with_vectors=with_vectors,
            limit=limit,
        )
    except Exception as err:
        log(f"Qdrant payload search failed for {field_name}={text}: {err}")
        return []
    return records


def search_song_payload(
    client: QdrantClient,
    collection_name: str,
    song: Any,
) -> list[models.Record]:
    if not isinstance(song, dict):
        return []

    title = song.get("name") or song.get("title") or ""
    artist = song.get("artist") or ""
    if not title or not artist:
        return []

    try:
        records, _ = client.scroll(
            collection_name=collection_name,
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
            limit=20,
        )
    except Exception as err:
        log(f"Qdrant song lookup failed for {artist} - {title}: {err}")
        return []

    return records


def query_similar_points(
    client: QdrantClient,
    collection_name: str,
    query_vector: VectorLike,
    history_ids: set[PointId] | None = None,
    limit: int = 10,
    with_vectors: bool = True,
) -> list[models.ScoredPoint]:
    try:
        return client.query_points(
            collection_name=collection_name,
            query=query_vector,
            query_filter=build_query_filter(history_ids or set()),
            with_payload=True,
            with_vectors=with_vectors,
            limit=limit,
        ).points
    except Exception as err:
        log(f"Qdrant recommendation query failed: {err}")
        return []


def get_title_from_payload(payload: dict[str, Any]) -> str:
    return payload.get("song", "") or payload.get("title", "")


def get_song_key(payload: dict[str, Any]) -> tuple[str, str]:
    title = normalize(get_title_from_payload(payload))
    artist = normalize(payload.get("artist", ""))
    return title, artist


def song_to_key(song: Any) -> tuple[str, str] | None:
    if not isinstance(song, dict):
        return None
    title = song.get("title") or song.get("name") or song.get("song") or ""
    artist = song.get("artist") or ""
    key = normalize(title), normalize(artist)
    return key if key != ("", "") else None


def songs_to_key_set(songs: Any) -> set[tuple[str, str]]:
    if not isinstance(songs, list):
        return set()
    return {key for key in (song_to_key(song) for song in songs) if key is not None}


def normalize_genre_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def expand_genres(genres: Sequence[Any] | None) -> set[str]:
    normalized_genres: set[str] = set()
    for genre in genres or []:
        name = genre.get("name") if isinstance(genre, dict) else genre
        normalized = normalize_genre_name(name)
        if not normalized:
            continue
        normalized_genres.add(normalized)
    return normalized_genres


def genre_matches_any(name: Any, genres: set[str]) -> bool:
    normalized = normalize_genre_name(name)
    if not normalized:
        return False
    return normalized in genres


def payload_tag_names(payload: dict[str, Any] | None) -> list[str]:
    if not payload:
        return []

    names: list[str] = []
    for field_name in ("genre", "genres", "tags"):
        value = payload.get(field_name)
        values = value if isinstance(value, list) else [value]
        for item in values:
            if isinstance(item, str):
                names.append(item)
            elif isinstance(item, dict):
                tag_name = item.get("name") or item.get("tag")
                if tag_name:
                    names.append(str(tag_name))
    return names


def payload_matches_avoided_genres(
    payload: dict[str, Any] | None,
    avoid_genres: Sequence[Any] | None,
) -> bool:
    avoided = expand_genres(avoid_genres)
    if not avoided:
        return False
    return any(genre_matches_any(tag_name, avoided) for tag_name in payload_tag_names(payload))


def vector_array(vector: VectorLike | dict[str, Any] | None) -> FloatVector | None:
    if vector is None:
        return None
    if isinstance(vector, dict):
        vector = next(iter(vector.values()), None)
        if vector is None:
            return None
    arr = np.asarray(vector, dtype=np.float32)
    return arr.reshape(-1) if arr.ndim != 1 else arr


def cosine_similarity(left: VectorLike | dict[str, Any] | None, right: VectorLike | dict[str, Any] | None) -> float:
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

def blended_candidate_score(
    point: models.ScoredPoint,
    current_vector: VectorLike | None,
    preference_matrix: MatrixLike | None,
    avoid_matrix: MatrixLike | None,
    query_similarity_weight: float,
    continuity_similarity_weight: float,
    preference_similarity_weight: float,
    avoid_similarity_weight: float,
) -> float:
    query_score = float(point.score or 0.0)
    continuity_score = cosine_similarity(point.vector, current_vector)
    avoid_score = max(0.0, max_matrix_similarity(point.vector, avoid_matrix))
    like_score = max(0.0, max_matrix_similarity(point.vector, preference_matrix))
    total_weight = query_similarity_weight + continuity_similarity_weight
    if total_weight <= 0:
        base_score = query_score
    else:
        base_score = (
            query_similarity_weight * query_score
            + continuity_similarity_weight * continuity_score
        ) / total_weight

    return (
        base_score
        + preference_similarity_weight * like_score
        - avoid_similarity_weight * avoid_score
    )


def select_best_point(
    points: Sequence[models.ScoredPoint],
    seen_songs: set[tuple[str, str]],
    avoid_song_keys: set[tuple[str, str]] | None = None,
    avoid_genres: Sequence[Any] | None = None,
    current_vector: VectorLike | None = None,
    preference_matrix: MatrixLike | None = None,
    avoid_matrix: MatrixLike | None = None,
    query_similarity_weight: float = 1.0,
    continuity_similarity_weight: float = 0.0,
    preference_similarity_weight: float = 0.0,
    avoid_similarity_weight: float = 0.0,
    candidate_score_threshold: float | None = None,
    continuity_min_similarity: float | None = None,
    avoid_hard_similarity_threshold: float | None = None,
) -> models.ScoredPoint | None:
    highest: models.ScoredPoint | None = None
    highest_score = float("-inf")

    for point in points:
        song_key = get_song_key(point.payload or {})
        if song_key in seen_songs or song_key in (avoid_song_keys or set()):
            continue
        if payload_matches_avoided_genres(point.payload, avoid_genres):
            continue

        avoid_similarity = max(0.0, max_matrix_similarity(point.vector, avoid_matrix))
        if (
            avoid_hard_similarity_threshold is not None
            and avoid_similarity >= avoid_hard_similarity_threshold
        ):
            continue

        continuity_score = cosine_similarity(point.vector, current_vector)
        if (
            continuity_min_similarity is not None
            and continuity_score < continuity_min_similarity
        ):
            continue

        score = blended_candidate_score(
            point,
            current_vector,
            preference_matrix,
            avoid_matrix,
            query_similarity_weight,
            continuity_similarity_weight,
            preference_similarity_weight,
            avoid_similarity_weight,
        )
        if (
            candidate_score_threshold is not None
            and score < candidate_score_threshold
        ):
            continue

        if highest is None or score > highest_score:
            highest = point
            highest_score = score

    return highest


def find_next_point(
    client: QdrantClient,
    collection_name: str,
    query_vector: VectorLike,
    current_vector: VectorLike,
    preference_matrix: MatrixLike,
    avoid_matrix: MatrixLike,
    history_ids: set[PointId],
    seen_songs: set[tuple[str, str]],
    avoid_song_keys: set[tuple[str, str]],
    avoid_genres: Sequence[Any] | None,
    query_similarity_weight: float,
    continuity_similarity_weight: float,
    preference_similarity_weight: float,
    avoid_similarity_weight: float,
    initial_suggestion_limit: int,
    suggestion_limit_step: int,
    max_suggestion_limit: int,
    candidate_score_threshold: float,
    candidate_score_fallback_limit: int,
    continuity_min_similarity: float | None,
    avoid_hard_similarity_threshold: float | None,
) -> models.ScoredPoint | None:
    threshold_search_limit = max(
        1,
        min(max_suggestion_limit, candidate_score_fallback_limit),
    )
    limit = max(1, min(initial_suggestion_limit, threshold_search_limit))
    fallback: models.ScoredPoint | None = None

    while True:
        suggestions = query_similar_points(
            client=client,
            collection_name=collection_name,
            query_vector=query_vector,
            history_ids=history_ids,
            limit=limit,
            with_vectors=True,
        )

        if suggestions:
            best = select_best_point(
                suggestions,
                seen_songs,
                avoid_song_keys,
                avoid_genres,
                current_vector,
                preference_matrix,
                avoid_matrix,
                query_similarity_weight,
                continuity_similarity_weight,
                preference_similarity_weight,
                avoid_similarity_weight,
                candidate_score_threshold=candidate_score_threshold,
                continuity_min_similarity=continuity_min_similarity,
                avoid_hard_similarity_threshold=avoid_hard_similarity_threshold,
            )
            if best is not None:
                return best

            fallback_best = select_best_point(
                suggestions,
                seen_songs,
                avoid_song_keys,
                avoid_genres,
                current_vector,
                preference_matrix,
                avoid_matrix,
                query_similarity_weight,
                continuity_similarity_weight,
                preference_similarity_weight,
                avoid_similarity_weight,
                candidate_score_threshold=None,
                continuity_min_similarity=continuity_min_similarity,
                avoid_hard_similarity_threshold=avoid_hard_similarity_threshold,
            )
            if fallback_best is not None:
                fallback = fallback_best

        if limit >= threshold_search_limit:
            break

        limit = min(
            limit + max(1, suggestion_limit_step),
            threshold_search_limit,
        )

    return fallback

def parseRecommendation(recommendation_speed):
    mapping = {
        "slow": 20,
        "regular": 10,
        "quick": 5,
    }
    return mapping.get(recommendation_speed, 10)
def run_recommendation_chain(
    client: QdrantClient,
    collection_name: str,
    start_vector: VectorLike,
    end_vector: VectorLike,
    preference_vector: MatrixLike,
    recommendation_speed: str,
    avoid_vector: MatrixLike | None,
    seen_songs: set[tuple[str, str]],
    avoid_song_keys: set[tuple[str, str]] | None = None,
    avoid_genres: Sequence[Any] | None = None,
    iterations: int = ITERATIONS,
    alpha: float = ALPHA,
    query_update_mode: str = QUERY_UPDATE_MODE,
    endpoint_scale: int | float = SCALE_ENDPOINTS,
    preference_scale: float = PREFERENCE_SCALE,
    query_similarity_weight: float = QUERY_SIMILARITY_WEIGHT,
    continuity_similarity_weight: float = CONTINUITY_SIMILARITY_WEIGHT,
    avoid_similarity_weight: float = AVOID_SIMILARITY_WEIGHT,
    initial_suggestion_limit: int = INITIAL_SUGGESTION_LIMIT,
    suggestion_limit_step: int = SUGGESTION_LIMIT_STEP,
    max_suggestion_limit: int = MAX_SUGGESTION_LIMIT,
    candidate_score_threshold: float = CANDIDATE_SCORE_THRESHOLD,
    candidate_score_fallback_limit: int = CANDIDATE_SCORE_FALLBACK_LIMIT,
    continuity_min_similarity: float | None = CONTINUITY_MIN_SIMILARITY,
    avoid_hard_similarity_threshold: float | None = AVOID_HARD_SIMILARITY_THRESHOLD,
) -> list[models.ScoredPoint]:
    history: list[models.ScoredPoint] = []
    history_ids: set[PointId] = set()
    current_vector = vector_array(start_vector)
    if current_vector is None:
        return history
    avoid_vector = (
        np.zeros((current_vector.size, 1), dtype=np.float32)
        if avoid_vector is None
        else matrix_array(avoid_vector, current_vector.size)
    )
    if avoid_vector is None:
        avoid_vector = np.zeros((current_vector.size, 1), dtype=np.float32)

    preference_vector = matrix_array(preference_vector, current_vector.size)
    if preference_vector is None:
        preference_vector = np.zeros((current_vector.size, 1), dtype=np.float32)

    query_vector: FloatVector = current_vector * endpoint_scale
    step_count = parseRecommendation(recommendation_speed)
    avoid_song_keys = avoid_song_keys or set()
    for step_index in range(step_count):
        highest = find_next_point(
            client=client,
            collection_name=collection_name,
            query_vector=query_vector,
            current_vector=current_vector,
            preference_matrix=preference_vector,
            avoid_matrix=avoid_vector,
            history_ids=history_ids,
            seen_songs=seen_songs,
            avoid_song_keys=avoid_song_keys,
            avoid_genres=avoid_genres,
            query_similarity_weight=query_similarity_weight,
            continuity_similarity_weight=continuity_similarity_weight,
            preference_similarity_weight=preference_scale,
            avoid_similarity_weight=avoid_similarity_weight,
            initial_suggestion_limit=initial_suggestion_limit,
            suggestion_limit_step=suggestion_limit_step,
            max_suggestion_limit=max_suggestion_limit,
            candidate_score_threshold=candidate_score_threshold,
            candidate_score_fallback_limit=candidate_score_fallback_limit,
            continuity_min_similarity=continuity_min_similarity,
            avoid_hard_similarity_threshold=avoid_hard_similarity_threshold,
        )
        if highest is None:
            break

        song_key = get_song_key(highest.payload or {})
        seen_songs.add(song_key)
        history.append(highest)
        history_ids.add(highest.id)
        next_current_vector = vector_array(highest.vector)
        if next_current_vector is None:
            break
        current_vector = next_current_vector

        query_vector = build_next_query(
            mode=query_update_mode,
            step_index=step_index,
            total_steps=step_count,
            start_vector=start_vector,
            end_vector=end_vector,
            chosen_vector=current_vector,
            alpha_value=alpha,
            endpoint_scale=endpoint_scale,
            preference_matrix=preference_vector,
            avoid_matrix=avoid_vector,
            preference_scale=preference_scale,
            avoid_scale=avoid_similarity_weight,
        )
        log(
            f"Iteration {step_index + 1}/{step_count}: "
            f"{get_title_from_payload(highest.payload) or '?'} - "
            f"{highest.payload.get('artist', '?')}"
        )

    return history


def build_results(history: Sequence[models.ScoredPoint]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []

    for point in history:
        payload = point.payload
        results.append(
            {
                "title": get_title_from_payload(payload),
                "artist": payload.get("artist", ""),
                "tags": payload.get("tags", []),
            }
        )

    return results

def get_wav_from_name(song: dict[str, str], created_files: set[Path]) -> FloatVector | None:
    title = song.get("name") or song.get("title")
    artist = song.get("artist")
    if not title or not artist:
        return None

    normalized_song = {
        "name": title,
        "artist": artist,
    }
    yt_res = search_youtube_url(normalized_song["name"], normalized_song["artist"])
    if yt_res is None:
        return None

    wav, meta = get_mp3_from_url(yt_res["url"], normalized_song, created_files)
    return (meta["filename"], wav) if wav is not None and meta is not None else None


def embed_song_from_name(
    song: dict[str, str],
    model: ClapModel,
    processor: ClapProcessor,
    device: str,
    created_files: set[Path],
) -> tuple[str, FloatVector] | None:
    wav_tup = get_wav_from_name(song, created_files)
    if wav_tup is None:
        return None
    (filename, wav) = wav_tup

    input = processor(audio=wav, sampling_rate=48000, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        return (filename, model.get_audio_features(**input).pooler_output[0].cpu().numpy())


def normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


# {
#   tracks: [
#     {
#       title: "Song title",
#       artist: "Artist name",
#       genre: "Genre or tag",
#       youtubeUrl: "https://youtube.com/watch?v=..."
#     }
#   ],
#   currentIndex: 0,
#   isGenerating: false
# }
# function to take above data structure and turn it into a set to detect duplicates
def queue_dict_to_set(queue: dict):
    song_set = set()
    if not isinstance(queue, dict):
        log("queue not recognized as dict")
        return set()
    for track in queue.get("tracks", []):
        title = track.get("title") or track.get("name") or ""
        artist = track.get("artist") or ""
        if title and artist:
            song_set.add((normalize(title), normalize(artist)))
    return song_set


def get_endpoint_vector(
    payload: list[models.Record] | None,
    fallback_song: dict[str, str] | None,
    model: ClapModel,
    processor: ClapProcessor,
    device: str,
    created_files: set[Path],
) -> tuple[str | None, FloatVector] | None:
    if payload:
        vector = payload[0].vector
        if isinstance(vector, dict):
            vector = next(iter(vector.values()), None)
        return None if vector is None else (None, np.asarray(vector, dtype=np.float32))

    if not fallback_song:
        return None

    embedded_song = embed_song_from_name(fallback_song, model, processor, device, created_files)
    if embedded_song is not None:
        return embedded_song

    title = fallback_song.get("name") or fallback_song.get("title")
    artist = fallback_song.get("artist")
    if not title or not artist:
        return None

    log(f"Falling back to text endpoint embedding for {title} by {artist}")
    return None, embed_text(f"{title} by {artist}", model, processor, device)

def main() -> None:
    try:
        raw = sys.stdin.read()
        preferences = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as err:
        log(f"Invalid JSON input: {err}")
        sys.exit(1)

    genres = preferences.get("genres", [])
    artists = preferences.get("artists", [])
    songs = preferences.get("songs", [])
    avoid_genres = preferences.get("avoid_genres", [])
    avoid_song_keys = songs_to_key_set(preferences.get("avoid_songs", []))
    preference_vector = np.array(
        preferences.get("preference_matrix", preferences.get("preference_vector", [])),
        dtype=np.float32,
    )
    recommendation_speed = preferences.get("recommendation_speed", "regular")
    avoid_vector = np.array(
        preferences.get("avoid_matrix", preferences.get("avoid_vector", [])),
        dtype=np.float32,
    )
    start_song = preferences.get("start_song", [])
    end_song = preferences.get("end_song", [])
    queue = preferences.get("queue", [])
    seen_songs = queue_dict_to_set(queue) if queue else set()
    seen_songs.update(songs_to_key_set([start_song, end_song]))
    if not genres and not artists and not songs and preference_vector.size == 0:
        log("At least one of genres, artists, or songs is required.")
        sys.exit(1)

    model, processor, device = load_clap_resources()
    client = create_qdrant_client()
    ensure_audio_dir()
    created_files: set[Path] = set()

    try:
        ensure_text_index(client, COLLECTION_NAME, "artist")
        ensure_text_index(client, COLLECTION_NAME, "song")
        start_payload: list[models.Record] = search_song_payload(client, COLLECTION_NAME, start_song)
        end_payload: list[models.Record] = search_song_payload(client, COLLECTION_NAME, end_song)

        start_tup = get_endpoint_vector(
            start_payload,
            start_song,
            model,
            processor,
            device,
            created_files,
        )
        if not start_tup:
            log("Error with get_endpoint_vector with start")
            return None
        (start_filename, start_vector) = start_tup
        end_tup = get_endpoint_vector(
            end_payload,
            end_song,
            model,
            processor,
            device,
            created_files,
        )
        if not end_tup:
            log("Error with get_endpoint_vector with end")
            return None
        (end_filename, end_vector) = end_tup
        if start_vector is None or end_vector is None:
            log(f"Failed to build endpoint vectors for start={start_song}, end={end_song}")
            sys.exit(1)

        if preference_vector.size == 0:
            preference_vector = np.zeros((start_vector.size, 1), dtype=np.float32)
        if avoid_vector.size == 0:
            avoid_vector = np.zeros((start_vector.size, 1), dtype=np.float32)

        history = run_recommendation_chain(
            client=client,
            collection_name=COLLECTION_NAME,
            start_vector=start_vector,
            end_vector=end_vector,
            preference_vector=preference_vector,
            recommendation_speed=recommendation_speed,
            avoid_vector=avoid_vector,
            seen_songs=seen_songs,
            avoid_song_keys=avoid_song_keys,
            avoid_genres=avoid_genres,
        )
        # each song is a map
        # { song: song title, artist: artist name, filename: name of youtube file, vector: song vector (np.array) }
        try:
            songs_list = []
            if start_filename:
                title = start_song.get("name") or start_song.get("title")
                artist = start_song.get("artist")
                songs_list.append({"song": title, "artist": artist, "filename": start_filename, "vector": start_vector})
            if end_filename:
                title = end_song.get("name") or end_song.get("title")
                artist = end_song.get("artist")
                songs_list.append({"song": title, "artist": artist, "filename": end_filename, "vector": end_vector})
            if songs_list: upload_vector(songs_list, client)
        except Exception as err:
            log(f"Did not upload vector: {err}")

        json.dump(build_results(history), sys.stdout)
        sys.stdout.flush()
    finally:
        cleanup_created_files()


if __name__ == "__main__":
    main()
