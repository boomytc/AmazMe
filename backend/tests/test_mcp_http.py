"""The real owned HTTP gate uses the same approval and stable-call ledger as stdio."""
import asyncio
import socket
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import test_native_mcp as fixtures
import uvicorn
from fastapi import FastAPI, Request, Response

from amazme_backend.contracts import BackendError, McpHttpSettings, McpOAuthSettings, OpenMcp
from amazme_backend.mcp_auth import McpAuth, TokenStore, callback_id_for

terminal_owner = fixtures.terminal_owner


async def test_http_gate_preserves_approval_result_and_original_id(terminal_owner):
    owner = terminal_owner
    app, calls = FastAPI(), []

    @app.post("/mcp")
    async def rpc(request: Request):
        body = await request.json()
        method, identity = body.get("method"), body.get("id")
        if identity is None:
            return Response(status_code=202)
        if method == "initialize":
            result = {"protocolVersion": "2025-11-25", "serverInfo": {"name": "http-fixture", "version": "1"}, "capabilities": {"tools": {}}}
        elif method == "tools/list":
            result = {"tools": [{"name": "demo.echo", "inputSchema": {"type": "object"}}]}
        else:
            calls.append(body)
            result = {"content": [{"type": "text", "text": "中文🙂"}], "isError": False}
        return {"jsonrpc": "2.0", "id": identity, "result": result}

    @app.delete("/mcp")
    async def close():
        return Response(status_code=204)

    listener = socket.create_server(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="error"))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(.01)
        url = f"http://127.0.0.1:{listener.getsockname()[1]}/mcp"
        opened = await owner.open_mcp(OpenMcp(**fixtures.query(owner).model_dump(), command=url,
                                            http=McpHttpSettings(url=url)))
        assert opened.phase == "ready" and opened.tools[0].name == "demo.echo"
        call = await fixtures.proposal(owner)
        assert call.phase == "waiting_approval" and not calls
        await fixtures.approve(owner, call)
        result = await fixtures.completed(owner, call.call_id)
        assert result.result == "中文🙂" and len(calls) == 1
        assert (await fixtures.proposal(owner)).phase == "done" and len(calls) == 1
        assert (await owner.cancel_mcp(fixtures.query(owner))).clean
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)
        listener.close()


async def test_http_connection_never_starts_login_or_replays_uncertain_refresh(terminal_owner):
    owner = terminal_owner
    settings = McpHttpSettings(url="https://mcp.example/mcp", oauth=McpOAuthSettings())
    store = TokenStore(owner.profile, "remote", settings)
    requests = []
    def reject(request: httpx.Request):
        requests.append(request)
        return httpx.Response(401, headers={"www-authenticate": 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"'})
    async with httpx.AsyncClient(auth=McpAuth(settings, store), transport=httpx.MockTransport(reject)) as client:
        with pytest.raises(BackendError, match="mcp_oauth_authorization_required"):
            await client.post(settings.url)
        store.save(tokens={"access_token": "old", "token_type": "Bearer", "refresh_token": "single-use"}, uncertain=True)
        with pytest.raises(BackendError, match="mcp_oauth_authorization_required"):
            await client.post(settings.url)
    assert len(requests) == 1 and str(requests[0].url) == settings.url
    assert store.read()["uncertain"] is True


@pytest.mark.parametrize("registration", ["static", "cimd", "cimd-server"])
async def test_explicit_oauth_keeps_configured_client_callback_scope_and_pkce(terminal_owner, registration):
    settings = McpHttpSettings(url="https://mcp.example/mcp", oauth=McpOAuthSettings(scope="original-scope", **(
        {"clientId": "original-client"} if registration == "static" else {"clientRegistration": "cimd"})))
    store = TokenStore(terminal_owner.profile, "remote", settings, "http://127.0.0.1:18992/callback")
    store.authorizing = True
    authorization = {}
    token_requests = []
    async def publish(url):
        authorization.update(parse_qs(urlsplit(url).query))
    async def callback():
        return "fixture-code", authorization["state"][0]
    def respond(request):
        if request.url.host == "mcp.example" and request.url.path == "/mcp":
            return httpx.Response(200, json={"ok": True}) if request.headers.get("authorization") == "Bearer fixture-access" else httpx.Response(401)
        if "oauth-protected-resource" in request.url.path:
            return httpx.Response(200, json={"resource": settings.url, "authorization_servers": ["https://auth.example"], "scopes_supported": ["advertised-scope"]})
        if request.url.path.startswith("/.well-known/"):
            return httpx.Response(200, json={"issuer": "https://auth.example", "authorization_endpoint": "https://auth.example/authorize", "token_endpoint": "https://auth.example/token", "response_types_supported": ["code"], "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"], "client_id_metadata_document_supported": True, "authorization_response_iss_parameter_supported": registration == "cimd"})
        if request.url.path == "/token":
            token_requests.append(parse_qs(request.content.decode()))
            return httpx.Response(200, json={"access_token": "fixture-access", "token_type": "Bearer", "refresh_token": "fixture-refresh", "expires_in": 3600})
        raise AssertionError(str(request.url))
    async with httpx.AsyncClient(auth=McpAuth(settings, store, redirect=publish, callback=callback), transport=httpx.MockTransport(respond)) as client:
        assert (await client.post(settings.url)).status_code == 200
    expected = "original-client" if registration == "static" else "https://pi.dev/oauth/client.json" if registration == "cimd" else f"https://pi.dev/oauth/{callback_id_for(settings.url)}/client.json"
    assert authorization["client_id"] == [expected]
    assert authorization["redirect_uri"] == [store.redirect if registration != "cimd-server" else store.redirect + "/" + callback_id_for(settings.url)]
    assert authorization["scope"] == ["original-scope"] and authorization["code_challenge_method"] == ["S256"]
    assert len(token_requests) == 1 and token_requests[0]["client_id"] == [expected]
    if registration != "static":
        assert store.read()["client"]["client_id"] == expected
    assert token_requests[0]["code_verifier"] and store.read()["tokens"]["access_token"] == "fixture-access"


def test_http_rejects_remote_cleartext_credentials_and_non_loopback_callback():
    with pytest.raises(ValueError):
        McpHttpSettings(url="http://remote.example/mcp", headers={"Authorization": "token"})
    with pytest.raises(ValueError):
        McpOAuthSettings(callbackUrl="http://remote.example/callback")
