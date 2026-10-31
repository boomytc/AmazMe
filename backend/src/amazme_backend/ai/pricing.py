"""Catalog price snapshots and integer micro-USD accounting."""
from amazme_backend.ai.catalog import INDEX
from amazme_backend.ai.types import Completion, ModelSpec


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
