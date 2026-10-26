from __future__ import annotations

from pydantic import Field

from amazme_backend.shared.model import Model

ARTIFACT_MAX_BYTES = 1_048_576

_B64_MAX = (ARTIFACT_MAX_BYTES + 2) // 3 * 4

class ArtifactWrite(Model):
    artifact_id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    name: str = Field(min_length=1, max_length=120)
    media_type: str = Field(default="application/octet-stream", max_length=82)
    data_base64: str = Field(min_length=1, max_length=_B64_MAX)

class ArtifactView(Model):
    artifact_id: str
    name: str
    media_type: str
    size: int = Field(ge=0)
    digest: str

class ArtifactBody(ArtifactView):
    data_base64: str

class ArtifactList(Model):
    artifacts: list[ArtifactView]
