from amazme_backend.contracts import CatalogModel, ModelScopeRequest
from amazme_backend.model_scope import resolve_scope


def catalog() -> list[CatalogModel]:
    return [CatalogModel(provider=provider, model=model, label=model, endpoint_editable=True)
        for provider, model in [("one","sonnet"),("one","sonnet-20260101"),("two","sonnet"),
            ("one","bracketed[1m]"),("gateway","one/sonnet"),("one","version:high")]]


def scope(*patterns: str):
    return resolve_scope(ModelScopeRequest(patterns=list(patterns)),catalog())


def test_provider_raw_ids_literal_brackets_and_order_are_not_fuzzy_overridden() -> None:
    result = scope("one/sonnet:high", "sonnet", "bracketed[1m]", "version:high")
    assert [(item.model.provider,item.model.model,item.thinking) for item in result.models] == [
        ("one","sonnet","high"),("two","sonnet",None),("one","bracketed[1m]",None),("one","version:high",None)]
    assert len(result.diagnostics) == 1 and "several providers" in result.diagnostics[0]


def test_fuzzy_prefers_aliases_and_scope_patterns_keep_order_first_thinking_and_warnings() -> None:
    result = scope("son:low", "one/*:high", "sonnet:invalid", "missing")
    assert [(item.model.provider,item.model.model,item.thinking) for item in result.models[:2]] == [
        ("one","sonnet","low"),("two","sonnet","low")]
    assert next(item for item in result.models if item.model.model.endswith("20260101")).thinking == "high"
    assert any("Invalid thinking level" in item for item in result.diagnostics)
    assert result.diagnostics[-1] == 'No models match pattern "missing"'
    assert len(result.models) == len({(item.model.provider,item.model.model) for item in result.models})


async def test_explicit_request_model_is_pinned_across_retries_and_restart(tmp_path) -> None:
    import pytest

    from amazme_backend.contracts import BackendError, HostFence, ModelSelection, ProviderConfig, Submit
    from amazme_backend.session_domain import Continue, ModelInvocation
    from amazme_backend.storage import SessionStore

    fence = HostFence(host_epoch=1, build_id="model-snapshot")
    path = tmp_path / "session.sqlite"
    store = SessionStore(path, "session", build=fence.build_id, config=ProviderConfig(provider="faux",model="faux"))
    await store.initialize()
    await store.fence(fence)
    original = Submit(request_id="original",text="task",model_selection=ModelSelection(provider="deepseek",model="deepseek-flash"))
    try:
        await store.accept(original,fence)
        store.config = ProviderConfig(provider="faux",model="faux")
        await store.accept(original,fence)
        with pytest.raises(BackendError,match="request_conflict"):
            await store.accept(original.model_copy(update={"model_selection":ModelSelection(provider="faux",model="faux")}),fence)
    finally:
        await store.db.close()
    reopened = SessionStore(path,"session",build=fence.build_id,config=ProviderConfig(provider="faux",model="faux"),require_existing=True)
    try:
        await reopened.initialize()
        for _ in range(30):
            action = await reopened.advance()
            if isinstance(action,Continue):
                continue
            assert isinstance(action,ModelInvocation)
            assert (action.config.provider,action.config.model) == ("deepseek","deepseek-flash")
            assert not action.config.api_key.get_secret_value()
            break
        else:
            pytest.fail("No model invocation")
    finally:
        await reopened.db.close()
