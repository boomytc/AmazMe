"""Classification transport using resolved request auth supplied by the caller."""
import asyncio

import httpx

from amazme_backend.ai.classification.catalog import INDEX
from amazme_backend.ai.classification.system_one import RECORD, parse_answers, wire_request
from amazme_backend.ai.classification.types import ClassifierContext, ClassifierResult
from amazme_backend.ai.types import Auth, AuthSource, RequestTransport
from amazme_backend.shared.errors import BackendError


async def classify(provider: str, model_id: str, context: ClassifierContext, *,
                   auth: AuthSource, transport: RequestTransport | None = None, timeout_ms: int = 30000) -> ClassifierResult:
    result = ClassifierResult(provider=provider,model=model_id)
    try:
        model = INDEX.get((provider,model_id))
        if model is None:
            raise BackendError('classifier_model_missing')
        payload,headers = wire_request(model,context)
        connection = transport if transport is not None else RequestTransport()
        resolved = auth if isinstance(auth, Auth) else await auth()
        if not resolved.api_key.get_secret_value():
            raise BackendError('provider_not_configured')
        headers = {'User-Agent':'pi', **model.headers, **headers, **connection.headers, **resolved.headers,
            'Authorization':'Bearer '+resolved.api_key.get_secret_value()}
        async with httpx.AsyncClient(proxy=connection.proxy or None,
                                     trust_env=False,timeout=timeout_ms / 1000) as client:
            async with client.stream('POST',model.base_url.rstrip('/')+'/systemone',json=payload,headers=headers) as response:
                if response.is_error:
                    raise BackendError('classifier_http_'+str(response.status_code))
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > 2 * 1024 * 1024:
                        raise BackendError('classifier_response_limit')
        body = RECORD.validate_json(content)
        result.usage = RECORD.validate_python(body.get('usage',{}))
        result.answers = parse_answers(body,context)
    except asyncio.CancelledError:
        raise
    except (BackendError,httpx.HTTPError,ValueError) as error:
        result.stop_reason = 'error'
        result.error = error.code if isinstance(error,BackendError) else 'classifier_response_invalid' if isinstance(error,ValueError) else 'classifier_transport'
    return result
