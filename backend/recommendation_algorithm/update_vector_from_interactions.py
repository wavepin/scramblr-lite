"""
Fast interaction vector delta script.
Reads a single song interaction transition from stdin JSON, looks up the
song vector in Qdrant, and writes a signed delta vector to stdout.

Input (stdin JSON):
  {
    "title": "...",
    "artist": "...",
    "previousReaction": "none" | "like" | "dislike",
    "nextReaction": "none" | "like" | "dislike"
  }

Output (stdout JSON):
  {
    "matched": true,
    "reason": null,
    "deltaVector": [ ... ]
  }
"""

import json
import os
import re
import sys
from typing import Any

import numpy as np
from qdrant_client import QdrantClient, models


QDRANT_URL = "https://e7463e3f-1d28-466a-9931-ede4a35ce4ee.us-east4-0.gcp.cloud.qdrant.io"
COLLECTION_NAME = os.getenv("QDRANT_COLLECTION_NAME", "youtubeDataset")
SEARCH_LIMIT = 25

REACTION_WEIGHTS = {
    "none": 0,
    "like": 1,
    "dislike": -1,
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def normalize_text(value: str | None) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", (value or "").lower())
    return " ".join(normalized.split())


def create_qdrant_client() -> QdrantClient:
    qdrant_api_key = os.getenv("QDRANT_API_KEY")
    if not qdrant_api_key:
        log("QDRANT_API_KEY environment variable is not set.")
        sys.exit(1)

    return QdrantClient(
        url=QDRANT_URL,
        api_key=qdrant_api_key,
    )


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


def get_vector_from_record(record: models.Record) -> np.ndarray | None:
    vector = record.vector
    if vector is None:
        return None

    if isinstance(vector, dict):
        first_vector = next(iter(vector.values()), None)
        if first_vector is None:
            return None
        return np.asarray(first_vector, dtype=np.float32)

    return np.asarray(vector, dtype=np.float32)


def search_candidate_records(
    client: QdrantClient,
    title: str,
    artist: str,
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
        limit=SEARCH_LIMIT,
    )
    return records


def find_matching_vector(
    client: QdrantClient,
    title: str,
    artist: str,
) -> np.ndarray | None:
    normalized_title = normalize_text(title)
    normalized_artist = normalize_text(artist)

    for record in search_candidate_records(client, title, artist):
        payload = record.payload or {}
        if (
            normalize_text(get_title_from_payload(payload)) != normalized_title
            or normalize_text(payload.get("artist", "")) != normalized_artist
        ):
            continue

        return get_vector_from_record(record)

    return None


def parse_reaction(raw_value: Any) -> str:
    value = str(raw_value or "none").lower()
    if value not in REACTION_WEIGHTS:
        raise ValueError(f"Unsupported reaction: {raw_value}")
    return value


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError) as err:
        log(f"Invalid JSON input: {err}")
        sys.exit(1)

    title = str(payload.get("title") or "").strip()
    artist = str(payload.get("artist") or "").strip()

    if not title or not artist:
        log("Both title and artist are required.")
        sys.exit(1)

    try:
        previous_reaction = parse_reaction(payload.get("previousReaction"))
        next_reaction = parse_reaction(payload.get("nextReaction"))
    except ValueError as err:
        log(str(err))
        sys.exit(1)

    delta_scale = REACTION_WEIGHTS[next_reaction] - REACTION_WEIGHTS[previous_reaction]
    if delta_scale == 0:
        json.dump(
            {
                "matched": False,
                "reason": "no-op",
                "deltaVector": [],
            },
            sys.stdout,
        )
        sys.stdout.flush()
        return

    client = create_qdrant_client()
    ensure_text_index(client, COLLECTION_NAME, "artist")
    ensure_text_index(client, COLLECTION_NAME, "song")

    song_vector = find_matching_vector(client, title, artist)
    if song_vector is None:
        json.dump(
            {
                "matched": False,
                "reason": "song-vector-not-found",
                "deltaVector": [],
            },
            sys.stdout,
        )
        sys.stdout.flush()
        return

    delta_vector = (song_vector * delta_scale).astype(np.float32)
    json.dump(
        {
            "matched": True,
            "reason": None,
            "deltaVector": delta_vector.tolist(),
        },
        sys.stdout,
    )
    sys.stdout.flush()


if __name__ == "__main__":
    main()
