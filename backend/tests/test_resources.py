"""Native ports of Pi resource behavior; no model, account, or desktop driver."""
import json
from pathlib import Path

import pytest

from amazme_backend.accounts.store import AccountStore
from amazme_backend.contracts import (
    BackendError,
    CreateSession,
    HostFence,
    ProcessLease,
    ResourceOptions,
    Submit,
)
from amazme_backend.features.resources.service import (
    FILE_LIMIT,
    load_resources,
    parse_command_args,
    substitute_args,
)
from amazme_backend.host.store import HostStore
from amazme_backend.platform.private_files import private_write
from amazme_backend.profiles.layout import session_database
from amazme_backend.profiles.profile import Profile
from amazme_backend.sessions.service import SessionStore
from amazme_backend.sessions.types import Continue, ModelInvocation


def put(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


def skill(path: Path, name: str, body: str = "instructions", disabled: bool = False) -> Path:
    return put(path, f"---\nname: {name}\ndescription: Use {name}\ndisable-model-invocation: {str(disabled).lower()}\n---\n{body}")


def test_context_priority_order_and_resource_defaults(tmp_path: Path) -> None:
    agent = tmp_path / "agent"
    parent, cwd = tmp_path / "project", tmp_path / "project/nested"
    global_context = put(agent / "AGENTS.md", "global")
    parent_context = put(parent / "AGENTS.override.md", "parent override")
    put(parent / "AGENTS.md", "shadowed file")
    local_context = put(cwd / "CLAUDE.md", "local")
    user_skill = skill(agent / "skills/one/SKILL.md", "one")
    skill(cwd / ".amazme/skills/one/SKILL.md", "one", "loser")
    skill(cwd / ".amazme/skills/manual/SKILL.md", "manual", disabled=True)
    put(agent / "prompts/explain.md", "---\ndescription: Explain\n---\n$1 ${2:-default} $@")
    put(cwd / ".amazme/prompts/explain.md", "loser")
    loaded = load_resources(cwd, agent, ResourceOptions())
    assert loaded.catalog.context_files[-3:] == [str(global_context), str(parent_context), str(local_context)]
    assert loaded.catalog.skills[0].path == str(user_skill)
    assert len(loaded.catalog.skills) == 2
    assert any("skill_name_collision" in line for line in loaded.catalog.diagnostics)
    assert "parent override" in loaded.system_context() and "shadowed file" not in loaded.system_context()
    assert "<name>one</name>" in loaded.system_context()
    assert "<name>manual</name>" not in loaded.system_context()
    assert loaded.expand('/explain "hello world"') == "hello world default hello world"
    assert "<skill name=\"manual\"" in loaded.expand('/skill:manual do this')
    assert loaded.expand("/absent args") == "/absent args"
    assert loaded.expand("/skill:absent args") == "/skill:absent args"


def test_disabled_defaults_keep_explicit_paths_and_gitignore_rules(tmp_path: Path) -> None:
    agent, cwd = tmp_path / "agent", tmp_path / "workspace"
    cwd.mkdir()
    skill(agent / "skills/default/SKILL.md", "default")
    explicit = tmp_path / "explicit"
    skill(explicit / "yes/SKILL.md", "yes")
    skill(explicit / "ignored/SKILL.md", "ignored")
    skill(explicit / "children/keep/SKILL.md", "keep")
    skill(explicit / "children/drop/SKILL.md", "drop")
    put(explicit / ".gitignore", "ignored/\n")
    put(explicit / "children/.ignore", "drop/\n")
    (explicit / "loop").symlink_to(explicit, target_is_directory=True)
    prompt = put(tmp_path / "custom.md", "custom $1")
    loaded = load_resources(cwd, agent, ResourceOptions(no_context_files=True, no_skills=True,
        skill_paths=[str(explicit)], no_prompt_templates=True, prompt_paths=[str(prompt)]))
    assert [item.name for item in loaded.catalog.skills] == ["keep", "yes"]
    assert loaded.context == []
    assert loaded.expand("/custom ok") == "custom ok"
    assert loaded.expand("/skill:yes arg").endswith("</skill>\n\narg")


def test_bad_frontmatter_does_not_hide_later_resources(tmp_path: Path) -> None:
    root = tmp_path / "agent"
    put(root / "skills/a.md", "---\n[invalid\n---\nbad")
    skill(root / "skills/b.md", "good")
    put(root / "prompts/a.md", "---\n[invalid\n---\nbad")
    put(root / "prompts/b.md", "good")
    loaded = load_resources(tmp_path, root, ResourceOptions())
    assert [item.name for item in loaded.catalog.skills] == ["good"]
    assert [item.name for item in loaded.catalog.prompts] == ["b"]
    assert len(loaded.catalog.diagnostics) == 2


def test_nested_linked_worktree_shadows_only_the_same_context_scope(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    gitdir = repo / ".git/worktrees/feature"
    worktree = repo / "nested/feature"
    put(gitdir / "commondir", "../..")
    put(worktree / ".git", f"gitdir: {gitdir}")
    put(repo / "AGENTS.md", "main checkout")
    put(worktree / "AGENTS.md", "feature checkout")
    loaded = load_resources(worktree, tmp_path / "agent", ResourceOptions())
    assert "main checkout" not in loaded.system_context()
    assert "feature checkout" in loaded.system_context()


@pytest.mark.parametrize(("source", "expected"), [
    ('one "two words" \'\' "" back\\slash', ["one", "two words", "", "", "back\\slash"]),
    ('"unfinished quote', ["unfinished quote"]),
    ("   ", []),
])
def test_pi_argument_parser(source: str, expected: list[str]) -> None:
    assert parse_command_args(source) == expected


def test_substitution_is_one_pass_and_preserves_empty_and_slice_semantics() -> None:
    assert substitute_args("$1/$2/$@/${2:-default}/${@:0:2}/${@:3}", ["$2", "", "last"]) == "$2//$2  last/default/$2 /last"
    assert substitute_args("${1:-$2} ${@:-all}", []) == "$2 all"


def test_resource_input_is_bounded_instead_of_silently_truncated(tmp_path: Path) -> None:
    put(tmp_path / "agent/AGENTS.md", "x" * (FILE_LIMIT + 1))
    with pytest.raises(BackendError, match="resource_file_limit"):
        load_resources(tmp_path, tmp_path / "agent", ResourceOptions())


async def test_acceptance_pins_context_and_expansion_across_retry_and_restart(tmp_path: Path) -> None:
    profile_path, workspace, agent = tmp_path / "profile", tmp_path / "workspace", tmp_path / "agent"
    workspace.mkdir()
    profile_path.mkdir()
    private_write(profile_path / "config.json", json.dumps({"format":2, "profile_id":"resources",
        "workspace":str(workspace), "resources":"unused", "user_resources":str(agent), "provider":{"provider":"faux"}}))
    private_write(profile_path / "control.token", "control")
    profile = Profile(profile_path)
    context = put(workspace / "AGENTS.md", "original context")
    template = put(agent / "prompts/expand.md", "original $1")
    identity = "a" * 32
    host = HostStore(profile_path / "host.sqlite")
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(profile_path), path="lease", device=1, inode=1)
    await host.initialize("host", "test-build", lease)
    await host.create_session(identity, CreateSession())
    session_database(profile_path, identity).parent.mkdir(parents=True)
    def expand(text: str, options: ResourceOptions) -> tuple[str, str]:
        resources = load_resources(workspace, agent, options)
        return resources.expand(text), resources.system_context()

    def secrets() -> tuple[str, ...]:
        return (*AccountStore(profile.account_path).secrets(), profile.token,
                profile.config.provider.api_key.get_secret_value())

    store = SessionStore(session_database(profile_path, identity), identity,
                         expand_resources=expand, secret_source=secrets, approval_policy="auto")
    fence = HostFence(host_epoch=1, build_id="test-build")
    try:
        await store.initialize()
        await store.fence(fence)
        value = Submit(request_id="original-id", text="/expand hello")
        first = await store.accept(value, fence)
        context.write_text("changed context")
        template.write_text("changed $1")
        assert await store.accept(value, fence) == first
        await store.close()
        store = SessionStore(session_database(profile_path, identity), identity, expand_resources=expand, secret_source=secrets, require_existing=True)
        await store.initialize()
        for _ in range(20):
            action = await store.advance()
            if not isinstance(action, Continue):
                break
        assert isinstance(action, ModelInvocation)
        assert "original context" in action.config.append_system_prompt
        assert "changed context" not in action.config.append_system_prompt
        assert action.messages[-1].content == "original hello"
        context.write_text(profile.token)
        with pytest.raises(BackendError, match="resource_secret"):
            await store.accept(Submit(request_id="secret-resource", text="another turn"), fence)
        assert len((await store.snapshot()).requests) == 1
        with pytest.raises(BackendError, match="request_conflict"):
            await store.accept(value.model_copy(update={"resource_options":ResourceOptions(no_skills=True)}), fence)
    finally:
        await store.close()
        await host.db.close()
        profile.ipc.rmdir()
