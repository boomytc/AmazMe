"""Refresh the packaged Command Code chat catalog from its public model routes."""

import argparse
import json
import re
from collections import Counter
from pathlib import Path

import httpx
from pydantic import BaseModel, ConfigDict, Field

from amazme_backend.ai.official_thinking import align_command_code_models
from amazme_backend.contracts.models import ModelSelection, ProviderApi

MODELS_URL = "https://api.commandcode.ai/provider/v1/models"
BASE_URL = "https://api.commandcode.ai/provider/v1"
ADAPTIVE_THINKING = re.compile(r"opus[-.](?:4[-.][678]|5)|sonnet[-.](?:4[-.]6|5)|fable[-.]5|mythos[-.]5")


class Pricing(BaseModel):
    model_config = ConfigDict(strict=True)
    input: float | None = Field(default=None, ge=0)
    output: float | None = Field(default=None, ge=0)
    cache_read: float | None = Field(default=None, ge=0)
    cache_write: float | None = Field(default=None, ge=0)


class Modalities(BaseModel):
    input: list[str]


class RemoteModel(BaseModel):
    model_config = ConfigDict(strict=True)
    id: str
    name: str = ""
    supported_endpoints: list[str]
    max_output_tokens: int = Field(default=32768, gt=0)
    context_length: int | None = Field(default=None, gt=0)
    reasoning: bool | None = None
    modalities: Modalities | None = None
    pricing: Pricing | None = None


class RemoteCatalog(BaseModel):
    data: list[RemoteModel]


def protocol(model: RemoteModel) -> ProviderApi | None:
    routes = model.supported_endpoints
    if "/messages" in routes:
        return "anthropic-messages"
    if "/responses" in routes and model.id.startswith("gpt-"):
        return "openai-responses"
    if "/chat/completions" in routes:
        return "openai-completions"
    return "openai-responses" if "/responses" in routes else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Read an already downloaded public /models JSON response")
    args = parser.parse_args()
    if args.source:
        raw = args.source.read_bytes()
    else:
        with httpx.Client(timeout=15, trust_env=False) as client:
            response = client.get(MODELS_URL)
            response.raise_for_status()
            raw = response.content
    catalog = RemoteCatalog.model_validate_json(raw)
    models: list[dict[str, object]] = []
    seen: set[str] = set()
    skipped: list[str] = []
    for model in catalog.data:
        ModelSelection(provider="command-code", model=model.id)
        if model.id in seen:
            raise ValueError(f"Duplicate Command Code model: {model.id}")
        seen.add(model.id)
        api = protocol(model)
        if api is None:
            skipped.append(model.id)
            continue
        vision = "image" in model.modalities.input if model.modalities else model.id.startswith(("claude-", "gpt-", "google/"))
        compat: dict[str, object] = {}
        if api == "openai-completions":
            compat = {"supportsDeveloperRole": False, "maxTokensField": "max_tokens"}
        elif api == "anthropic-messages" and ADAPTIVE_THINKING.search(model.id):
            compat = {"forceAdaptiveThinking": True}
        prices = model.pricing.model_dump(exclude_none=True) if model.pricing else {}
        models.append({
            "id": model.id, "provider": "command-code", "name": model.name or model.id,
            "api": api, "baseUrl": BASE_URL, "maxTokens": model.max_output_tokens,
            **({} if model.context_length is None else {"contextWindow": model.context_length}),
            "reasoning": model.reasoning if model.reasoning is not None else True,
            "input": ["text", "image"] if vision else ["text"], "compat": compat,
            "cost": {key: prices[source] for key, source in (
                ("input", "input"), ("output", "output"), ("cacheRead", "cache_read"), ("cacheWrite", "cache_write")
            ) if source in prices},
        })
    if not models:
        raise ValueError("No supported Command Code chat models; keeping the existing snapshot")
    align_command_code_models(models)
    target = Path(__file__).resolve().parents[1] / "src/amazme_backend/assets/command_code_models.json"
    target.write_text(json.dumps(sorted(models, key=lambda item: str(item["id"])), ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"models": len(models), "protocols": dict(Counter(str(model["api"]) for model in models)), "skipped": skipped}))


if __name__ == "__main__":
    main()
