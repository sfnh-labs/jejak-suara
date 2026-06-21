"""Semantic embedding service for similarity-based clustering.

Caches the model in a module-level singleton so it survives the WSGI app
lifetime and avoids reloading on every cluster run.
"""
from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

_SENTENCE_TRANSFORMERS = None
_MODEL = None


def _load_model():
    global _MODEL, _SENTENCE_TRANSFORMERS
    if _MODEL is not None:
        return _MODEL
    from sentence_transformers import SentenceTransformer
    _SENTENCE_TRANSFORMERS = SentenceTransformer
    _MODEL = SentenceTransformer(
        "paraphrase-multilingual-MiniLM-L12-v2",
        tokenizer_kwargs={"clean_up_tokenization_spaces": False},
    )
    return _MODEL


@lru_cache(maxsize=1024)
def _encode(text: str) -> bytes:
    import numpy as np
    model = _load_model()
    arr = model.encode(text, normalize_embeddings=True)
    return np.asarray(arr, dtype=np.float32).tobytes()


def embed(text: str) -> np.ndarray:
    import numpy as np
    return np.frombuffer(_encode(text), dtype=np.float32)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float((a @ b).item())
