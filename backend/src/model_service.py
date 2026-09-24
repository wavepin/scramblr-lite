# backend/model_service.py
import json
from pathlib import Path
import sys
from typing import Any, Sequence, TypeAlias
from numpy.typing import NDArray
from qdrant_client import QdrantClient, models

RECOMMENDATION_DIR = Path(__file__).resolve().parents[1] / "recommendation_algorithm"
sys.path.insert(0, str(RECOMMENDATION_DIR))

from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from recommend import (
    build_results,
    create_qdrant_client,
    ensure_audio_dir,
    ensure_text_index,
    get_endpoint_vector,
    queue_dict_to_set,
    songs_to_key_set,
    run_recommendation_chain,
    search_song_payload,
    log,
    cleanup_created_files,
    upload_vector
)

from update_vector_from_interactions import (
    parse_reaction,
    find_matching_vector
)

from get_vector_from_preferences import (
    get_top_tracks_for_genre,
    get_top_tracks_for_artist,
    add_song_vectors,
)

from recommend_playlist import (
    normalize_song,
    resolve_song_vector,
    get_song_key_from_values,
    run_playlist_chain,
    cleanup_audio_dir
)

import numpy as np

from fastapi import FastAPI, HTTPException
from transformers import ClapModel, ClapProcessor
import torch
import os

app = FastAPI()

model = None
processor = None
device = None
client = None

FloatVector: TypeAlias = NDArray[np.floating[Any]]
VectorLike: TypeAlias = Sequence[float] | FloatVector
PointId: TypeAlias = models.ExtendedPointId

def normalize_vector(vector: VectorLike) -> FloatVector:
    vector = np.asarray(vector, dtype=np.float32)
    norm = np.linalg.norm(vector)
    if norm == 0 or not np.isfinite(norm):
        return vector
    return vector / norm


def get_best_delta_col(delta_vector: FloatVector, matrix: FloatVector) -> int:
    dots = delta_vector @ matrix
    denominators = np.linalg.norm(delta_vector) * np.linalg.norm(matrix, axis=0)
    sims = np.divide(
        dots,
        denominators,
        out=np.zeros_like(dots, dtype=np.float32),
        where=denominators > 0,
    )
    if sims.size == 0:
        return -1

    best_idx = int(np.argmax(np.abs(sims)))
    return (
        best_idx
        if abs(float(sims[best_idx])) >= MATRIX_SIMILARITY_THRESHOLD
        else -1
    )


def add_vector_to_matrix(
    matrix: FloatVector,
    vector: VectorLike,
    weight: float = 1.0,
) -> FloatVector:
    vector = np.asarray(vector, dtype=np.float32).reshape(-1)
    if matrix.ndim != 2 or matrix.shape[0] != vector.shape[0]:
        return matrix

    if matrix.shape[1] == 1 and np.all(matrix == 0):
        matrix[:, 0] += weight * vector
        return matrix

    idx = get_best_delta_col(vector, matrix)
    if idx == -1:
        return np.concatenate([matrix, (weight * vector).reshape(-1, 1)], axis=1)

    matrix[:, idx] += weight * vector
    return matrix


def add_text_to_matrix(matrix: FloatVector, text: str) -> FloatVector:
    if not text:
        return matrix
    with torch.no_grad():
        encoded = processor(text=[text], return_tensors="pt").to(device)
        text_vector = model.get_text_features(**encoded).pooler_output[0].cpu().numpy()
    return add_vector_to_matrix(matrix, text_vector)

QDRANT_URL = "https://e7463e3f-1d28-466a-9931-ede4a35ce4ee.us-east4-0.gcp.cloud.qdrant.io"
COLLECTION_NAME = os.getenv("QDRANT_COLLECTION_NAME", "youtubeDataset")
MODEL_NAME = "laion/larger_clap_music"

ITERATIONS = 10
QUERY_UPDATE_MODE = "legacy"
SCALE_ENDPOINTS = 1

# ------ tuning numbers -----
PREFERENCE_SCALE = 0.6
AVOID_SIMILARITY_WEIGHT = 0.6
AVOID_HARD_SIMILARITY_THRESHOLD = None
ALPHA = 0.2
QUERY_SIMILARITY_WEIGHT = 0.55
CONTINUITY_SIMILARITY_WEIGHT = 0.35
CONTINUITY_MIN_SIMILARITY = 0.0

# below this threshold makes a new column
MATRIX_SIMILARITY_THRESHOLD = 0.95

# when selecting from qdrant candidates after blended scoring
CANDIDATE_SCORE_THRESHOLD = 0.0
CANDIDATE_SCORE_FALLBACK_LIMIT = 150
# ---------------------------

INITIAL_SUGGESTION_LIMIT = 10
SUGGESTION_LIMIT_STEP = 10
MAX_SUGGESTION_LIMIT = 200
SEARCH_LIMIT = 25
PLAYLIST_BRIDGE_COUNT = 10

REACTION_WEIGHTS = {
    "none": 0,
    "like": 1,
    "dislike": -1,
}

@app.on_event("startup")
def startup():
    global model, processor, device, client
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ClapModel.from_pretrained("laion/larger_clap_music").to(device)
    processor = ClapProcessor.from_pretrained("laion/larger_clap_music")
    model.eval()
    client = create_qdrant_client()

@app.post("/generate-playlist")
def generate_playlist(payload: dict):
    try:
        start_song = normalize_song(payload.get("startSong"), "startSong")
        end_song = normalize_song(payload.get("endSong"), "endSong")
        bridge_count = int(payload.get("bridgeCount") or PLAYLIST_BRIDGE_COUNT)
        preference_matrix = np.asarray(
            payload.get("preference_matrix", payload.get("preference_vector", [])),
            dtype=np.float32,
        )
        avoid_matrix = np.asarray(
            payload.get("avoid_matrix", payload.get("avoid_vector", [])),
            dtype=np.float32,
        )
    except (json.JSONDecodeError, TypeError, ValueError) as err:
        log(f"Invalid playlist input: {err}")
        return

    if bridge_count < 1 or bridge_count > 25:
        log("bridgeCount must be between 1 and 25.")
        return

    client = create_qdrant_client()
    ensure_text_index(client, COLLECTION_NAME, "artist")
    ensure_text_index(client, COLLECTION_NAME, "song")

    model_state: dict[str, Any] = {}

    try:
        start_vector, start_id = resolve_song_vector(
            client,
            start_song,
            {"resources": (model, processor, device)},
        )
        end_vector, end_id = resolve_song_vector(
            client,
            end_song,
            {"resources": (model, processor, device)},
        )

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
            preference_vector=preference_matrix,
            avoid_vector=avoid_matrix,
        )
    except RuntimeError as err:
        log(str(err))
        cleanup_audio_dir()
        return

    cleanup_audio_dir()
    return build_results(history)

@app.post("/process-preferences")
def process_preferences(payload: dict):
    try:
        preferences = payload
    except (json.JSONDecodeError, ValueError) as e:
        log(f"Invalid JSON input: {e}")
        return

    genres = preferences.get("genres", [])
    artists = preferences.get("artists", [])
    songs = preferences.get("songs", [])
    avoid_genres = preferences.get("avoid_genres", [])
    if not genres or not artists or not songs or not avoid_genres:
        log("All of genres, artists, songs, and avoid_genres are required.")
        return

    qdrant_client = client
    try:
        ensure_text_index(qdrant_client, COLLECTION_NAME, "artist")
        ensure_text_index(qdrant_client, COLLECTION_NAME, "song")
    except Exception as err:
        log(f"Qdrant text index setup failed; continuing with available vectors: {err}")

    pref_matrix = np.zeros((512, 1), dtype=np.float32)
    avoid_matrix = np.zeros((512, 1), dtype=np.float32)
    ensure_audio_dir()
    created_files: set[Path] = set()
    expanded_songs = list(songs)
    avoided_songs: list[dict[str, str]] = []

    for genre in genres:
        # pref_matrix = add_text_to_matrix(pref_matrix, genre)
        tracks = get_top_tracks_for_genre(genre, limit=5)
        log(f"{tracks} found for genre")
        if tracks:
            for track in tracks:
                if track not in expanded_songs:
                    log(f"{track} added for genre")
                    expanded_songs.append(track)
            continue

    for genre in avoid_genres:
        # avoid_matrix = add_text_to_matrix(avoid_matrix, genre)
        tracks = get_top_tracks_for_genre(genre, limit=5)
        log(f"{tracks} found for avoid genre")
        if tracks:
            for track in tracks:
                if track not in avoided_songs:
                    log(f"{track} added for avoid genre")
                    avoided_songs.append(track)
            continue

    for artist in artists:
        artist_name = artist["name"] if isinstance(artist, dict) else artist
        tracks = get_top_tracks_for_artist(artist_name, limit=3)
        log(f"{tracks} found for artist")
        if tracks:
            for track in tracks:
                if track not in expanded_songs:
                    log(f"{track} appended for artist")
                    expanded_songs.append(track)

    try:
        try:
            pref_matrix, songs_list = add_song_vectors(
                pref_matrix,
                expanded_songs,
                1,
                qdrant_client,
                processor,
                model,
                device,
                created_files,
                similarity_threshold=MATRIX_SIMILARITY_THRESHOLD,
            )
        except Exception as err:
            log(f"Preference song vector expansion failed: {err}")
            songs_list = []

        try:
            avoid_matrix, _avoid_songs_list = add_song_vectors(
                avoid_matrix,
                avoided_songs,
                1,
                qdrant_client,
                processor,
                model,
                device,
                created_files,
                similarity_threshold=MATRIX_SIMILARITY_THRESHOLD,
            )
        except Exception as err:
            log(f"Avoid song vector expansion failed: {err}")

        try:
            if songs_list: upload_vector(songs_list, qdrant_client)
        except:
            log("Did not upload vector")
    finally:
        log(pref_matrix)
        log(avoid_matrix)
        log(f"pref_matrix: {pref_matrix.shape}\navoid_matrix: {avoid_matrix.shape}")
        cleanup_created_files()
    return {
        "preference_matrix": pref_matrix.tolist(),
        "avoid_matrix": avoid_matrix.tolist(),
    }

@app.post("/update-preferences")
def update_preferences(payload: dict):
    title = str(payload.get("title") or "").strip()
    artist = str(payload.get("artist") or "").strip()

    if not title or not artist:
        log("Both title and artist are required.")
        return

    try:
        previous_reaction = parse_reaction(payload.get("previousReaction"))
        next_reaction = parse_reaction(payload.get("nextReaction"))
    except ValueError as err:
        log(str(err))
        return

    preference_delta_scale = int(next_reaction == "like") - int(previous_reaction == "like")
    avoid_delta_scale = int(next_reaction == "dislike") - int(previous_reaction == "dislike")

    if preference_delta_scale == 0 and avoid_delta_scale == 0:
        return {
            "matched": False,
            "reason": "no-op",
            "preferenceDeltaVector": [],
            "avoidDeltaVector": [],
        }

    ensure_text_index(client, COLLECTION_NAME, "artist")
    ensure_text_index(client, COLLECTION_NAME, "song")

    song_vector = find_matching_vector(client, title, artist)
    if song_vector is None:
        return {
            "matched": False,
            "reason": "song-vector-not-found",
            "preferenceDeltaVector": [],
            "avoidDeltaVector": [],
        }

    preference_delta_vector = ((song_vector * preference_delta_scale)).astype(np.float32)
    avoid_delta_vector = (song_vector * avoid_delta_scale).astype(np.float32)
    preference_delta_vector = preference_delta_vector
    avoid_delta_vector = avoid_delta_vector
    return {
        "matched": True,
        "reason": None,
        "preferenceDeltaVector": preference_delta_vector.tolist(),
        "avoidDeltaVector": avoid_delta_vector.tolist(),
    }


@app.post("/apply-delta-vector")
def add_deltas(payload: dict):
    matrix = payload.get("matrix", [])
    delta_vector = payload.get("delta_vector", [])

    matrix = np.asarray(matrix, dtype=np.float32)
    delta_vector = np.asarray(delta_vector, dtype=np.float32).reshape(-1)

    if matrix.ndim != 2:
        raise HTTPException(status_code=400, detail="matrix must be 2D.")
    if delta_vector.ndim != 1 or matrix.shape[0] != delta_vector.shape[0]:
        raise HTTPException(
            status_code=400,
            detail="delta_vector length must match matrix rows.",
        )

    idx = get_best_delta_col(delta_vector, matrix)
    if idx == -1:
        matrix = np.concatenate([matrix, delta_vector.reshape(-1, 1)], axis=1)
    else:
        matrix[:, idx] += delta_vector

    return matrix.tolist()

@app.post("/recommend")
def recommend(payload: dict):
    try:
        preferences = payload
    except (json.JSONDecodeError, ValueError) as err:
        log(f"Invalid JSON input: {err}")
        return

    genres = preferences.get("genres", [])
    artists = preferences.get("artists", [])
    songs = preferences.get("songs", [])
    avoid_genres = preferences.get("avoid_genres", [])
    avoid_song_keys = songs_to_key_set(preferences.get("avoid_songs", []))
    preference_matrix = np.array(
        preferences.get("preference_matrix", preferences.get("preference_vector", [])),
        dtype=np.float32,
    )
    avoid_matrix = np.array(
        preferences.get("avoid_matrix", preferences.get("avoid_vector", [])),
        dtype=np.float32,
    )
    recommendation_speed = preferences.get("recommendation_speed", "regular")
    start_song = preferences.get("start_song", [])
    end_song = preferences.get("end_song", [])
    queue = preferences.get("queue", [])
    seen_songs = queue_dict_to_set(queue) if queue else set()
    seen_songs.update(songs_to_key_set([start_song, end_song]))
    if not genres and not artists and not songs and preference_matrix.size == 0:
        log("At least one of genres, artists, or songs is required.")
        return

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
            message = f"Could not build endpoint vector for start song: {start_song}"
            log(message)
            raise HTTPException(status_code=502, detail=message)
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
            message = f"Could not build endpoint vector for end song: {end_song}"
            log(message)
            raise HTTPException(status_code=502, detail=message)
        (end_filename, end_vector) = end_tup
        if start_vector is None or end_vector is None:
            message = f"Failed to build endpoint vectors for start={start_song}, end={end_song}"
            log(message)
            raise HTTPException(status_code=502, detail=message)

        if preference_matrix.size == 0:
            preference_matrix = np.zeros((start_vector.size, 1), dtype=np.float32)
        if avoid_matrix.size == 0:
            avoid_matrix = np.zeros((start_vector.size, 1), dtype=np.float32)

        history = run_recommendation_chain(
            client=client,
            collection_name=COLLECTION_NAME,
            start_vector=start_vector,
            end_vector=end_vector,
            preference_vector=preference_matrix,
            avoid_vector=avoid_matrix,
            recommendation_speed=recommendation_speed,
            seen_songs=seen_songs,
            avoid_song_keys=avoid_song_keys,
            avoid_genres=avoid_genres,
            iterations=ITERATIONS,
            alpha=ALPHA,
            query_update_mode=QUERY_UPDATE_MODE,
            endpoint_scale=SCALE_ENDPOINTS,
            preference_scale=PREFERENCE_SCALE,
            query_similarity_weight=QUERY_SIMILARITY_WEIGHT,
            continuity_similarity_weight=CONTINUITY_SIMILARITY_WEIGHT,
            avoid_similarity_weight=AVOID_SIMILARITY_WEIGHT,
            initial_suggestion_limit=INITIAL_SUGGESTION_LIMIT,
            suggestion_limit_step=SUGGESTION_LIMIT_STEP,
            max_suggestion_limit=MAX_SUGGESTION_LIMIT,
            candidate_score_threshold=CANDIDATE_SCORE_THRESHOLD,
            candidate_score_fallback_limit=CANDIDATE_SCORE_FALLBACK_LIMIT,
            continuity_min_similarity=CONTINUITY_MIN_SIMILARITY,
            avoid_hard_similarity_threshold=AVOID_HARD_SIMILARITY_THRESHOLD,
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
        except:
            log("Did not upload vector")
    finally:
        cleanup_created_files()

    return build_results(history)
