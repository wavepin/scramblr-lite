"""
Production user preference vector script.
Reads user preferences as JSON from stdin, runs the CLAP
processing to get vector from preferences (with scaling) and returns as JSON.

Input (stdin JSON):
  { "genres": ["Jazz","Pop"], "artists": ["Adele"], "songs": [{"name":"Hello","artist":"Adele"}], "avoid_genres": ["Country"] }

Output (stdout JSON):
  [ 1.02, 390.2, ...]
"""

import json
import os
import re
import sys
from pathlib import Path
import unicodedata
import uuid

import librosa
import numpy as np
import requests
import torch
import yt_dlp
from qdrant_client import QdrantClient, models
from qdrant_client.http.models import PointStruct
from transformers import ClapModel, ClapProcessor

URL_BASE = os.getenv("URL_BASE", "http://localhost:3001/").rstrip("/") + "/"
LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/"
LASTFM_API_KEY = os.getenv("LASTFM_API_KEY")
FFMPEG_PATH = os.getenv("FFMPEG_PATH")
AUDIO_DIR = Path(__file__).resolve().parent / "_tmp_audio"
QDRANT_URL = "https://e7463e3f-1d28-466a-9931-ede4a35ce4ee.us-east4-0.gcp.cloud.qdrant.io"
COLLECTION_NAME = os.getenv("QDRANT_COLLECTION_NAME", "youtubeDataset")
DEFAULT_MATRIX_SIMILARITY_THRESHOLD = 0.65
QDRANT_LOOKUP_FAILED = False
__all__ = [
    "cleanup_created_files",
    "ensure_audio_dir",
    "get_mp3_from_url",
    "search_youtube_url",
]


def ensure_audio_dir() -> Path:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    return AUDIO_DIR


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Set {name} before running this script.")
    return value


def log(msg):
    print(msg, file=sys.stderr)


def search_youtube_url(title, artist):
    try:
        res = requests.get(
            URL_BASE + "api/search/youtubeURL",
            params={"title": title, "artist": artist},
            timeout=10,
        )
        data = res.json()
    except (requests.RequestException, ValueError):
        return None

    if not res.ok:
        return None

    return data if isinstance(data, dict) and data.get("url") else None


def create_qdrant_client() -> QdrantClient:
    qdrant_api_key: str | None = os.getenv("QDRANT_API_KEY")
    if not qdrant_api_key:
        raise RuntimeError("Set QDRANT_API_KEY before running this script.")

    return QdrantClient(
        url=QDRANT_URL,
        api_key=qdrant_api_key,
    )


def get_mp3_from_url(url: str, song, created_files: set[Path]):
    ydl_opts = {
        "format": "bestaudio/best",
        "ffmpeg_location": require_env("FFMPEG_PATH"),
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        "outtmpl": str(AUDIO_DIR / "%(title)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info = ydl.extract_info(url, download=True)
            filename = Path(ydl.prepare_filename(info)).with_suffix(".mp3")
            created_files.add(filename)
            audio, sr = librosa.load(filename, sr=48000, mono=True)
            # change this to change which part/length of the song is sampled
            start = sr * 30 #skips first 30 seconds
            end = sr * 90 #1 minute of audio after 30 seconds
            wav = audio[start:end]
            meta = {
                "path": "downloaded from survey",
                "filename": filename,
                "artist": song["artist"],
                "song": song["name"],
            }
            return wav, meta
        except Exception:
            return None, None


def lastfm_fetch(params: dict) -> dict | None:
    try:
        res = requests.get(
            LASTFM_API_URL,
            params={
                "api_key": require_env("LASTFM_API_KEY"),
                "format": "json",
                **params,
            },
            timeout=10,
        )
        data = res.json()
    except (requests.RequestException, ValueError):
        return None

    if not res.ok or not isinstance(data, dict):
        return None

    return data


def get_top_tracks_for_artist(artist_name: str, limit: int = 1) -> list[dict[str, str]] | None:
    data = lastfm_fetch({
        "method": "artist.getTopTracks",
        "artist": artist_name,
        "limit": limit,
    })
    if not data:
        log(f"Found no tracks for genre {artist_name} from LastFM")
        return None
    # log(f"Results from LastFM fetch for artist: {data}")

    tracks = data.get("toptracks", {}).get("track", [])
    if not tracks:
        tracks = data.get("toptracks", {}).get("track", [])
    if isinstance(tracks, dict):
        tracks = [tracks]

    results = []
    for track in tracks:
        name = track.get("name")
        track_artist = track.get("artist", {}).get("name", artist_name)
        if name:
            results.append({
                "name": name,
                "artist": track_artist,
            })

    return results if results else None


def get_top_tracks_for_genre(genre: str, limit: int = 1) -> list[dict[str, str]] | None:
    data = lastfm_fetch({
        "method": "tag.getTopTracks",
        "tag": genre,
        "limit": limit,
    })
    if not data:
        log(f"Found no tracks for genre {genre} from LastFM")
        return None
    # log(f"Results from LastFM fetch for genre: {data}")

    tracks = data.get("toptracks", {}).get("track", [])
    if not tracks:
        tracks = data.get("tracks", {}).get("track", [])
    if isinstance(tracks, dict):
        tracks = [tracks]

    results = []
    for track in tracks:
        name = track.get("name")
        artist_name = track.get("artist", {}).get("name")
        if name and artist_name:
            results.append({
                "name": name,
                "artist": artist_name,
            })

    return results if results else None


def cleanup_created_files() -> None:
    if not AUDIO_DIR.exists():
        return

    for path in AUDIO_DIR.iterdir():
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def normalize(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def find_local_audio(folder, artist, title):
    folder_path = Path(folder)
    if not folder_path.exists():
        return None

    artist_n = normalize(artist)
    title_n = normalize(title)

    for path in folder_path.iterdir():
        if not path.is_file() or path.suffix.lower() != ".mp3":
            continue

        name_n = normalize(path.name)
        if re.search(re.escape(artist_n), name_n) and re.search(re.escape(title_n), name_n):
            return str(path)

    return None


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


def search_payload_text(
    client: QdrantClient,
    collection_name: str,
    field_names: list[str],
    texts: list[str],
    limit: int = 20,
    with_vectors: bool = True,
) -> list[models.Record]:
    global QDRANT_LOOKUP_FAILED
    if len(field_names) != len(texts):
        raise ValueError("field_names and texts length mismatch")
    if QDRANT_LOOKUP_FAILED:
        return []

    conditions = [
        models.FieldCondition(
            key=field_name,
            match=models.MatchText(text=text),
        )
        for field_name, text in zip(field_names, texts)
        if text
    ]

    try:
        records, _ = client.scroll(
            collection_name=collection_name,
            scroll_filter=models.Filter(must=conditions),
            with_payload=True,
            with_vectors=with_vectors,
            limit=limit,
        )
    except Exception as err:
        log(f"Qdrant lookup failed for {texts}: {err}")
        QDRANT_LOOKUP_FAILED = True
        return []

    return records


def find_song_DB(song, client):
    records = search_payload_text(
        client,
        COLLECTION_NAME,
        ["song", "artist"],
        [song["name"], song["artist"]],
    )
    return records if records else None


def get_record_vector(record) -> np.ndarray | None:
    vector = record.vector
    if vector is None:
        return None

    if isinstance(vector, dict):
        if not vector:
            return None
        vector = next(iter(vector.values()))

    return np.asarray(vector, dtype=np.float32)


def get_song_vector(
    song: dict[str, str],
    client: QdrantClient,
    processor: ClapProcessor,
    model: ClapModel,
    device: str,
    created_files: set[Path],
) -> dict | None:
    
    # if song is in db, fetch it and use vector
    embeddeds = find_song_DB(song, client)
    if embeddeds:
        return {
            "vector": get_record_vector(embeddeds[0]),
            "local": False,
            "filename": None
        }
    if QDRANT_LOOKUP_FAILED:
        log(f"Skipping {song['artist']} - {song['name']} because Qdrant lookup is unavailable")
        return None

    # if song is found locally then it must have already been added, so skip
    local_file = find_local_audio(AUDIO_DIR, song["artist"], song["name"])
    if local_file is not None:
        return None

    # if youtube url is bad, skip
    yt_res = search_youtube_url(song["name"], song["artist"])
    if yt_res is None:
        return None

    # if youtube title is found locally, same as two checks up
    if find_local_audio(AUDIO_DIR, yt_res["title"], ""):
        return None

    # finally get the mp3
    wav, _meta = get_mp3_from_url(yt_res["url"], song, created_files)
    if wav is None:
        return None

    # since the song was not in the DB, we mark it so we can add it later
    input = processor(audio=wav, sampling_rate=48000, return_tensors="pt", padding=True).to(device)
    with torch.no_grad():
        return {
            "vector": model.get_audio_features(**input).pooler_output[0].cpu().numpy(),
            "local": True,
            "filename": yt_res["title"]
        }


def get_best_sim_col(
    vector: np.ndarray,
    matrix: np.ndarray,
    similarity_threshold: float = DEFAULT_MATRIX_SIMILARITY_THRESHOLD,
) -> int:
    dots = vector @ matrix
    denominators = np.linalg.norm(vector) * np.linalg.norm(matrix, axis=0)
    sims = np.divide(
        dots,
        denominators,
        out=np.zeros_like(dots, dtype=np.float32),
        where=denominators > 0,
    )
    if sims.size == 0 or np.max(sims) < similarity_threshold:
        return -1
    return int(np.argmax(sims))


def add_song_vectors(
    matrix: np.ndarray,
    songs: list[dict[str, str]],
    weight: int,
    client: QdrantClient,
    processor: ClapProcessor,
    model: ClapModel,
    device: str,
    created_files: set[Path],
    similarity_threshold: float = DEFAULT_MATRIX_SIMILARITY_THRESHOLD,
) -> tuple[np.ndarray, list]:
    # returns saved, list of maps for each song that is not in the database
    saved = []
    log(f"{songs} in add/subtract song vectors")
    for song in songs:
        try:
            song_dict = get_song_vector(song, client, processor, model, device, created_files)
        except Exception as err:
            log(f"Skipping {song.get('artist', '?')} - {song.get('name', '?')}: {err}")
            continue
        if song_dict is None:
            continue
        song_vector = song_dict["vector"]
        if song_dict["local"]:
            saved.append({
                "song": song["name"],
                "artist": song["artist"],
                "filename": song_dict["filename"],
                "vector": song_vector,
            })
        (_, cols) = matrix.shape
        vector = np.asarray(song_vector, dtype=np.float32).reshape(-1)
        if cols == 1 and np.all(matrix == 0):
            matrix[:, 0] += weight * vector
        else:
            max_sim_idx = get_best_sim_col(
                vector=vector,
                matrix=matrix,
                similarity_threshold=similarity_threshold,
            )
            if max_sim_idx == -1:
                matrix = np.concatenate([matrix, vector.reshape(-1, 1)], axis=1)
            else:
                matrix[:, max_sim_idx] += weight * vector
        
        log(f"Added {song['name']} to the vector")
    return matrix, saved


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


def upload_vector(songs: list[map], client: QdrantClient):
    # each song is a map
    # { song: song title, artist: artist name, filename: name of youtube file, vector: song vector (np.array) }
    payload = [
        {
        "path": "None",
        "filename": song["filename"],
        "artist": song["artist"],
        "song": song["song"],
        "url": search_youtube_url(song["song"], song["artist"]) #it wants to autocomplete with ["url"] after this, but I'm unsure that's neccessary
        } for song in songs
    ]
    points = [
        PointStruct(
            id = make_id(song["artist"], song["song"]),
            vector=song["vector"].astype(float).tolist(),
            payload=load
        )
        for (song, load) in zip(songs, payload)
    ]
    client.upsert(
        collection_name=COLLECTION_NAME,
        wait=True,
        points=points
    )
    log(f"{payload} have been uploaded to DB")

def main():
    try:
        raw = sys.stdin.read()
        preferences = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        log(f"Invalid JSON input: {e}")
        sys.exit(1)

    genres = preferences.get("genres", [])
    artists = preferences.get("artists", [])
    songs = preferences.get("songs", [])
    avoid_genres = preferences.get("avoid_genres", [])
    if not genres or not artists or not songs or not avoid_genres:
        log("All of genres, artists, songs, and avoid_genres are required.")
        sys.exit(1)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"Loading CLAP model on {device}...")
    model = ClapModel.from_pretrained("laion/larger_clap_music", local_files_only=False).to(device)
    processor = ClapProcessor.from_pretrained("laion/larger_clap_music")
    model.eval()
    log("Model loaded.")

    qdrant_client = create_qdrant_client()
    ensure_text_index(qdrant_client, COLLECTION_NAME, "artist")
    ensure_text_index(qdrant_client, COLLECTION_NAME, "song")

    pref_matrix = np.zeros((512, 1), dtype=np.float32)
    avoid_matrix = np.zeros((512, 1), dtype=np.float32)
    ensure_audio_dir()
    created_files: set[Path] = set()
    expanded_songs = list(songs)
    avoided_songs: list[dict[str, str]] = []

    for genre in genres:
        tracks = get_top_tracks_for_genre(genre, limit=5)
        log(f"{tracks} found for genre")
        if tracks:
            for track in tracks:
                if track not in expanded_songs:
                    log(f"{track} added for genre")
                    expanded_songs.append(track)
            continue

        # with torch.no_grad():
        #     input = processor(text=[genre], return_tensors="pt").to(device)
        #     vector += model.get_text_features(**input).pooler_output[0].cpu().numpy()

    for genre in avoid_genres:
        tracks = get_top_tracks_for_genre(genre, limit=5)
        log(f"{tracks} found for avoid genre")
        if tracks:
            for track in tracks:
                if track not in avoided_songs:
                    log(f"{track} added for avoid genre")
                    avoided_songs.append(track)
            continue

        # with torch.no_grad():
        #     input = processor(text=[genre], return_tensors="pt").to(device)
        #     vector -= model.get_text_features(**input).pooler_output[0].cpu().numpy()

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
        pref_matrix, songs_list = add_song_vectors(
            pref_matrix,
            expanded_songs,
            1,
            qdrant_client,
            processor,
            model,
            device,
            created_files,
        )

        avoid_matrix, avoid_songs_list = add_song_vectors(
            avoid_matrix,
            avoided_songs,
            1,
            qdrant_client,
            processor,
            model,
            device,
            created_files,
        )

        try:
            if songs_list: upload_vector(songs_list, qdrant_client)
        except:
            log("Did not upload vector")
    finally:
        output = {
            "preference_matrix": pref_matrix.tolist(),
            "avoid_matrix": avoid_matrix.tolist()
        }
        log(output)
        json.dump(output, sys.stdout)
        sys.stdout.flush()
        cleanup_created_files()


if __name__ == "__main__":
    main()
