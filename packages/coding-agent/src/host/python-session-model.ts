/** Persist a session's selected model on the Python host. Absent configuration is not an error. */

export interface PythonSessionModel {
	readonly provider: string;
	readonly model: string;
}

interface PythonIdentity {
	readonly build_id: string;
	readonly host_epoch: number;
}

function endpoint(): { base: string; token: string } | undefined {
	const base = process.env.AMAZME_PYTHON_URL;
	const token = process.env.AMAZME_PYTHON_TOKEN;
	if (!base || !token) return undefined;
	return { base: base.replace(/\/$/, ""), token };
}

async function identity(base: string, token: string): Promise<PythonIdentity> {
	const response = await fetch(`${base}/api/v1/bootstrap`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!response.ok) throw new Error(`python_bootstrap:${response.status}`);
	return await response.json() as PythonIdentity;
}

export async function loadPythonSessionModel(sessionId: string): Promise<PythonSessionModel | undefined> {
	const target = endpoint();
	if (target === undefined) return undefined;
	const response = await fetch(`${target.base}/api/v1/session-models/${encodeURIComponent(sessionId)}`, {
		headers: { authorization: `Bearer ${target.token}` },
	});
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`python_session_model:${response.status}`);
	const body = await response.json() as { provider: string; model: string };
	return { provider: body.provider, model: body.model };
}

export async function savePythonSessionModel(sessionId: string, model: PythonSessionModel): Promise<void> {
	const target = endpoint();
	if (target === undefined) return;
	const who = await identity(target.base, target.token);
	const response = await fetch(`${target.base}/api/v1/session-models/${encodeURIComponent(sessionId)}`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${target.token}`,
			"content-type": "application/json",
			"x-amazme-build": who.build_id,
			"x-amazme-epoch": String(who.host_epoch),
		},
		body: JSON.stringify({ session_id: sessionId, provider: model.provider, model: model.model }),
	});
	if (!response.ok) throw new Error(`python_session_model:${response.status}`);
}
