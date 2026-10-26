import hashlib
import time

from amazme_backend.contracts.feedback import AnswerFeedbackWrite


def now_ms() -> int:
    return time.time_ns() // 1000000


def checkpoint_id(workspace: str, path: str, digest: str) -> str:
    """One id for the same workspace file bytes. A different file or digest is a different row."""
    return hashlib.sha256(f"{workspace}\n{path}\n{digest}".encode()).hexdigest()[:32]


def answer_feedback_key(session: str, value: AnswerFeedbackWrite) -> str:
    return hashlib.sha256((session + "\n" + value.model_dump_json()).encode()).hexdigest()
