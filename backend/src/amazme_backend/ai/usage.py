"""Pure accounting over the rates captured by a completed model call."""
from amazme_backend.ai.types import Completion
from amazme_backend.contracts.models import ModelCallUsage
from amazme_backend.shared.errors import BackendError


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


def call_usage[T](call_id: str, provider: str, model: str, completion: Completion[T], *,
                  started_at_ms: int | None = None, finished_at_ms: int | None = None,
                  first_text_at_ms: int | None = None) -> ModelCallUsage:
    pin, pout = completion.price_input_micro_per_million, completion.price_output_micro_per_million
    pcr, pcw = completion.price_cache_read_micro_per_million, completion.price_cache_write_micro_per_million
    priced = pin is not None and pout is not None and (
        not (completion.cache_read_tokens or completion.cache_write_tokens) or pcr is not None and pcw is not None)
    cost = token_cost_micro(completion.input_tokens, completion.output_tokens, completion.cache_read_tokens,
                            completion.cache_write_tokens, (pin or 0, pout or 0, pcr or 0, pcw or 0)) if priced else None
    return ModelCallUsage(call_id=call_id, provider=provider, model=model,
                          input_tokens=completion.input_tokens, output_tokens=completion.output_tokens,
                          cache_read_tokens=completion.cache_read_tokens, cache_write_tokens=completion.cache_write_tokens,
                          cost_micro_usd=cost, started_at_ms=started_at_ms, finished_at_ms=finished_at_ms,
                          first_text_at_ms=first_text_at_ms)


