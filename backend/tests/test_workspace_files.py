"""Workspace browse and checked writes stay inside the granted directory."""
import hashlib
import json
import os
from pathlib import Path

import httpx
import pytest

from amazme_backend.common import Profile, private_write
from amazme_backend.contracts import BackendError, HostFence, PrepareUpdate, ProcessLease
from amazme_backend.host import Host, application
from amazme_backend.workspace_files import FileWrite, list_files, read_file, write_file


def test_browse_read_and_checked_write(tmp_path: Path) -> None:
    root = tmp_path / "work"
    root.mkdir()
    (root / "note.txt").write_text("alpha\n")
    (root / "nested").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    (root / "escape").symlink_to(outside / "secret.txt")
    (root / "alias").symlink_to(root / "note.txt")
    listed = list_files(root)
    assert {item.name for item in listed.entries} >= {"note.txt", "escape", "alias", "nested"}
    assert read_file(root, "note.txt").content == "alpha\n"
    assert read_file(root, "alias").content == "alpha\n"
    with pytest.raises(BackendError, match="workspace_path_escape"):
        read_file(root, "escape")
    with pytest.raises(BackendError, match="invalid_workspace_path"):
        read_file(root, "../secret.txt")
    opened = read_file(root, "note.txt")
    changed = write_file(root, FileWrite(path="note.txt", content="beta\n", expected_digest=opened.digest))
    assert "alpha" in changed.diff and "beta" in changed.diff
    assert (root / "note.txt").read_text() == "beta\n"
    (root / "sub").mkdir()
    (root / "sub" / "inner.txt").write_text("in\n")
    (root / "linkdir").symlink_to(root / "sub", target_is_directory=True)
    with pytest.raises(BackendError, match="workspace_not_directory"):
        list_files(root, "linkdir")
    with pytest.raises(BackendError, match="workspace_not_directory"):
        read_file(root, "linkdir/inner.txt")
    assert read_file(root, "sub/inner.txt").content == "in\n"
    (root / "bin.dat").write_bytes(b"\xff")
    with pytest.raises(BackendError, match="file_not_text"):
        read_file(root, "bin.dat")
    for index in range(201):
        (root / f"n{index:03d}.txt").write_text("x")
    page = list_files(root)
    assert page.truncated and len(page.entries) == 200
    following = list_files(root, offset=200)
    assert following.offset == 200 and following.limit == 200 and not following.truncated
    assert page.total == following.total == len(list(root.iterdir()))
    names = [entry.name for entry in [*page.entries, *following.entries]]
    assert len(names) == len(set(names)) == page.total and set(names) == {item.name for item in root.iterdir()}
    assert list_files(root, offset=following.total).entries == []
    with pytest.raises(BackendError, match="invalid_workspace_page"):
        list_files(root, offset=-1)
    with pytest.raises(BackendError, match="workspace_missing"):
        list_files(root, "gone")
    with pytest.raises(BackendError, match="workspace_missing"):
        read_file(root, "gone.txt")


def test_hardlink_and_stale_digest_do_not_write(tmp_path: Path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("alpha\n")
    os.link(target, tmp_path / "linked.txt")
    digest = hashlib.sha256(b"alpha\n").hexdigest()
    with pytest.raises(BackendError, match="workspace_hardlink_write"):
        write_file(tmp_path, FileWrite(path="note.txt", content="beta\n", expected_digest=digest))
    assert target.read_text() == "alpha\n"
    (tmp_path / "linked.txt").unlink()
    with pytest.raises(BackendError, match="file_conflict"):
        write_file(tmp_path, FileWrite(path="note.txt", content="beta\n", expected_digest="0" * 64))
    assert target.read_text() == "alpha\n"
    created = write_file(tmp_path, FileWrite(path="fresh.txt", content="new\n", expected_digest=""))
    assert (tmp_path / "fresh.txt").read_text() == "new\n"
    assert created.digest == hashlib.sha256(b"new\n").hexdigest()
    (tmp_path / "sub").mkdir()
    (tmp_path / "via").symlink_to(tmp_path / "sub")
    with pytest.raises(BackendError, match="workspace_symlink_write"):
        write_file(tmp_path, FileWrite(path="via/child.txt", content="x", expected_digest=""))
    locked = tmp_path / "locked.txt"
    locked.write_text("alpha\n")
    locked.chmod(0)
    try:
        with pytest.raises(BackendError, match="workspace_permission"):
            write_file(tmp_path, FileWrite(path="locked.txt", content="beta\n", expected_digest=digest))
        locked.chmod(0o644)
        assert locked.read_text() == "alpha\n"
    finally:
        locked.chmod(0o644)
    (tmp_path / "dir").mkdir()
    with pytest.raises(BackendError, match="workspace_not_file"):
        write_file(tmp_path, FileWrite(path="dir", content="x", expected_digest=""))
    huge = "你" * 400_000
    with pytest.raises(BackendError, match="file_too_large"):
        write_file(tmp_path, FileWrite(path="note.txt", content=huge, expected_digest=digest))
    assert target.read_text() == "alpha\n"


@pytest.fixture
async def owner(tmp_path: Path):
    private_write(tmp_path / "config.json", json.dumps({
        "format": 2, "profile_id": "files", "workspace": str(tmp_path / "work"), "resources": "unused",
        "provider": {"provider": "faux"}}))
    (tmp_path / "work").mkdir()
    (tmp_path / "work" / "note.txt").write_text("alpha\n")
    private_write(tmp_path / "control.token", "private-control")
    private_write(tmp_path / "web.token", "web-only")
    value = Host(Profile(tmp_path))
    lease = ProcessLease(instance_id="host", role="host", profile_path=str(tmp_path),
                         path=str(tmp_path / "lease"), device=1, inode=1)
    value.fence = HostFence(host_epoch=1, build_id=value.build)
    value.fence.host_epoch = await value.store.initialize(value.instance, value.build, lease)
    value.origin = "http://127.0.0.1:12345"
    try:
        yield value
    finally:
        await value.supervisor.close()
        await value.store.db.close()


async def test_file_route_reads_and_writes_the_granted_workspace(owner: Host) -> None:
    app = application(owner)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=owner.origin,
                                  headers={"Authorization": "Bearer web-only"}) as client:
        listed = await client.get("/api/v1/files")
        assert listed.status_code == 200
        assert any(item["name"] == "note.txt" for item in listed.json()["entries"])
        for index in range(205):
            (Path(owner.profile.config.workspace) / f"z{index:03}.txt").touch()
        second = await client.get("/api/v1/files", params={"offset": 200})
        assert second.status_code == 200
        assert second.json()["offset"] == second.json()["limit"] == 200 and second.json()["total"] == 206
        assert [row["name"] for row in second.json()["entries"]] == [f"z{index:03}.txt" for index in range(199, 205)]
        assert (await client.get("/api/v1/files", params={"offset": -1})).status_code == 422
        content = await client.get("/api/v1/files/content", params={"path": "note.txt"})
        assert content.json()["content"] == "alpha\n"
        client.headers.update({"x-amazme-build": owner.build, "x-amazme-epoch": str(owner.fence.host_epoch)})
        saved = await client.post("/api/v1/files/content", json={
            "path": "note.txt", "content": "beta\n", "expected_digest": content.json()["digest"]})
        assert saved.status_code == 200 and "beta" in saved.json()["diff"]
        await owner.store.begin_update(PrepareUpdate(update_id="freeze-files", target_build="ab" * 32), owner.build)
        blocked = await client.post("/api/v1/files/content", json={
            "path": "note.txt", "content": "gamma\n", "expected_digest": saved.json()["digest"]})
        assert blocked.status_code == 503 and blocked.json()["code"] == "update_frozen"
    assert (Path(owner.profile.config.workspace) / "note.txt").read_text() == "beta\n"


def test_browser_saves_a_workspace_file_with_its_digest() -> None:
    node = __import__("shutil").which("node")
    if node is None:
        pytest.skip("node unavailable")
    import base64
    import json
    import subprocess
    web = Path(__file__).parents[1] / "src/amazme_backend/web"
    contract = (web / "contract.js").read_text().split("\n", 1)[1]
    contract = "const root = " + json.dumps(__import__("amazme_backend.contracts", fromlist=["Stream"]).Stream.model_json_schema()) + ";\n" + contract
    url = "data:text/javascript;base64," + base64.b64encode(contract.encode()).decode()
    source = (web / "app.js").read_text().replace('"/contract.js"', json.dumps(url))
    app_url = "data:text/javascript;base64," + base64.b64encode(source.encode()).decode()
    script = "const appURL=" + json.dumps(app_url) + ";\nconst html=" + json.dumps((web / "index.html").read_text()) + ";\n" + r'''
        import assert from 'node:assert/strict';
        import {Window} from 'happy-dom';
        const window = new Window({url:'http://127.0.0.1:1234/'});
        window.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs,''));
        Object.assign(globalThis,{window,document:window.document,location:window.location,sessionStorage:window.sessionStorage});
        const identity = {build_id:'build',host_epoch:1,state:'ready',profile_id:'host-1'};
        const response = (value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        globalThis.fetch = async (path, options={})=>{
          if(path==='/api/v1/bootstrap') return response(identity);
          if(path==='/api/v1/health') return response({state:'ready',identity});
          if(path==='/api/v1/sessions') return response({sessions:[]});
          if(path==='/api/v1/models') return response({models:[{provider:'faux',model:'faux',label:'本地确定性',endpoint_editable:false}],current:{provider:'faux',model:'faux',base_url:'',max_tokens:2048,key_configured:false,proxy:'',headers:{}}});
          if(path==='/api/v1/workspaces') return response({workspaces:[{name:'primary',host_path:'/work',host_path:'/workspace',primary:true}]});
          if(path.startsWith('/api/v1/files/content') && (options.method||'GET')==='GET') return response({path:'note.txt',digest:'abc',content:'alpha\n',truncated:false});
          if(path.startsWith('/api/v1/checkpoints?')) return response({checkpoints:[]});
          if(path==='/api/v1/files' || path.startsWith('/api/v1/files?')) {
            if(path.includes('nested')) return response({path:'nested',entries:[{name:'inner.txt',kind:'file',size:3}],truncated:false});
            return response({path:'',entries:[{name:'note.txt',kind:'file',size:6},{name:'nested',kind:'dir',size:0}],truncated:false});
          }
          if(path==='/api/v1/files/content') {
            const body=JSON.parse(options.body);
            assert.equal(body.path,'note.txt');
            assert.equal(body.expected_digest,'abc');
            assert.equal(body.content,'beta\n');
            assert.equal(options.headers['x-amazme-build'],'build');
            return response({path:'note.txt',digest:'def',diff:'--- note.txt\n+++ note.txt\n'});
          }
          throw Error('unexpected '+path);
        };
        const $=id=>document.getElementById(id);
        async function until(check) {
          for(let n=0;n<1000;n++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,1)); }
          throw Error('timed out '+$('error').textContent);
        }
        await import(appURL);
        $('files').open = true;
        $('files').dispatchEvent(new window.Event('toggle'));
        await until(()=>[...$('file-list').children].some(node=>node.textContent==='note.txt'));
        [...$('file-list').children].find(node=>node.textContent==='note.txt').click();
        await until(()=>$('file-content').value==='alpha\n');
        $('file-content').value='beta\n';
        $('file-save').click();
        await until(()=>$('file-diff').textContent.includes('note.txt'));
        [...$('file-list').children].find(node=>node.textContent==='nested/').click();
        await until(()=>[...$('file-list').children].some(node=>node.textContent==='inner.txt'));
        [...$('file-list').children].find(node=>node.textContent==='上级').click();
        await until(()=>[...$('file-list').children].some(node=>node.textContent==='note.txt'));
        window.happyDOM && await window.happyDOM.abort();
    '''
    result = subprocess.run([node, "--input-type=module"], input=script, text=True, capture_output=True, timeout=20,
                            cwd=Path(__file__).parents[1])
    assert result.returncode == 0, result.stderr[-4000:] + result.stdout[-1000:]
