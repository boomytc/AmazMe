import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, MemoryCredentialStore, type Credential } from "@amazme/ai";
import { encodeBedrockEvents } from "@amazme/ai/api/aws-event-stream";
import { signAwsRequest } from "@amazme/ai/api/aws-sigv4";
import { amazonBedrockProvider } from "@amazme/ai/providers/amazon-bedrock";
import { googleVertexProvider } from "@amazme/ai/providers/google-vertex";

const CONTEXT = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

/** Published Signature Version 4 example. Not a live credential. */
const EXAMPLE_ACCESS_KEY = "AKIDEXAMPLE";
const EXAMPLE_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

test("signature version 4 matches the published IAM example", () => {
  const signed = signAwsRequest({
    method: "GET",
    url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
    body: "",
    region: "us-east-1",
    service: "iam",
    credentials: { accessKeyId: EXAMPLE_ACCESS_KEY, secretAccessKey: EXAMPLE_SECRET },
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    now: new Date("2015-08-30T12:36:00.000Z"),
    payloadHashHeader: false,
  });
  assert.equal(
    signed.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
  const withHash = signAwsRequest({
    method: "GET",
    url: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
    body: "",
    region: "us-east-1",
    service: "iam",
    credentials: { accessKeyId: EXAMPLE_ACCESS_KEY, secretAccessKey: EXAMPLE_SECRET },
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    now: new Date("2015-08-30T12:36:00.000Z"),
  });
  assert.equal(
    withHash.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=dd479fa8a80364edf2119ec24bebde66712ee9c9cb2b0d92eb3ab9ccdc0c3947",
  );
});

test("bedrock signs environment keys and does not store them", async () => {
  const calls: Array<{ url: string; authorization: string; accept: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization") ?? "",
      accept: headers.get("accept") ?? "",
      body: String(init?.body ?? ""),
    });
    return bedrockSse();
  };
  const store = new MemoryCredentialStore();
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    store,
    env: { AWS_ACCESS_KEY_ID: "test-access-key", AWS_SECRET_ACCESS_KEY: "test-secret-key", AWS_REGION: "us-east-1" },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? "", /\/model\/amazon\.nova-2-lite-v1%3A0\/converse-stream$/);
  assert.equal(calls[0]?.accept, "application/vnd.amazon.eventstream");
  assert.match(calls[0]?.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/us-east-1\/bedrock\/aws4_request,/);
  assert.equal(calls[0]?.authorization.includes("test-secret-key"), false);
  assert.equal(calls[0]?.body.includes("test-secret-key"), false);
  assert.equal(await store.get("amazon-bedrock"), undefined);
});

test("bedrock signs a profile file and leaves only the pointer in the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-aws-"));
  const credentials = join(dir, "credentials");
  const config = join(dir, "config");
  writeFileSync(credentials, "[dev]\naws_access_key_id = file-access-key\naws_secret_access_key = file-secret-key\n");
  writeFileSync(config, "[profile dev]\nregion = us-east-1\n");
  const stored: Credential = {
    type: "api_key",
    env: { AWS_PROFILE: "dev", AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_CONFIG_FILE: config },
  };
  const calls: Array<{ url: string; authorization: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? "", body: String(init?.body ?? "") });
    return bedrockSse();
  };
  const store = new MemoryCredentialStore();
  await store.set("amazon-bedrock", stored);
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({ store, env: { AWS_BEARER_TOKEN_BEDROCK: "ambient-bearer", AWS_ACCESS_KEY_ID: "ambient-access", AWS_SECRET_ACCESS_KEY: "ambient-secret" } });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.match(calls[0]?.authorization ?? "", /Credential=file-access-key\//);
  assert.equal(calls[0]?.authorization.startsWith("Bearer"), false);
  assert.equal(calls[0]?.body.includes("file-secret-key"), false);
  assert.equal(calls[0]?.authorization.includes("file-secret-key"), false);
  assert.deepEqual(await store.get("amazon-bedrock"), stored);
});

test("a missing bedrock profile does not call the model stream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-aws-"));
  const credentials = join(dir, "credentials");
  writeFileSync(credentials, "[default]\n");
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return bedrockSse();
  };
  const store = new MemoryCredentialStore();
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    store,
    env: { AWS_PROFILE: "missing", AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_CONFIG_FILE: join(dir, "absent-config") },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /not configured/);
  assert.equal(calls, 0);
  assert.equal(await store.get("amazon-bedrock"), undefined);
});

test("bedrock environment keys still sign when the named profile is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-aws-"));
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers).get("authorization") ?? "");
    return bedrockSse();
  };
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    env: {
      AWS_PROFILE: "missing",
      AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
      AWS_CONFIG_FILE: join(dir, "config"),
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      AWS_REGION: "us-east-1",
    },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /Credential=test-access-key\//);
});

test("bedrock bearer is sent without signing when the environment provides one", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls.push(new Headers(init?.headers).get("authorization") ?? "");
    return bedrockSse();
  };
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({ env: { AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer", AWS_ACCESS_KEY_ID: "test-access-key", AWS_SECRET_ACCESS_KEY: "test-secret-key" } });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(calls, ["Bearer bedrock-bearer"]);
});

test("bedrock signs container credentials and does not store them", async () => {
  const calls: Array<{ url: string; authorization: string; token: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get("authorization") ?? "",
      token: headers.get("x-amz-security-token") ?? "",
      body: String(init?.body ?? ""),
    });
    if (String(input) === "https://container.test/creds") {
      return Response.json({ AccessKeyId: "container-access-key", SecretAccessKey: "container-secret-key", Token: "container-session-token" });
    }
    return bedrockSse();
  };
  const store = new MemoryCredentialStore();
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    store,
    env: {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "https://container.test/creds",
      AWS_SHARED_CREDENTIALS_FILE: join(tmpdir(), "amazme-aws-no-credentials"),
      AWS_CONFIG_FILE: join(tmpdir(), "amazme-aws-no-config"),
      AWS_REGION: "us-east-1",
    },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.equal(calls[0]?.url, "https://container.test/creds");
  assert.match(calls[1]?.url ?? "", /converse-stream$/);
  assert.match(calls[1]?.authorization ?? "", /Credential=container-access-key\//);
  assert.match(calls[1]?.authorization ?? "", /SignedHeaders=[^,]*x-amz-security-token/);
  assert.equal(calls[1]?.token, "container-session-token");
  assert.equal(calls[1]?.authorization.includes("container-session-token"), false);
  assert.equal(calls[1]?.authorization.includes("container-secret-key"), false);
  assert.equal(calls[1]?.body.includes("container-session-token"), false);
  assert.equal(calls[1]?.body.includes("container-secret-key"), false);
  assert.equal(await store.get("amazon-bedrock"), undefined);
});

test("bedrock web identity credentials sign the model request and stay out of the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-aws-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "web-identity-token");
  const calls: Array<{ url: string; authorization: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? "", body: String(init?.body ?? "") });
    if (String(input).startsWith("https://sts.")) {
      return new Response("<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>web-access-key</AccessKeyId><SecretAccessKey>web-secret-key</SecretAccessKey><SessionToken>web-session-token</SessionToken></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>");
    }
    return bedrockSse();
  };
  const store = new MemoryCredentialStore();
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    store,
    env: {
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/amazme",
      AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile,
      AWS_SHARED_CREDENTIALS_FILE: join(dir, "missing-credentials"),
      AWS_CONFIG_FILE: join(dir, "missing-config"),
      AWS_REGION: "us-west-2",
    },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.match(calls[0]?.url ?? "", /^https:\/\/sts\.us-west-2\.amazonaws\.com\//);
  assert.match(calls[0]?.body ?? "", /WebIdentityToken=web-identity-token/);
  assert.equal(calls[0]?.authorization, "");
  assert.match(calls[1]?.authorization ?? "", /Credential=web-access-key\//);
  assert.equal(calls[1]?.body.includes("web-identity-token"), false);
  assert.equal(calls[1]?.body.includes("web-secret-key"), false);
  assert.equal(await store.get("amazon-bedrock"), undefined);
});

test("a failed container credential exchange does not call the model stream", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response("no", { status: 500 });
  };
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    env: {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "https://container.test/creds",
      AWS_SHARED_CREDENTIALS_FILE: join(tmpdir(), "amazme-aws-missing-credentials"),
      AWS_CONFIG_FILE: join(tmpdir(), "amazme-aws-missing-config"),
    },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /could not be resolved/);
  assert.deepEqual(urls, ["https://container.test/creds"]);
  assert.equal(message.errorMessage?.includes("container.test"), false);
});

test("bedrock assume-role uses the assumed credentials and drops them after the request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-aws-"));
  const credentials = join(dir, "credentials");
  writeFileSync(credentials, [
    "[dev]",
    "role_arn = arn:aws:iam::123456789012:role/amazme",
    "source_profile = source",
    "[source]",
    "aws_access_key_id = source-access-key",
    "aws_secret_access_key = source-secret-key",
    "",
  ].join("\n"));
  const urls: string[] = [];
  const authorizations: string[] = [];
  const bodies: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    bodies.push(String(init?.body ?? ""));
    if (url.startsWith("https://sts.")) {
      return new Response("<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>assumed-access-key</AccessKeyId><SecretAccessKey>assumed-secret-key</SecretAccessKey><SessionToken>assumed-session-token</SessionToken></Credentials></AssumeRoleResult></AssumeRoleResponse>");
    }
    return bedrockSse();
  };
  const store = new MemoryCredentialStore();
  const stored: Credential = { type: "api_key", env: { AWS_PROFILE: "dev", AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_CONFIG_FILE: join(dir, "no-config"), AWS_REGION: "us-east-1" } };
  await store.set("amazon-bedrock", stored);
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({ store, env: {} });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.match(urls[0] ?? "", /^https:\/\/sts\.us-east-1\.amazonaws\.com\//);
  assert.match(authorizations[0] ?? "", /Credential=source-access-key\//);
  assert.match(urls[1] ?? "", /converse-stream$/);
  assert.match(authorizations[1] ?? "", /Credential=assumed-access-key\//);
  assert.equal(new Headers({ authorization: authorizations[1] ?? "" }).get("authorization")?.includes("assumed-secret-key"), false);
  assert.equal(bodies[1]?.includes("source-secret-key"), false);
  assert.equal(bodies[1]?.includes("assumed-secret-key"), false);
  assert.deepEqual(await store.get("amazon-bedrock"), stored);
});

test("an expired container credential does not call the model", async () => {
  const soon = new Date(Date.now() + 30_000).toISOString();
  const later = new Date(Date.now() + 120_000).toISOString();
  for (const expiration of ["2000-01-01T00:00:00.000Z", "not-a-date", soon]) {
    const outcome = await containerExchange(expiration);
    assert.equal(outcome.stopReason, "error", expiration);
    assert.deepEqual(outcome.urls, ["https://container.test/creds"], expiration);
    assert.match(outcome.errorMessage, /could not be resolved/);
    assert.equal(outcome.errorMessage.includes("container-secret-key"), false, expiration);
    assert.equal(outcome.errorMessage.includes("container-session-token"), false, expiration);
  }
  const fresh = await containerExchange(later);
  assert.equal(fresh.stopReason, "stop");
  assert.match(fresh.urls[1] ?? "", /converse-stream$/);
});

test("an expired assume-role credential does not call the model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-aws-"));
  const credentials = join(dir, "credentials");
  writeFileSync(credentials, [
    "[dev]",
    "role_arn = arn:aws:iam::123456789012:role/amazme",
    "source_profile = source",
    "[source]",
    "aws_access_key_id = source-access-key",
    "aws_secret_access_key = source-secret-key",
    "",
  ].join("\n"));
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response("<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>assumed-access-key</AccessKeyId><SecretAccessKey>assumed-secret-key</SecretAccessKey><SessionToken>assumed-session-token</SessionToken><Expiration>2000-01-01T00:00:00.000Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>");
  };
  const store = new MemoryCredentialStore();
  const stored: Credential = { type: "api_key", env: { AWS_PROFILE: "dev", AWS_SHARED_CREDENTIALS_FILE: credentials, AWS_CONFIG_FILE: join(dir, "no-config"), AWS_REGION: "us-east-1" } };
  await store.set("amazon-bedrock", stored);
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({ store, env: {} });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /could not be resolved/);
  assert.match(urls[0] ?? "", /^https:\/\/sts\.us-east-1\.amazonaws\.com\//);
  assert.equal(urls.length, 1);
  assert.equal(message.errorMessage?.includes("assumed-secret-key"), false);
  assert.equal(message.errorMessage?.includes("source-secret-key"), false);
  assert.equal(message.errorMessage?.includes("assumed-session-token"), false);
  assert.deepEqual(await store.get("amazon-bedrock"), stored);
});

test("vertex refreshes an authorized-user ADC and does not store the refresh token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({
    type: "authorized_user",
    client_id: "test-client",
    client_secret: "test-client-secret",
    refresh_token: "test-refresh",
  }));
  const stored: Credential = {
    type: "api_key",
    env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file },
  };
  const calls: Array<{ url: string; authorization: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "", body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh-token", expires_in: 3600 });
    return vertexSse();
  };
  const store = new MemoryCredentialStore();
  await store.set("google-vertex", stored);
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({ store, env: {} });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.match(calls[0]?.url ?? "", /^https:\/\/oauth2\.googleapis\.com\/token/);
  assert.match(calls[0]?.body ?? "", /grant_type=refresh_token/);
  assert.match(calls[1]?.url ?? "", /\/v1\/projects\/proj\/locations\/us-central1\/publishers\/google\/models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(calls[1]?.authorization, "Bearer fresh-token");
  assert.equal(calls[1]?.body.includes("test-refresh"), false);
  assert.equal(calls[1]?.body.includes("test-client-secret"), false);
  assert.deepEqual(await store.get("google-vertex"), stored);
});

test("vertex exchanges a service-account JWT and does not store the private key", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({
    type: "service_account",
    client_email: "signer@example.iam.gserviceaccount.com",
    private_key: pem,
    token_uri: "https://oauth2.googleapis.com/token",
  }));
  const calls: Array<{ url: string; body: string; authorization: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, body, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "sa-token", expires_in: 3600 });
    return vertexSse();
  };
  const store = new MemoryCredentialStore();
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    store,
    env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  const assertion = new URLSearchParams(calls[0]?.body ?? "").get("assertion");
  assert.ok(assertion);
  const [header, payload, signature] = assertion.split(".");
  assert.ok(header && payload && signature);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: string; scope?: string };
  assert.equal(claims.iss, "signer@example.iam.gserviceaccount.com");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
  assert.equal(calls[1]?.authorization, "Bearer sa-token");
  assert.equal(calls[1]?.body.includes("PRIVATE KEY"), false);
  assert.equal(await store.get("google-vertex"), undefined);
});

test("a vertex API key does not read ADC", async () => {
  const calls: Array<{ url: string; apiKey: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), apiKey: new Headers(init?.headers).get("x-goog-api-key") ?? "" });
    return vertexSse();
  };
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({ env: { GOOGLE_CLOUD_API_KEY: "vertex-key", GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1" } });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.apiKey, "vertex-key");
  assert.match(calls[0]?.url ?? "", /streamGenerateContent/);
});

test("an access token without an expiry does not call the model stream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({ access_token: "maybe-stale" }));
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return vertexSse();
  };
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /not configured/);
  assert.equal(calls, 0);
});

test("an expired vertex token with no refresh does not call the model stream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({ access_token: "stale-token", expiry: "2000-01-01T00:00:00.000Z" }));
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return vertexSse();
  };
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /not configured/);
  assert.equal(calls, 0);
  assert.equal(message.errorMessage?.includes("stale-token"), false);
});

test("a failed vertex refresh does not call the model stream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({
    type: "authorized_user",
    client_id: "test-client",
    client_secret: "test-client-secret",
    refresh_token: "test-refresh",
  }));
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response("no", { status: 400 });
  };
  const store = new MemoryCredentialStore();
  const stored: Credential = {
    type: "api_key",
    env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file },
  };
  await store.set("google-vertex", stored);
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({ store, env: {} });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /could not be resolved/);
  assert.deepEqual(urls, ["https://oauth2.googleapis.com/token"]);
  assert.equal(message.errorMessage?.includes("test-refresh"), false);
  assert.deepEqual(await store.get("google-vertex"), stored);
});

test("a still-valid authorized-user token is sent without another refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({
    type: "authorized_user",
    client_id: "test-client",
    client_secret: "test-client-secret",
    refresh_token: "test-refresh",
    access_token: "still-valid",
    expiry: new Date(Date.now() + 10 * 60_000).toISOString(),
  }));
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer still-valid");
    assert.equal(String(init?.body ?? "").includes("test-refresh"), false);
    assert.equal(String(init?.body ?? "").includes("test-client-secret"), false);
    return vertexSse();
  };
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /streamGenerateContent/);
});

test("a failed refresh does not send an authorized-user token that is inside the expiry skew", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  const body = JSON.stringify({
    type: "authorized_user",
    client_id: "test-client",
    client_secret: "test-client-secret",
    refresh_token: "test-refresh",
    access_token: "about-to-expire",
    expiry: new Date(Date.now() + 30_000).toISOString(),
  });
  writeFileSync(file, body);
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response("no", { status: 400 });
  };
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /could not be resolved/);
  assert.deepEqual(urls, ["https://oauth2.googleapis.com/token"]);
  assert.equal(message.errorMessage?.includes("about-to-expire"), false);
  assert.equal(message.errorMessage?.includes("test-refresh"), false);
  assert.equal(message.errorMessage?.includes("test-client-secret"), false);
  assert.equal(readFileSync(file, "utf8"), body);
});

test("an authorized-user token inside the expiry skew is refreshed before the model request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({
    type: "authorized_user",
    client_id: "test-client",
    client_secret: "test-client-secret",
    refresh_token: "test-refresh",
    access_token: "about-to-expire",
    expiry: new Date(Date.now() + 30_000).toISOString(),
  }));
  const calls: Array<{ url: string; authorization: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "", body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "fresh-token", expires_in: 3600 });
    return vertexSse();
  };
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.match(calls[0]?.url ?? "", /^https:\/\/oauth2\.googleapis\.com\/token/);
  assert.equal(calls[1]?.authorization, "Bearer fresh-token");
  assert.equal(calls[1]?.body.includes("test-refresh"), false);
  assert.equal(calls[1]?.body.includes("about-to-expire"), false);
});

test("a bare access token that is still valid calls the model and not the token endpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amazme-adc-"));
  const file = join(dir, "adc.json");
  writeFileSync(file, JSON.stringify({
    access_token: "bare-token",
    expiry: new Date(Date.now() + 10 * 60_000).toISOString(),
  }));
  const calls: Array<{ url: string; authorization: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? "" });
    return vertexSse();
  };
  const provider = googleVertexProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    env: { GOOGLE_CLOUD_PROJECT: "proj", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: file },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  assert.equal(message.stopReason, "stop");
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.url ?? "", /streamGenerateContent/);
  assert.equal(calls[0]?.authorization, "Bearer bare-token");
});

async function containerExchange(expiration: string): Promise<{ stopReason: string; urls: string[]; errorMessage: string }> {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    if (String(input) === "https://container.test/creds") {
      return Response.json({
        AccessKeyId: "container-access-key",
        SecretAccessKey: "container-secret-key",
        Token: "container-session-token",
        Expiration: expiration,
      });
    }
    return bedrockSse();
  };
  const provider = amazonBedrockProvider({ fetch: fetchImpl });
  const model = provider.getModels()[0];
  assert.ok(model);
  const models = createModels({
    env: {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "https://container.test/creds",
      AWS_SHARED_CREDENTIALS_FILE: join(tmpdir(), "amazme-aws-no-credentials"),
      AWS_CONFIG_FILE: join(tmpdir(), "amazme-aws-no-config"),
      AWS_REGION: "us-east-1",
    },
  });
  models.setProvider(provider);
  const message = await models.completeSimple(model, CONTEXT);
  return { stopReason: message.stopReason, urls, errorMessage: message.errorMessage ?? "" };
}

function bedrockSse(): Response {
  const body = encodeBedrockEvents([
    { type: "contentBlockDelta", body: { contentBlockIndex: 0, delta: { text: "Hi" } } },
    { type: "messageStop", body: { stopReason: "end_turn" } },
  ]);
  return new Response(body, { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

function vertexSse(): Response {
  const event = {
    candidates: [{ content: { parts: [{ text: "Hi" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
