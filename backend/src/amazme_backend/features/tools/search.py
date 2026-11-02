"""Pi's tool metadata tokenizer and BM25 search, used by the session tool pipeline."""

import math
import re
from collections import Counter
from dataclasses import dataclass

from icu import BreakIterator, Locale, Normalizer2, UnicodeSet, UnicodeString
from pydantic import JsonValue

from amazme_backend.contracts.mcp import McpOffer
from amazme_backend.contracts.tools import LoadedTools, ToolSearchOutput

_STOP_WORDS = frozenset("a an and are as at be by for from in is it of on or that the this to with".split())
_NFC = Normalizer2.getNFCInstance()
_WORD_CHARACTERS = UnicodeSet("[[:L:][:M:][:N:]]")
_WORD_CHARACTERS.freeze()


def _stem(term: str) -> str:
    if len(term) > 4 and term.endswith("ies"):
        return term[:-3] + "y"
    if len(term) > 4 and re.search(r"(ches|shes|sses|xes|zes)$", term):
        return term[:-2]
    if len(term) > 3 and term.endswith("s") and not term.endswith("ss"):
        return term[:-1]
    return term


def tokenize(text: str) -> list[str]:
    text = _NFC.normalize(text)
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    text = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", text)
    if text.isascii():
        words = re.split(r"[^a-z0-9]+", text.lower())
    else:
        text = str(UnicodeString(text).toLower(Locale.getRoot()))
        normalized = "".join(char if _WORD_CHARACTERS.contains(char) else " " for char in text)
        # ICU offsets count UTF-16 units, so slice its UnicodeString rather than Python's code points.
        source = UnicodeString(normalized)
        segmenter = BreakIterator.createWordInstance(Locale.getRoot())
        segmenter.setText(source)
        start = segmenter.first()
        words: list[str] = []
        for end in segmenter:
            if segmenter.getRuleStatus() >= 100:
                words.append(str(source[start:end]))
            start = end
    return [_stem(word) if word.isascii() else word for word in words if word and word not in _STOP_WORDS]


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


@dataclass(frozen=True)
class _IndexedTool:
    offer: McpOffer
    name_terms: frozenset[str]
    local_terms: frozenset[str]
    text_counts: Counter[str]
    text_length: int
    namespace_terms: frozenset[str]


def _index_tool(offer: McpOffer) -> _IndexedTool:
    parts = [offer.description]
    _schema_text(offer.input_schema, parts)
    counts = Counter(tokenize(" ".join(parts)))
    return _IndexedTool(offer, frozenset(tokenize(offer.name)),
                        frozenset(tokenize(offer.name.rsplit("__", 1)[-1])), counts, counts.total(),
                        frozenset(tokenize(offer.namespace_text)))


def _normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9_$]", "_", name.strip().lower())


def rank_tools(query: str, offers: list[McpOffer], limit: int) -> list[McpOffer]:
    """Rank exact names, then query coverage, then name-weighted BM25; ties keep catalog order."""
    terms = list(dict.fromkeys(tokenize(query)))
    if not terms or not offers or limit <= 0:
        return []
    documents = [_index_tool(offer) for offer in offers]
    average = sum(document.text_length for document in documents) / len(documents) or 1
    idf: dict[str, float] = {}
    for term in terms:
        frequency = sum(term in document.name_terms or term in document.text_counts or term in document.namespace_terms
                        for document in documents)
        idf[term] = math.log(1 + (len(documents) - frequency + 0.5) / (frequency + 0.5))
    full_name_bonus = sum(idf.values())
    name_query = _normalize_name(query)
    ranked: list[tuple[bool, int, float, McpOffer]] = []
    for document in documents:
        norm = 1.2 * (1 - 0.75 + 0.75 * document.text_length / average)
        score = 0.0
        covered = 0
        for term in terms:
            count = document.text_counts[term]
            # A name match outweighs the text field's maximum contribution of 2.2.
            weight = ((3 if term in document.name_terms else 0)
                      + (0.5 if term in document.namespace_terms else 0) + count * 2.2 / (count + norm))
            covered += weight > 0
            score += idf[term] * weight
        if score == 0:
            continue
        if document.local_terms and document.local_terms.issubset(terms):
            score += full_name_bonus
        name = _normalize_name(document.offer.name)
        exact = name == name_query or name.endswith("__" + name_query)
        ranked.append((exact, covered, score, document.offer))
    return [offer for _exact, _covered, _score, offer in
            sorted(ranked, key=lambda item: (not item[0], -item[1], -item[2]))[:limit]]


def search_result(offers: list[McpOffer]) -> ToolSearchOutput:
    text = (f"Loaded {len(offers)} tool{'s' if len(offers) != 1 else ''}. They are available from your next call:\n"
            + "\n".join(f"- {offer.alias}: {offer.description.strip().splitlines()[0] if offer.description.strip() else ''}" for offer in offers)
            if offers else "No matching tools found.")
    return ToolSearchOutput(content=[{"type": "text", "text": text}], details=LoadedTools(loaded=[offer.alias for offer in offers]))
