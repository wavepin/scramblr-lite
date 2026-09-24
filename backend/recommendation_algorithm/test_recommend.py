import sys
import types
import importlib.util
import importlib
import contextlib
import os
from pathlib import Path
import numpy as np

# Create lightweight fake modules to avoid heavy external imports when importing
# the target module under test.
models_mod = types.ModuleType("qdrant_client.models")

class HasIdCondition:
    def __init__(self, has_id):
        self.has_id = has_id

class Filter:
    def __init__(self, must=None, must_not=None):
        self.must = must or []
        self.must_not = must_not or []

class TextIndexParams:
    def __init__(self, **kwargs):
        self.params = kwargs

class TextIndexType:
    TEXT = "text"

class TokenizerType:
    MULTILINGUAL = "multilingual"

class MatchText:
    def __init__(self, text):
        self.text = text

class FieldCondition:
    def __init__(self, key, match):
        self.key = key
        self.match = match

class Record:
    def __init__(self, vector=None, payload=None):
        self.vector = vector
        self.payload = payload or {}

class ScoredPoint:
    def __init__(self, id=None, payload=None, score=0.0, vector=None):
        self.id = id
        self.payload = payload or {}
        self.score = score
        self.vector = vector

models_mod.HasIdCondition = HasIdCondition
models_mod.Filter = Filter
models_mod.TextIndexParams = TextIndexParams
models_mod.TextIndexType = TextIndexType
models_mod.TokenizerType = TokenizerType
models_mod.MatchText = MatchText
models_mod.FieldCondition = FieldCondition
models_mod.Record = Record
models_mod.ScoredPoint = ScoredPoint
models_mod.ExtendedPointId = int

qdrant_mod = types.ModuleType("qdrant_client")
qdrant_mod.QdrantClient = lambda *a, **k: None
qdrant_mod.models = models_mod

sys.modules["qdrant_client"] = qdrant_mod
sys.modules["qdrant_client.models"] = models_mod

# fake transformers
trans_mod = types.ModuleType("transformers")
trans_mod.ClapModel = type("ClapModel", (), {})
trans_mod.ClapProcessor = type("ClapProcessor", (), {})
sys.modules["transformers"] = trans_mod

# fake torch with minimal surface used by the module
torch_mod = types.ModuleType("torch")
class Cuda:
    @staticmethod
    def is_available():
        return False

torch_mod.cuda = Cuda()
torch_mod.no_grad = contextlib.nullcontext
sys.modules["torch"] = torch_mod

# minimal stubs for local helper module imported by recommend.py
gv = types.ModuleType("get_vector_from_preferences")
def cleanup_created_files():
    return None
def ensure_audio_dir():
    return None
def get_mp3_from_url(url, normalized_song, created_files):
    return (None, None)
def search_youtube_url(name, artist):
    return None
def upload_vector(songs_list, client):
    return None

gv.cleanup_created_files = cleanup_created_files
gv.ensure_audio_dir = ensure_audio_dir
gv.get_mp3_from_url = get_mp3_from_url
gv.search_youtube_url = search_youtube_url
gv.upload_vector = upload_vector
sys.modules["get_vector_from_preferences"] = gv

# Load the module under test by file path so that our injected modules are used.
ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "backend" / "recommendation_algorithm" / "recommend.py"
spec = importlib.util.spec_from_file_location("recommend", str(MODULE_PATH))
recommend = importlib.util.module_from_spec(spec)
sys.modules["recommend"] = recommend
spec.loader.exec_module(recommend)


def test_build_text_prompt_start():
    # Verify build_text_prompt constructs a start prompt from
    # provided genres, artists, and song examples.
    prefs = {
        "genres": ["Jazz"],
        "artists": ["Adele"],
        "songs": [{"name": "Hello", "artist": "Adele"}],
    }
    res = recommend.build_text_prompt(prefs, "start")
    assert "Jazz" in res
    assert "Adele" in res
    assert "Hello by Adele" in res


def test_build_text_prompt_end_and_default():
    # Verify 'end' role returns the long genre string and
    # empty 'start' falls back to the default phrase.
    assert "experimental" in recommend.build_text_prompt({}, "end")
    assert recommend.build_text_prompt({}, "start") == "popular music"


def test_build_next_query_legacy_and_interpolate():
    # Test 'legacy' update math and 'interpolate' progress logic
    # for combining start/end/chosen/preference vectors.
    start = np.array([1.0, 2.0], dtype=np.float32)
    end = np.array([3.0, 4.0], dtype=np.float32)
    chosen = np.array([2.0, 2.0], dtype=np.float32)
    pref = np.array([0.1, 0.2], dtype=np.float32)

    legacy = recommend.build_next_query(
        mode="legacy",
        step_index=0,
        total_steps=5,
        start_vector=start,
        end_vector=end,
        chosen_vector=chosen,
        alpha_value=0.5,
        endpoint_scale=2.0,
        preference_matrix=pref,
    )
    scaled_end = end * 2.0 + (pref / np.linalg.norm(pref)) * recommend.PREFERENCE_SCALE
    expected = (scaled_end - chosen) * 0.5 + chosen
    assert np.allclose(legacy, expected)

    interp = recommend.build_next_query(
        mode="interpolate",
        step_index=0,
        total_steps=1,
        start_vector=start,
        end_vector=end,
        chosen_vector=chosen,
        alpha_value=0.5,
        endpoint_scale=1.0,
        preference_matrix=np.zeros_like(pref),
    )
    # total_steps==1 means progress=1.0 so result should be scaled_end + pref
    assert np.allclose(interp, end * 1.0 + np.zeros_like(pref))


def test_get_title_and_song_key():
    # Ensure title extraction returns the song/title field and
    # the song key is normalized to lowercase (title, artist).
    p = {"song": "Hello", "artist": "Adele"}
    assert recommend.get_title_from_payload(p) == "Hello"
    assert recommend.get_song_key(p) == ("hello", "adele")


def test_select_best_point_and_build_results():
    # Select the highest-scoring unseen point from a set of
    # suggestions and verify build_results serializes payloads.
    pts = [
        ScoredPoint(id=1, payload={"song": "A", "artist": "X"}, score=0.5),
        ScoredPoint(id=2, payload={"song": "B", "artist": "Y"}, score=0.9),
        ScoredPoint(id=3, payload={"song": "C", "artist": "Z"}, score=0.7),
    ]
    seen = {("a", "x")}
    best = recommend.select_best_point(pts, seen)
    assert best is not None
    assert best.payload["song"] == "B"

    results = recommend.build_results(pts)
    assert isinstance(results, list)
    assert results[0]["title"] == "A"


def test_select_best_point_applies_threshold_and_hard_exclusions():
    pts = [
        ScoredPoint(
            id=1,
            payload={"song": "Liked Candidate", "artist": "A", "tags": ["rap"]},
            score=0.8,
            vector=np.array([1.0, 0.0], dtype=np.float32),
        ),
        ScoredPoint(
            id=2,
            payload={"song": "Disliked Candidate", "artist": "B", "tags": ["country"]},
            score=0.99,
            vector=np.array([1.0, 0.0], dtype=np.float32),
        ),
    ]

    best = recommend.select_best_point(
        pts,
        seen_songs=set(),
        avoid_song_keys={("disliked candidate", "b")},
        avoid_genres=["country"],
        current_vector=np.array([1.0, 0.0], dtype=np.float32),
        candidate_score_threshold=0.45,
        continuity_min_similarity=0.1,
    )
    assert best is not None
    assert best.payload["song"] == "Liked Candidate"

    assert (
        recommend.select_best_point(
            pts,
            seen_songs=set(),
            current_vector=np.array([1.0, 0.0], dtype=np.float32),
            candidate_score_threshold=2.0,
        )
        is None
    )


def test_select_best_point_rejects_avoid_vector_similarity():
    pts = [
        ScoredPoint(
            id=1,
            payload={"song": "Too Similar", "artist": "A"},
            score=0.99,
            vector=np.array([1.0, 0.0], dtype=np.float32),
        ),
        ScoredPoint(
            id=2,
            payload={"song": "Allowed Candidate", "artist": "B"},
            score=0.7,
            vector=np.array([0.0, 1.0], dtype=np.float32),
        ),
    ]

    best = recommend.select_best_point(
        pts,
        seen_songs=set(),
        avoid_matrix=np.array([[1.0], [0.0]], dtype=np.float32),
        avoid_hard_similarity_threshold=0.55,
    )

    assert best is not None
    assert best.payload["song"] == "Allowed Candidate"


def test_select_best_point_allows_below_avoid_vector_threshold():
    pts = [
        ScoredPoint(
            id=1,
            payload={"song": "Distant Enough", "artist": "A"},
            score=0.99,
            vector=np.array([0.4, 0.9165], dtype=np.float32),
        ),
    ]

    best = recommend.select_best_point(
        pts,
        seen_songs=set(),
        avoid_matrix=np.array([[1.0], [0.0]], dtype=np.float32),
        avoid_hard_similarity_threshold=0.55,
    )

    assert best is not None
    assert best.payload["song"] == "Distant Enough"


def test_find_next_point_falls_back_when_avoid_score_misses_threshold(monkeypatch):
    pts = [
        ScoredPoint(
            id=1,
            payload={"song": "Least Bad Candidate", "artist": "A"},
            score=0.9,
            vector=np.array([1.0, 0.0], dtype=np.float32),
        )
    ]

    monkeypatch.setattr(recommend, "query_similar_points", lambda **_kwargs: pts)

    best = recommend.find_next_point(
        client=None,
        collection_name="collection",
        query_vector=np.array([1.0, 0.0], dtype=np.float32),
        current_vector=np.array([1.0, 0.0], dtype=np.float32),
        preference_matrix=np.array([[0.0], [1.0]], dtype=np.float32),
        avoid_matrix=np.array([[1.0], [0.0]], dtype=np.float32),
        history_ids=set(),
        seen_songs=set(),
        avoid_song_keys=set(),
        avoid_genres=[],
        query_similarity_weight=0.55,
        continuity_similarity_weight=0.45,
        preference_similarity_weight=0.45,
        avoid_similarity_weight=1.2,
        initial_suggestion_limit=10,
        suggestion_limit_step=10,
        max_suggestion_limit=10,
        candidate_score_threshold=0.45,
        candidate_score_fallback_limit=10,
        continuity_min_similarity=0.18,
        avoid_hard_similarity_threshold=None,
    )

    assert best is not None
    assert best.payload["song"] == "Least Bad Candidate"


def test_avoid_genre_matching_is_literal_with_punctuation_normalization():
    assert recommend.payload_matches_avoided_genres(
        {"tags": ["singer-songwriter"]},
        ["singer songwriter"],
    )
    assert recommend.payload_matches_avoided_genres(
        {"tags": ["singer/songwriter"]},
        ["singer songwriter"],
    )
    assert recommend.payload_matches_avoided_genres({"tags": ["rock"]}, ["rock"])
    assert not recommend.payload_matches_avoided_genres(
        {"tags": ["alternative rock"]},
        ["rock"],
    )
    assert not recommend.payload_matches_avoided_genres(
        {"tags": ["heavy metal"]},
        ["rock"],
    )


def test_select_best_point_rejects_low_continuity_transition():
    pts = [
        ScoredPoint(
            id=1,
            payload={"song": "Abrupt Jump", "artist": "A"},
            score=0.99,
            vector=np.array([0.0, 1.0], dtype=np.float32),
        )
    ]

    assert (
        recommend.select_best_point(
            pts,
            seen_songs=set(),
            current_vector=np.array([1.0, 0.0], dtype=np.float32),
            continuity_min_similarity=0.5,
        )
        is None
    )


def test_build_query_filter():
    # Ensure history ids are converted into a qdrant Filter with
    # a HasIdCondition listing the provided ids.
    ids = {101, 202}
    f = recommend.build_query_filter(ids)
    assert isinstance(f, models_mod.Filter)
    assert len(f.must_not) == 1
    assert isinstance(f.must_not[0], models_mod.HasIdCondition)
    assert set(f.must_not[0].has_id) == ids


def test_interaction_vector_lookup_uses_configured_collection():
    os.environ["QDRANT_COLLECTION_NAME"] = "configured_collection"
    module_path = ROOT / "backend" / "recommendation_algorithm" / "update_vector_from_interactions.py"
    spec = importlib.util.spec_from_file_location("update_vector_from_interactions_test", str(module_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.COLLECTION_NAME == "configured_collection"


def test_qdrant_failures_degrade_to_empty_results():
    class FailingClient:
        def create_payload_index(self, **_kwargs):
            raise TimeoutError("timed out")

        def scroll(self, **_kwargs):
            raise TimeoutError("timed out")

        def query_points(self, **_kwargs):
            raise TimeoutError("timed out")

    client = FailingClient()

    recommend.ensure_text_index(client, "collection", "artist")
    assert recommend.search_payload_text(client, "collection", "artist", "A") == []
    assert (
        recommend.search_song_payload(
            client,
            "collection",
            {"name": "Song", "artist": "Artist"},
        )
        == []
    )
    assert recommend.query_similar_points(client, "collection", [1.0, 0.0]) == []


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__]))
