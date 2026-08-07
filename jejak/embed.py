"""Semantic embedding service for similarity-based clustering.

Loads `paraphrase-multilingual-MiniLM-L12-v2` through `transformers` directly
rather than through `sentence-transformers`. The vectors are the same — that
model is a plain transformer followed by mean pooling and L2 normalisation,
which is what happens below — but the import chain is far shorter:
sentence-transformers pulls in `datasets`, which loads `pyarrow`'s native
compute DLL, and that is both heavy and, on locked-down Windows installs,
blocked outright by Application Control.

The model is cached in a module-level singleton so it survives the process and
is not reloaded per cluster run.
"""
from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
MAX_TOKENS = 128

_MODEL = None
_TOKENIZER = None


def _load_model():
    global _MODEL, _TOKENIZER
    if _MODEL is not None:
        return _TOKENIZER, _MODEL
    import torch
    from transformers import AutoModel, AutoTokenizer

    _TOKENIZER = AutoTokenizer.from_pretrained(MODEL_NAME)
    _MODEL = AutoModel.from_pretrained(MODEL_NAME)
    _MODEL.eval()
    torch.set_grad_enabled(False)
    return _TOKENIZER, _MODEL


@lru_cache(maxsize=1024)
def _encode(text: str) -> bytes:
    import numpy as np
    import torch

    tokenizer, model = _load_model()
    batch = tokenizer(
        text,
        padding=True,
        truncation=True,
        max_length=MAX_TOKENS,
        return_tensors="pt",
    )
    with torch.no_grad():
        output = model(**batch).last_hidden_state

    # Mean-pool over real tokens only; padding must not drag the vector around.
    mask = batch["attention_mask"].unsqueeze(-1).float()
    pooled = (output * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1e-9)
    pooled = torch.nn.functional.normalize(pooled, p=2, dim=1)

    return np.asarray(pooled[0], dtype=np.float32).tobytes()


def embed(text: str) -> np.ndarray:
    import numpy as np
    return np.frombuffer(_encode(text), dtype=np.float32)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float((a @ b).item())
