"""The original skill administration surface, sharing the canonical resource loader."""

import hashlib
import re
import shutil
from pathlib import Path

import yaml

from amazme_backend.contracts.resources import ResourceCatalog, ResourceOptions
from amazme_backend.contracts.skills import SkillDocument, SkillImport, SkillWrite
from amazme_backend.features.resources.service import (
    FILE_LIMIT,
    agent_directory,
    frontmatter,
    load_resources,
    read_text,
)
from amazme_backend.platform.private_files import lock, private_write
from amazme_backend.profiles.profile import Profile
from amazme_backend.shared.errors import BackendError


def skill_catalog(profile: Profile, session: str = "", *, workspace: Path | None = None) -> ResourceCatalog:
    if session and workspace is None:
        raise BackendError("workspace_unresolved", status=503)
    return load_resources(
        workspace or Path(profile.config.workspace), agent_directory(profile), ResourceOptions()
    ).catalog


def read_skill(profile: Profile, session: str, name: str, *, workspace: Path | None = None) -> SkillDocument:
    catalog = skill_catalog(profile, session, workspace=workspace)
    item = next((item for item in catalog.skills if item.name == name), None)
    if item is None:
        raise BackendError("skill_not_found", status=404)
    content = read_text(Path(item.path))
    return SkillDocument(
        name=name,
        path=item.path,
        content=content,
        editable=item.editable,
        digest=hashlib.sha256(content.encode()).hexdigest(),
    )


def _metadata(content: str) -> dict[str, object]:
    try:
        metadata, _ = frontmatter(content)
    except (ValueError, yaml.YAMLError) as error:
        raise BackendError("invalid_skill_manifest") from error
    return metadata


def _content(name: str, content: str) -> str:
    if len(content.encode()) > FILE_LIMIT:
        raise BackendError("resource_file_limit")
    metadata = _metadata(content)
    if metadata.get("name", name) != name:
        raise BackendError("skill_name_mismatch")
    description = metadata.get("description")
    if not isinstance(description, str) or not description.strip() or len(description) > 1024:
        raise BackendError("skill_description_required")
    return content if content.endswith("\n") else content + "\n"


def _directory(profile: Profile) -> Path:
    root = agent_directory(profile) / "skills"
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink():
        raise BackendError("skill_read_only")
    return root


def write_skill(
    profile: Profile, session: str, value: SkillWrite, *, workspace: Path | None = None
) -> SkillDocument:
    content = _content(value.name, value.content)
    root = _directory(profile)
    with lock(root / ".skills.lock"):
        directory = root / value.name
        path = directory / "SKILL.md"
        if directory.is_symlink() or path.is_symlink():
            raise BackendError("skill_read_only")
        current = read_text(path) if path.exists() else ""
        digest = hashlib.sha256(current.encode()).hexdigest() if path.exists() else ""
        if current != content:
            if digest != value.expected_digest:
                raise BackendError("skill_conflict")
            directory.mkdir(exist_ok=True)
            private_write(path, content)
        return read_skill(profile, session, value.name, workspace=workspace)


def remove_skill(
    profile: Profile, session: str, name: str, expected: str, *, workspace: Path | None = None
) -> None:
    if not re.fullmatch("[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
        raise BackendError("invalid_skill_name")
    root = _directory(profile)
    with lock(root / ".skills.lock"):
        directory = root / name
        if directory.is_symlink():
            raise BackendError("skill_read_only")
        if not directory.exists():
            return
        document = read_skill(profile, session, name, workspace=workspace)
        if not document.editable:
            raise BackendError("skill_read_only")
        if document.digest != expected:
            raise BackendError("skill_conflict")
        shutil.rmtree(directory)


def import_skill(
    profile: Profile, session: str, value: SkillImport, *, workspace: Path | None = None
) -> SkillDocument:
    source = Path(value.path).expanduser()
    if not source.is_absolute():
        if session and workspace is None:
            raise BackendError("workspace_unresolved", status=503)
        source = (workspace or Path(profile.config.workspace)) / source
    source = source.resolve(strict=True)
    folder = source.is_dir()
    if not folder and (not source.is_file() or source.suffix != ".md"):
        raise BackendError("invalid_skill_source")
    manifest = source / "SKILL.md" if folder else source
    content = read_text(manifest)
    metadata = _metadata(content)
    name = metadata.get("name", source.name if folder else source.stem)
    if not isinstance(name, str) or not re.fullmatch("[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
        raise BackendError("invalid_skill_name")
    content = _content(name, content)
    root = _directory(profile)
    target = root / name
    if folder and target.is_relative_to(source):
        raise BackendError("skill_import_self")
    with lock(root / ".skills.lock"):
        try:
            target.mkdir()
        except FileExistsError as error:
            raise BackendError("skill_exists") from error
        owned = target.stat()
        try:
            if folder:
                for entry in source.iterdir():
                    if entry.name == "SKILL.md":
                        continue
                    if entry.is_dir() and (not entry.is_symlink()):
                        shutil.copytree(entry, target / entry.name, symlinks=True)
                    else:
                        shutil.copy2(entry, target / entry.name, follow_symlinks=False)
            private_write(target / "SKILL.md", content)
        except BaseException:
            current = target.lstat()
            if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino):
                shutil.rmtree(target)
            raise
        return read_skill(profile, session, name, workspace=workspace)
