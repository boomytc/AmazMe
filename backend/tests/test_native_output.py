"""The public submission path retains logs across client detach and reattach."""
import json
import shlex
import sys

from test_client import _serve, _stop

from amazme_backend.sdk import Client


async def test_shell_output_can_be_paged_after_reconnect(tmp_path):
    process, url, profile = _serve(tmp_path)
    token = (profile / "web.token").read_text().strip()
    expected = "中文\n" * 12000
    try:
        async with Client(url, token) as client:
            session = await client.create_session(workspace="primary", title="output")
            attachment = await client.attach(session.session_id)
            code = "import sys;sys.stdout.write('中文\\n'*12000);sys.stderr.write('错误\\n')"
            command = shlex.join([sys.executable, "-c", code])
            await client.rpc("request.submit", session_id=session.session_id, workspace="primary",
                attachment_id=attachment.attachment_id, request_id="produce", text="produce output",
                approval_policy="auto", tool_call={"id":"shell", "name":"shell", "arguments":json.dumps({"command":command})})
            receipt = await client.wait(session_id=session.session_id, request_id="produce")
            assert receipt.status == "succeeded", receipt
            result = json.loads(receipt.answer)
            assert result["truncated"] and result["output"]["stdout"]["observed_bytes"] == len(expected.encode())
            assert "\ufffd" not in result["stdout"]
            locator = result["output"]["locator"]
            await client.release(session_id=session.session_id, attachment_id=attachment.attachment_id)
        async with Client(url, token) as client:
            attachment = await client.attach(session.session_id)
            content, offset, pages = "", 0, 0
            while True:
                await client.rpc("request.submit", session_id=session.session_id, workspace="primary",
                    attachment_id=attachment.attachment_id, request_id=f"page-{pages}", text="read output",
                    approval_policy="auto", tool_call={"id":"read", "name":"tool_output",
                        "arguments":json.dumps({"locator":locator, "offset":offset, "limit":16000})})
                receipt = await client.wait(session_id=session.session_id, request_id=f"page-{pages}")
                assert receipt.status == "succeeded", receipt
                page = json.loads(json.loads(receipt.answer)["stdout"])
                content += page["content"]
                assert page["next_offset"] > offset
                offset, pages = page["next_offset"], pages + 1
                if not page["has_more"]:
                    break
            assert pages > 1 and content == expected
    finally:
        _stop(process, profile)
