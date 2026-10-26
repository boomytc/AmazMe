"""Catalog price snapshots and integer micro-USD accounting."""
from amazme_backend.ai.catalog import INDEX
from amazme_backend.ai.types import Completion, ModelSpec
from amazme_backend.shared.errors import BackendError


def catalog_price(provider: str, model: str) -> tuple[int, int, int, int] | None:
    """Return the catalog rate for the provider that actually answered."""
    entry = INDEX.get((provider, model))
    if entry is None or entry.cost.get("tiers"):
        return None
    rates: list[int] = []
    for key in ("input", "output", "cacheRead", "cacheWrite"):
        value = entry.cost.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
            return None
        rates.append(round(value * 1_000_000))
    return rates[0], rates[1], rates[2], rates[3]


def token_cost_micro(
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
    rates: tuple[int, int, int, int],
) -> int:
    if min(input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, *rates) < 0:
        raise BackendError("invalid_usage")
    input_rate, output_rate, cache_read_rate, cache_write_rate = rates
    return (
        input_tokens * input_rate
        + output_tokens * output_rate
        + cache_read_tokens * cache_read_rate
        + cache_write_tokens * cache_write_rate
    ) // 1_000_000


def with_catalog_price[T](config: ModelSpec, completion: Completion[T]) -> Completion[T]:
    price = catalog_price(config.provider, config.model)
    if price is None:
        return completion
    return completion.model_copy(update={
        "price_input_micro_per_million": price[0],
        "price_output_micro_per_million": price[1],
        "price_cache_read_micro_per_million": price[2],
        "price_cache_write_micro_per_million": price[3],
    })
