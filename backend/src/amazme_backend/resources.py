"""Pi's context, skill discovery and prompt expansion, on the native filesystem.

Source: packages/coding-agent/src/core/{resource-loader,skills,prompt-templates}.ts
in the local Pi checkout (be14d973). Resource loading never executes a skill.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from html import escape
from pathlib import Path
from typing import cast

import yaml
from pathspec import GitIgnoreSpec

from .common import Profile
from .contracts import BackendError, Model, ResourceOptions
from .memories import session_workspace
from .workspace_map import PRIMARY, load_grants

CONTEXT_NAMES = ("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")
IGNORE_NAMES = (".gitignore", ".ignore", ".fdignore")
FILE_LIMIT = 64 * 1024
ENTRY_LIMIT = 2048


class ResourceItem(Model):
    name: str
    path: str
    description: str = ""
    disable_model_invocation: bool = False
    scope: str = "user"
    editable: bool = False


class ResourceCatalog(Model):
    context_files: list[str]
    skills: list[ResourceItem]
    prompts: list[ResourceItem]
    diagnostics: list[str]
    skill_directory: str = ""


@dataclass
class LoadedResources:
    catalog: ResourceCatalog
    context: list[tuple[str, str]]
    templates: dict[str, str]

    def system_context(self) -> str:
        sections: list[str] = []
        if self.context:
            sections.append("Project-specific instructions and guidelines:\n\n" + "\n\n".join(
                f'<project_instructions path="{escape(path, quote=True)}">\n{content}\n</project_instructions>'
                for path, content in self.context))
        visible = [item for item in self.catalog.skills if not item.disable_model_invocation]
        if visible:
            # Pi also uses its shell tool when its read tool is unavailable. Our
            # read_file API is restricted to grants; shell keeps its normal approval.
            sections.append("\n".join([
                "The following skills provide specialized instructions for specific tasks.",
                "Use shell to load a skill's file when the task matches its description.",
                "Resolve relative references against the skill directory and use absolute paths in tool commands.",
                "<available_skills>",
                *(f'  <skill><name>{escape(item.name)}</name><description>{escape(item.description)}</description>'
                  f'<location>{escape(item.path)}</location></skill>' for item in visible),
                "</available_skills>",
            ]))
        return "\n\n".join(sections)

    def expand(self, text: str) -> str:
        matched = re.fullmatch(r"/([^\s]+)(?:\s+([\s\S]*))?", text)
        if not matched:
            return text
        name, arguments = matched[1], matched[2] or ""
        if name.startswith("skill:"):
            skill = next((item for item in self.catalog.skills if item.name == name[6:]), None)
            if skill is None:
                return text
            _, body = frontmatter(read_text(Path(skill.path)))
            block = (f'<skill name="{skill.name}" location="{skill.path}">\n'
                     f'References are relative to {Path(skill.path).parent}.\n\n{body.strip()}\n</skill>')
            return block + ("\n\n" + arguments.strip() if arguments.strip() else "")
        content = self.templates.get(name)
        return text if content is None else substitute_args(content, parse_command_args(arguments))


def read_text(path: Path) -> str:
    with path.open("rb") as handle:
        data = handle.read(FILE_LIMIT + 1)
    if len(data) > FILE_LIMIT:
        raise BackendError("resource_file_limit")
    return data.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


class _FrontmatterLoader(yaml.SafeLoader):
    pass


# Pi uses YAML's core schema: yes/no are strings, not YAML 1.1 booleans.
_FrontmatterLoader.yaml_implicit_resolvers = {
    key: [(tag, pattern) for tag, pattern in entries if tag not in {
        "tag:yaml.org,2002:bool", "tag:yaml.org,2002:timestamp"}]
    for key, entries in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
for _first in "tTfF":
    _FrontmatterLoader.yaml_implicit_resolvers.setdefault(_first, []).append((
        "tag:yaml.org,2002:bool", re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$")))


def frontmatter(text: str) -> tuple[dict[str, object], str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    loaded: object = yaml.load(text[4:end], Loader=_FrontmatterLoader)
    if loaded is None:
        return {}, text[end + 4:].strip()
    if not isinstance(loaded, dict):
        raise ValueError("frontmatter must be a mapping")
    mapping = cast(dict[object, object], loaded)
    if not all(isinstance(key, str) for key in mapping):
        raise ValueError("frontmatter keys must be strings")
    return cast(dict[str, object], mapping), text[end + 4:].strip()


def parse_command_args(text: str) -> list[str]:
    # Pi deliberately treats backslashes literally and accepts unfinished quotes.
    args: list[str] = []
    current, quote, started = "", "", False
    for char in text:
        if quote:
            if char == quote:
                quote = ""
            else:
                current += char
        elif char in {"'", '"'}:
            quote, started = char, True
        elif char.isspace():
            if started:
                args.append(current)
                current, started = "", False
        else:
            current, started = current + char, True
    if started:
        args.append(current)
    return args


_ARGUMENT = re.compile(r"\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)")


def substitute_args(content: str, args: list[str]) -> str:
    def replace(match: re.Match[str]) -> str:
        default_target, default, start, length, simple = match.groups()
        if default_target:
            value = " ".join(args) if default_target in {"@", "ARGUMENTS"} else positional(int(default_target))
            return value or default
        if start is not None:
            index = max(0, int(start) - 1)
            return " ".join(args[index:] if length is None else args[index:index + int(length)])
        return " ".join(args) if simple in {"@", "ARGUMENTS"} else positional(int(simple))

    def positional(index: int) -> str:
        return args[index - 1] if 1 <= index <= len(args) else ""

    return _ARGUMENT.sub(replace, content)


def _context_file(directory: Path) -> Path | None:
    return next((directory / name for name in CONTEXT_NAMES if (directory / name).is_file()), None)


def _shadowed_context(cwd: Path) -> Path | None:
    for directory in (cwd, *cwd.parents):
        git = directory / ".git"
        if git.is_dir():
            return None
        if not git.is_file():
            continue
        text = read_text(git).strip()
        if not text.startswith("gitdir:"):
            return None
        git_dir = (directory / text[7:].strip()).resolve()
        common_file = git_dir / "commondir"
        if not common_file.is_file():
            return None
        common = (git_dir / read_text(common_file).strip()).resolve()
        main = common.parent
        own_context = _context_file(directory)
        if own_context and directory.is_relative_to(main) and (main / ".git").resolve() == common:
            return main / own_context.name
        return None
    return None


@dataclass
class _Discovery:
    diagnostics: list[str] = field(default_factory=lambda: list[str]())
    entries: int = 0

    def visit(self) -> None:
        self.entries += 1
        if self.entries > ENTRY_LIMIT:
            raise BackendError("resource_capacity")

    def warning(self, path: Path, error: object) -> None:
        self.diagnostics.append(f"{path}: {type(error).__name__ if isinstance(error, Exception) else error}")

    def skill_files(self, root: Path) -> list[Path]:
        seen: set[Path] = set()
        rules: list[str] = []
        result: list[Path] = []

        def walk(directory: Path, root_files: bool) -> None:
            self.visit()
            actual = directory.resolve()
            if actual in seen:
                return
            seen.add(actual)
            for filename in IGNORE_NAMES:
                ignore = directory / filename
                if not ignore.is_file():
                    continue
                prefix = directory.relative_to(root).as_posix()
                prefix = "" if prefix == "." else prefix + "/"
                for line in read_text(ignore).splitlines():
                    if not line.strip() or line.startswith("#"):
                        continue
                    negated = line.startswith("!")
                    pattern = line[1:] if negated else line
                    if pattern.startswith("\\!"):
                        pattern = pattern[1:]
                    rules.append(("!" if negated else "") + prefix + pattern.removeprefix("/"))
            matcher = GitIgnoreSpec.from_lines(rules)
            declared = directory / "SKILL.md"
            if declared.is_file() and not matcher.match_file(declared.relative_to(root).as_posix()):
                result.append(declared)
                return
            for entry in sorted(directory.iterdir()):
                self.visit()
                if entry.name.startswith(".") or entry.name == "node_modules":
                    continue
                is_dir = entry.is_dir()
                relative = entry.relative_to(root).as_posix() + ("/" if is_dir else "")
                if matcher.match_file(relative):
                    continue
                if is_dir:
                    walk(entry, False)
                elif root_files and entry.is_file() and entry.suffix == ".md":
                    result.append(entry)
        walk(root, True)
        return result


def load_resources(cwd: Path, agent_dir: Path, options: ResourceOptions) -> LoadedResources:
    cwd, agent_dir = cwd.resolve(), agent_dir.expanduser().resolve()
    discovery = _Discovery()
    context: list[tuple[str, str]] = []
    seen: set[Path] = set()
    if not options.no_context_files:
        shadowed = _shadowed_context(cwd)
        directories = [agent_dir, *reversed((cwd, *cwd.parents))]
        for directory in directories:
            path = _context_file(directory)
            if path is None or path == shadowed or path.resolve() in seen:
                continue
            try:
                context.append((str(path), read_text(path)))
                seen.add(path.resolve())
            except (OSError, UnicodeError) as error:
                discovery.warning(path, error)
    skills: dict[str, ResourceItem] = {}
    skill_paths = ([] if options.no_skills else [agent_dir / "skills", cwd / ".amazme/skills"])
    skill_paths += [_resolve_path(path, cwd) for path in options.skill_paths]
    seen_skills: set[Path] = set()
    for path in skill_paths:
        try:
            candidates = discovery.skill_files(path) if path.is_dir() else [path] if path.is_file() else []
            for candidate in candidates:
                actual = candidate.resolve()
                if actual in seen_skills:
                    continue
                seen_skills.add(actual)
                try:
                    metadata, _ = frontmatter(read_text(candidate))
                except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
                    discovery.warning(candidate, error)
                    continue
                description = metadata.get("description")
                if not isinstance(description, str) or not description.strip():
                    if candidate.name == "SKILL.md":
                        discovery.warning(candidate, "description_required")
                    continue
                declared_name = metadata.get("name")
                name = declared_name if isinstance(declared_name, str) and declared_name else candidate.parent.name
                if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64 or len(description) > 1024:
                    discovery.warning(candidate, "skill_metadata_warning")
                if name in skills:
                    discovery.warning(candidate, "skill_name_collision")
                    continue
                skills[name] = ResourceItem(name=name, path=str(actual), description=description,
                    disable_model_invocation=metadata.get("disable-model-invocation") is True,
                    scope="user" if actual.is_relative_to(agent_dir) else "project",
                    editable=actual == agent_dir / "skills" / name / "SKILL.md")
        except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
            discovery.warning(path, error)
    templates: dict[str, str] = {}
    prompts: list[ResourceItem] = []
    prompt_paths = ([] if options.no_prompt_templates else [agent_dir / "prompts", cwd / ".amazme/prompts"])
    prompt_paths += [_resolve_path(path, cwd) for path in options.prompt_paths]
    for path in prompt_paths:
        try:
            candidates = sorted(path.glob("*.md")) if path.is_dir() else [path] if path.is_file() else []
            for candidate in candidates:
                discovery.visit()
                try:
                    metadata, body = frontmatter(read_text(candidate))
                except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
                    discovery.warning(candidate, error)
                    continue
                name = candidate.stem
                # Pi expands the first matching template.
                if name in templates:
                    continue
                templates[name] = body
                description = metadata.get("description")
                first_line = next((line for line in body.splitlines() if line.strip()), "")
                prompts.append(ResourceItem(name=name, path=str(candidate.resolve()),
                    description=description if isinstance(description, str) and description else first_line[:60]))
        except (OSError, UnicodeError, ValueError, yaml.YAMLError) as error:
            discovery.warning(path, error)
    if len(skills) > 128 or len(prompts) > 128:
        raise BackendError("resource_capacity")
    return LoadedResources(ResourceCatalog(context_files=[path for path, _ in context],
        skills=list(skills.values()), prompts=prompts, diagnostics=discovery.diagnostics,
        skill_directory=str(agent_dir / "skills")), context, templates)


def _resolve_path(path: str, cwd: Path) -> Path:
    return cwd / Path(path.strip()).expanduser()


def agent_directory(profile: Profile) -> Path:
    return Path(profile.config.user_resources or os.environ.get("AMAZME_CODING_AGENT_DIR") or str(Path.home() / ".amazme/agent")).expanduser().resolve()


def session_resources(profile: Profile, session: str, options: ResourceOptions) -> LoadedResources:
    workspace = session_workspace(profile.path, session)
    location = profile.config.workspace if workspace == PRIMARY else dict(load_grants(profile.path)).get(workspace)
    if location is None:
        raise BackendError("workspace_not_found")
    return load_resources(Path(location), agent_directory(profile), options)
