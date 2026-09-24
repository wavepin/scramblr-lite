import os
from pathlib import Path
from pprint import pprint
from typing import Any, Sequence, TypeAlias

import numpy as np
import torch
from dotenv import load_dotenv
from numpy.typing import NDArray
from qdrant_client import QdrantClient, models
from transformers import ClapModel, ClapProcessor


FloatVector: TypeAlias = NDArray[np.floating[Any]]
VectorLike: TypeAlias = Sequence[float] | FloatVector
PointId: TypeAlias = models.ExtendedPointId

QDRANT_URL: str = "https://e7463e3f-1d28-466a-9931-ede4a35ce4ee.us-east4-0.gcp.cloud.qdrant.io"
COLLECTION_NAME: str = "youtubeDataset"
MODEL_NAME: str = "laion/larger_clap_music"

START_PROMPT: str = "katy perry christmas song cozy"
END_PROMPT: str = "english hardcore christian rock demon"

ITERATIONS: int = 10
# ALPHA: float = 0.1266466 # for legacy
ALPHA: float = 0.2 # for interpolate
QUERY_UPDATE_MODE: str = "legacy"
SCALE_ENDPOINTS: int = 2
SEED_LIMIT: int = 10
INITIAL_SUGGESTION_LIMIT: int = 50
SUGGESTION_LIMIT_STEP: int = 10
MAX_SUGGESTION_LIMIT: int = 200


def load_environment() -> None:
    os.environ.pop("HF_HUB_OFFLINE", None)
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")


def create_qdrant_client() -> QdrantClient:
    qdrant_api_key: str | None = os.getenv("QDRANT_API_KEY")
    if not qdrant_api_key:
        raise RuntimeError("Set QDRANT_API_KEY before running this script.")

    return QdrantClient(
        url=QDRANT_URL,
        api_key=qdrant_api_key,
    )


def load_clap_resources() -> tuple[ClapModel, ClapProcessor, str]:
    device: str = "cuda" if torch.cuda.is_available() else "cpu"
    model: ClapModel = ClapModel.from_pretrained(MODEL_NAME, local_files_only=False).to(device)
    processor: ClapProcessor = ClapProcessor.from_pretrained(MODEL_NAME)
    model.eval()
    print("Model loaded on " + device)
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
    field_name: str,
    text: str,
    limit: int = 20,
    with_vectors: bool = True,
) -> list[models.Record]:
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
    return records


def build_next_query(
    mode: str,
    step_index: int,
    total_steps: int,
    start_vector: VectorLike,
    end_vector: VectorLike,
    chosen_vector: VectorLike,
    alpha_value: float,
    endpoint_scale: int | float,
) -> FloatVector:
    scaled_start: FloatVector = np.array(start_vector) * endpoint_scale
    scaled_end: FloatVector = np.array(end_vector) * endpoint_scale

    if mode == "legacy":
        return (scaled_end - np.array(chosen_vector)) * alpha_value + np.array(chosen_vector)

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


def query_similar_points(
    client: QdrantClient,
    collection_name: str,
    query_vector: VectorLike,
    history_ids: set[PointId] | None = None,
    limit: int = 10,
    with_vectors: bool = True,
) -> list[models.ScoredPoint]:
    return client.query_points(
        collection_name=collection_name,
        query=query_vector,
        query_filter=build_query_filter(history_ids or set()),
        with_payload=True,
        with_vectors=with_vectors,
        limit=limit,
    ).points


def print_seed_result(label: str, points: Sequence[models.ScoredPoint]) -> None:
    if not points:
        print(f"No {label} seed results.")
        return

    print(f"{label} seed:")
    pprint(points[0].model_dump(exclude={"vector"}))
    print()


def select_best_point(points: Sequence[models.ScoredPoint]) -> models.ScoredPoint | None:
    if not points:
        return None
    return max(points, key=lambda point: point.score)


def find_next_point(
    client: QdrantClient,
    collection_name: str,
    query_vector: VectorLike,
    history_ids: set[PointId],
) -> models.ScoredPoint | None:
    limit: int = INITIAL_SUGGESTION_LIMIT
    fallback: models.ScoredPoint | None = None

    while limit <= MAX_SUGGESTION_LIMIT:
        suggestions: list[models.ScoredPoint] = query_similar_points(
            client=client,
            collection_name=collection_name,
            query_vector=query_vector,
            history_ids=history_ids,
            limit=limit,
            with_vectors=True,
        )

        if suggestions:
            fallback = suggestions[0]
            best = select_best_point(suggestions)
            if best is not None:
                return best

        limit += SUGGESTION_LIMIT_STEP

    return fallback


def run_recommendation_chain(
    client: QdrantClient,
    collection_name: str,
    start_vector: VectorLike,
    end_vector: VectorLike,
) -> list[models.ScoredPoint]:
    history: list[models.ScoredPoint] = []
    history_ids: set[PointId] = set()
    query_vector: FloatVector = np.array(start_vector) * SCALE_ENDPOINTS

    for step_index in range(ITERATIONS):
        highest: models.ScoredPoint | None = find_next_point(
            client=client,
            collection_name=collection_name,
            query_vector=query_vector,
            history_ids=history_ids,
        )
        if highest is None:
            break

        history.append(highest)
        history_ids.add(highest.id)
        query_vector = build_next_query(
            mode=QUERY_UPDATE_MODE,
            step_index=step_index,
            total_steps=ITERATIONS,
            start_vector=start_vector,
            end_vector=end_vector,
            chosen_vector=highest.vector,
            alpha_value=ALPHA,
            endpoint_scale=SCALE_ENDPOINTS,
        )

        pprint(highest.model_dump(exclude={"vector"}))
        print()

    return history


def main() -> None:
    load_environment()
    client: QdrantClient = create_qdrant_client()
    model: ClapModel
    processor: ClapProcessor
    device: str
    model, processor, device = load_clap_resources()
    ensure_text_index(client, COLLECTION_NAME, "artist")
    ensure_text_index(client, COLLECTION_NAME, "song")


    # start_vector: FloatVector = embed_text(START_PROMPT, model, processor, device)
    # end_vector: FloatVector = embed_text(END_PROMPT, model, processor, device)
    start = "marina"
    end = "damiano david"
    start_payload: list[models.Record] = search_payload_text(client, COLLECTION_NAME, "artist", start)
    end_payload: list[models.Record] = search_payload_text(client, COLLECTION_NAME, "artist", end)
    # print(start_payload, end_payload)
    start_vector: FloatVector = start_payload[0].vector
    end_vector: FloatVector = end_payload[0].vector

    start_search: list[models.ScoredPoint] = query_similar_points(
        client=client,
        collection_name=COLLECTION_NAME,
        query_vector=start_vector,
        limit=SEED_LIMIT,
    )
    end_search: list[models.ScoredPoint] = query_similar_points(
        client=client,
        collection_name=COLLECTION_NAME,
        query_vector=end_vector,
        limit=SEED_LIMIT,
    )

    print_seed_result("start", start_search)
    print_seed_result("end", end_search)
    print(f"Alpha: {ALPHA}")
    run_recommendation_chain(
        client=client,
        collection_name=COLLECTION_NAME,
        start_vector=start_vector,
        end_vector=end_vector,
    )


if __name__ == "__main__":
    main()
