"""Session limits shared by transaction and projection code."""
TERMINAL = frozenset({"succeeded", "cancelled", "interrupted", "failed", "unknown"})
PENDING_LIMIT = 128
RETAIN_BATCHES = 256
RETAIN_BYTES = 2 * 1024 * 1024
CONTEXT_BYTES = 262144
SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024
SNAPSHOT_VIEW_BYTES = 2 * 1024 * 1024
SNAPSHOT_CHILD_BYTES = 512 * 1024
