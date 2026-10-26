"""Project Gemini tool schemas without rewriting literal JSON values."""

from pydantic import JsonValue

_NAME_MAPS = {"properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"}
_SUBSCHEMAS = {
    "additionalProperties", "unevaluatedProperties", "propertyNames", "items", "prefixItems",
    "additionalItems", "unevaluatedItems", "contains", "allOf", "anyOf", "oneOf", "not",
    "if", "then", "else", "contentSchema",
}


def const_as_enum(schema: JsonValue, *, name_map: bool = False) -> JsonValue:
    if isinstance(schema, list):
        return [const_as_enum(item) for item in schema]
    if not isinstance(schema, dict):
        return schema
    result: dict[str, JsonValue] = {}
    for key, value in schema.items():
        if name_map or key in _SUBSCHEMAS:
            result[key] = const_as_enum(value)
        elif key in _NAME_MAPS:
            result[key] = const_as_enum(value, name_map=True)
        else:
            result[key] = value
    value = result.get("const")
    if not name_map and "enum" not in result and isinstance(value, (str, int, float)) and not isinstance(value, bool):
        del result["const"]
        result["enum"] = [value]
    return result
