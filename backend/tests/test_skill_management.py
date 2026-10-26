"""Skill administration preserves the original assets and refuses stale or escaped writes."""

from pathlib import Path

from test_management import _client, _host

from amazme_backend.contracts import ProcessLease


def manifest(name: str, body: str = "instructions") -> str:
    return f"---\nname: {name}\ndescription: Use {name}\n---\n\n{body}\n"


async def test_skills_create_edit_import_and_remove_use_the_resource_loader_and_cas(tmp_path: Path) -> None:
    host = _host(tmp_path)
    host.lifecycle.profile.config.user_resources = str(tmp_path / "agent")
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, ProcessLease(
        instance_id="host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"), device=1, inode=1))
    source = tmp_path / "source"
    source.mkdir()
    (source / "SKILL.md").write_text(manifest("imported"))
    (source / "assets").mkdir()
    (source / "assets" / "example.txt").write_text("an imported asset")
    try:
        async with _client(host) as client:
            catalog = (await client.get("/api/v1/skills")).json()
            assert catalog["skill_directory"] == str(tmp_path / "agent" / "skills")
            created = await client.post("/api/v1/skills", json={"name": "one", "content": manifest("one")})
            assert created.status_code == 200 and created.json()["editable"] is True
            document = created.json()
            same = await client.post("/api/v1/skills", json={"name": "one", "content": manifest("one")})
            assert same.json()["digest"] == document["digest"]
            invalid = await client.post("/api/v1/skills", json={"name": "one", "content": "---\ndescription: [\n---\n"})
            assert invalid.status_code == 409 and invalid.json()["code"] == "invalid_skill_manifest"
            edited = await client.post("/api/v1/skills", json={
                "name": "one", "content": manifest("one", "edited"), "expected_digest": document["digest"]})
            assert edited.status_code == 200 and edited.json()["digest"] != document["digest"]
            stale = await client.post("/api/v1/skills", json={
                "name": "one", "content": manifest("one", "late"), "expected_digest": document["digest"]})
            assert stale.status_code == 409 and stale.json()["code"] == "skill_conflict"
            imported = await client.post("/api/v1/skills/import", json={"path": str(source)})
            assert imported.status_code == 200, imported.text
            target = Path(imported.json()["path"]).parent
            assert (target / "assets" / "example.txt").read_text() == "an imported asset"
            broken = tmp_path / "broken.md"
            broken.write_text("---\ndescription: [\n---\n")
            invalid_import = await client.post("/api/v1/skills/import", json={"path": str(broken)})
            assert invalid_import.status_code == 409 and invalid_import.json()["code"] == "invalid_skill_manifest"
            (source / "assets" / "example.txt").write_text("changed source")
            conflict = await client.post("/api/v1/skills/import", json={"path": str(source)})
            assert conflict.status_code == 409 and conflict.json()["code"] == "skill_exists"
            assert (target / "assets" / "example.txt").read_text() == "an imported asset"
            listing = (await client.get("/api/v1/skills")).json()["skills"]
            assert {item["name"] for item in listing} == {"one", "imported"}
            refused = await client.request("DELETE", "/api/v1/skills/one", json={"expected_digest": document["digest"]})
            assert refused.status_code == 409 and (await client.get("/api/v1/skills/one")).json()["content"] == manifest("one", "edited")
            for _ in range(2):
                removed = await client.request("DELETE", "/api/v1/skills/one", json={"expected_digest": edited.json()["digest"]})
                assert removed.status_code == 200 and removed.json()["removed"] is True
            assert (source / "SKILL.md").read_text() == manifest("imported")
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()


async def test_project_and_symlinked_skills_are_read_only(tmp_path: Path) -> None:
    host = _host(tmp_path)
    host.lifecycle.profile.config.user_resources = str(tmp_path / "agent")
    host.lifecycle.fence.host_epoch = await host.lifecycle.store.initialize(host.lifecycle.instance, host.lifecycle.build, ProcessLease(
        instance_id="host", role="host", profile_path=str(tmp_path), path=str(tmp_path / "lease"), device=1, inode=1))
    project = tmp_path / "primary" / ".amazme" / "skills" / "project"
    project.mkdir(parents=True)
    original = manifest("project")
    (project / "SKILL.md").write_text(original)
    user = tmp_path / "agent" / "skills"
    user.mkdir(parents=True)
    (user / "project").symlink_to(project, target_is_directory=True)
    try:
        async with _client(host) as client:
            document = (await client.get("/api/v1/skills/project")).json()
            assert document["editable"] is False and document["content"] == original
            saved = await client.post("/api/v1/skills", json={
                "name": "project", "content": manifest("project", "wrong"), "expected_digest": document["digest"]})
            assert saved.status_code == 409 and saved.json()["code"] == "skill_read_only"
            removed = await client.request("DELETE", "/api/v1/skills/project", json={"expected_digest": document["digest"]})
            assert removed.status_code == 409 and removed.json()["code"] == "skill_read_only"
            assert (project / "SKILL.md").read_text() == original
            escaped = await client.post("/api/v1/skills", json={"name": "../project", "content": original})
            assert escaped.status_code == 422
    finally:
        await host.lifecycle.supervisor.close()
        await host.lifecycle.store.db.close()
