"""Packaged classifier model catalog, independent of account storage."""
from pydantic import TypeAdapter

from amazme_backend.ai.classification.types import ClassifierModel
from amazme_backend.platform.resources import package_resource

MODELS = TypeAdapter(list[ClassifierModel]).validate_json(package_resource("classifiers").read_bytes())
INDEX = {(model.provider, model.id): model for model in MODELS}
