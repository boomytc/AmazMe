"""Pi's tool metadata tokenizer and BM25 search, used by the session tool pipeline."""

import math
import re
from collections import Counter

from pydantic import JsonValue

from amazme_backend.contracts.mcp import McpOffer
from amazme_backend.contracts.tools import LoadedTools, ToolSearchOutput

_STOP_WORDS = frozenset("a an and are as at be by for from in is it of on or that the this to with".split())








def _stem(term: str) -> str:
    if len(term) > 4 and term.endswith("ies"):
        return term[:-3] + "y"
    if len(term) > 4 and re.search(r"(ches|shes|sses|xes|zes)$", term):
        return term[:-2]
    if len(term) > 3 and term.endswith("s") and not term.endswith("ss"):
        return term[:-1]
    return term


def tokenize(text: str) -> list[str]:
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    text = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", text).lower()
    return [_stem(term) for term in re.split(r"[^a-z0-9]+", text) if term and term not in _STOP_WORDS]


def _schema_text(schema: JsonValue, parts: list[str]) -> None:
    if not isinstance(schema, dict):
        return
    if isinstance(schema.get("description"), str):
        parts.append(str(schema["description"]))
    properties = schema.get("properties")
    if isinstance(properties, dict):
        for name, value in properties.items():
            parts.append(name)
            _schema_text(value, parts)
    _schema_text(schema.get("items"), parts)
    for key in ("anyOf", "oneOf", "allOf"):
        variants = schema.get(key)
        if isinstance(variants, list):
            for variant in variants:
                _schema_text(variant, parts)


def rank_tools(query: str, offers: list[McpOffer], limit: int) -> list[McpOffer]:
    terms = list(dict.fromkeys(tokenize(query)))
    if not terms or not offers or limit <= 0:
        return []
    documents: list[Counter[str]] = []
    for offer in offers:
        parts = [offer.name, offer.name.replace("_", " "), offer.description]
        _schema_text(offer.input_schema, parts)
        documents.append(Counter(tokenize(" ".join(parts))))
    lengths = [sum(document.values()) for document in documents]
    average = sum(lengths) / len(documents) or 1
    idf = {term: math.log(1 + (len(documents) - sum(term in document for document in documents) + 0.5)
                          / (sum(term in document for document in documents) + 0.5)) for term in terms}
    ranked: list[tuple[float, McpOffer]] = []
    for offer, document, length in zip(offers, documents, lengths, strict=True):
        norm = 1.2 * (1 - 0.75 + 0.75 * length / average)
        score = sum(idf[term] * (document[term] * 2.2 / (document[term] + norm)) for term in terms if document[term])
        if score > 0:
            ranked.append((score, offer))
    return [offer for _score, offer in sorted(ranked, key=lambda item: -item[0])[:limit]]


def search_result(offers: list[McpOffer]) -> ToolSearchOutput:
    text = (f"Loaded {len(offers)} tool{'s' if len(offers) != 1 else ''}. They are available from your next call:\n"
            + "\n".join(f"- {offer.alias}: {offer.description.strip().splitlines()[0] if offer.description.strip() else ''}" for offer in offers)
            if offers else "No matching tools found.")
    return ToolSearchOutput(content=[{"type": "text", "text": text}], details=LoadedTools(loaded=[offer.alias for offer in offers]))
