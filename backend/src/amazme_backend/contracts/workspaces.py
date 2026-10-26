from __future__ import annotations

from pydantic import Field

from amazme_backend.shared.model import Model

FILE_LIST_LIMIT = 200
FILE_WRITE_LIMIT = 1_048_576


class EditFile(Model):
    path: str = Field(min_length=1, max_length=1024)
    old_string: str = Field(min_length=1, max_length=32000)
    new_string: str = Field(max_length=32000)
    replace_all: bool = False


class CheckpointCreate(Model):
    checkpoint_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    workspace: str = "primary"
    path: str = Field(min_length=1, max_length=1024)


class CheckpointView(Model):
    checkpoint_id: str
    workspace: str
    path: str
    digest: str


class CheckpointList(Model):
    checkpoints: list[CheckpointView]


class CheckpointPreview(Model):
    checkpoint_id: str
    workspace: str
    path: str
    absolute_path: str
    digest: str
    content: str
    current_digest: str
    diff: str


class CheckpointRestore(Model):
    expected_digest: str = Field(default="", max_length=64)


class WorkspaceGrantRequest(Model):
    name: str = Field(pattern=r"^[a-z][a-z0-9-]{0,31}$")
    host_path: str = Field(min_length=1, max_length=1024)


class WorkspaceSelect(Model):
    host_path: str = Field(min_length=1, max_length=1024)
    name: str = ""


class WorkspaceGrantView(Model):
    name: str
    host_path: str
    primary: bool = False


class WorkspaceList(Model):
    workspaces: list[WorkspaceGrantView]




class FileEntry(Model):
    name: str
    kind: str
    size: int

class FileList(Model):
    path: str
    absolute_path: str = ""
    entries: list[FileEntry]
    truncated: bool = False
    offset: int = Field(default=0, ge=0)
    limit: int = FILE_LIST_LIMIT
    total: int = Field(default=0, ge=0)

class FileContent(Model):
    path: str
    absolute_path: str = ""
    digest: str
    content: str
    truncated: bool = False
    offset: int = 0
    next_offset: int = 0
    total_bytes: int = 0
    has_more: bool = False

class FileWrite(Model):
    path: str = Field(min_length=1, max_length=1024)
    content: str = Field(max_length=FILE_WRITE_LIMIT)
    expected_digest: str = Field(default="", max_length=64)

class FileChange(Model):
    path: str
    digest: str
    diff: str
