"""SDK, CLI and TUI send client zones into the real session writer."""
import sqlite3

from test_client import _cli, _serve, _stop

from amazme_backend.interfaces.tui import _submit_text
from amazme_backend.profiles.layout import session_database
from amazme_backend.sdk import Client


async def test_python_clients_preserve_reported_zone_in_durable_requests(tmp_path, monkeypatch):
    process, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    try:
        async with Client(url, token) as client:
            session = await client.create_session(title="clock", workspace="primary")
            attachment = await client.attach(session.session_id)
            await client.submit(session_id=session.session_id, workspace="primary", attachment_id=attachment.attachment_id,
                request_id="sdk-clock", text="sdk-clock", time_zone="Asia/Shanghai")
            assert (await client.wait(session_id=session.session_id, request_id="sdk-clock")).status == "succeeded"
            command = _cli(url, token, "submit", "--session", session.session_id, "--workspace", "primary",
                "--request-id", "cli-clock", "--text", "cli-clock", "--time-zone", "America/New_York")
            assert command.returncode == 0, command.stderr
            monkeypatch.setenv("TZ", "Pacific/Auckland")
            assert await _submit_text(client, session, attachment, "primary", "tui-clock", []) is None
            with sqlite3.connect(session_database(profile, session.session_id).resolve().as_uri() + "?mode=ro", uri=True) as db:
                zones = dict(db.execute("SELECT json_extract(q.payload,'$.text'),json_extract(r.payload,'$.config.time_zone') "
                    "FROM requests q JOIN runs r ON q.id=r.request_id"))
            assert zones == {"sdk-clock":"Asia/Shanghai", "cli-clock":"America/New_York", "tui-clock":"Pacific/Auckland"}
    finally:
        _stop(process, profile)
