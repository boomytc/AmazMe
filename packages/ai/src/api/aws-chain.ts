import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { signAwsRequest, type AwsSigningCredentials } from "./aws-sigv4.ts";

export interface AwsEnv {
  [name: string]: string | undefined;
}

/** Resolved signing material. Never written to the credential store. */
export interface AwsChainCredentials extends AwsSigningCredentials {
  region: string;
}

const ASSUME_ROLE_DEPTH = 3;

/**
 * Request-scoped env the stream needs in order to sign.
 * File secrets stay in the credential file. Static environment keys are copied
 * onto the request only when that request signs with them.
 * Callers must not persist this record.
 *
 * `profile` resolves only the named profile (a stored pointer owns the provider).
 * `chain` follows bearer, environment keys, the profile file, web identity, then container credentials.
 * A missing profile does not hide a later source.
 */
export async function awsRequestEnv(env: AwsEnv, mode: "chain" | "profile" = "chain"): Promise<Record<string, string> | undefined> {
  if (mode === "profile") {
    const named = text(env.AWS_PROFILE) ?? "default";
    const need = await profileNeed(env, named, new Set());
    if (!need.ok) return undefined;
    return profileEnv(env, text(env.AWS_PROFILE), need);
  }
  const bearer = text(env.AWS_BEARER_TOKEN_BEDROCK);
  if (bearer) return { AWS_BEARER_TOKEN_BEDROCK: bearer, ...regionEnv(env) };
  const keys = staticKeys(env);
  if (keys) return keyEnv(keys, env);
  const named = text(env.AWS_PROFILE);
  if (named) {
    const need = await profileNeed(env, named, new Set());
    if (need.ok) return profileEnv(env, named, need);
  } else {
    const need = await profileNeed(env, "default", new Set());
    if (need.ok) return profileEnv(env, undefined, need);
  }
  const role = text(env.AWS_ROLE_ARN);
  const tokenFile = text(env.AWS_WEB_IDENTITY_TOKEN_FILE);
  if (role && tokenFile && await readable(tokenFile)) {
    return { AWS_ROLE_ARN: role, AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, ...regionEnv(env) };
  }
  return containerEnv(env);
}

/**
 * Turn the request env into signing credentials.
 * Network calls here are credential exchange only. A failure returns undefined
 * and must not be followed by the model request.
 */
export async function resolveAwsChain(input: {
  env: AwsEnv;
  fetch: typeof fetch;
  signal?: AbortSignal;
  now?: Date;
}): Promise<AwsChainCredentials | undefined> {
  const region = text(input.env.AWS_REGION) || text(input.env.AWS_DEFAULT_REGION) || "us-east-1";
  const named = text(input.env.AWS_PROFILE);
  const filesSelected = named !== undefined
    || text(input.env.AWS_SHARED_CREDENTIALS_FILE) !== undefined
    || text(input.env.AWS_CONFIG_FILE) !== undefined;
  if (filesSelected) {
    const fromProfile = await credentialsForProfile(input, named ?? "default", new Set());
    if (!fromProfile) return undefined;
    return { ...fromProfile, region: fromProfile.region || region };
  }
  const direct = staticKeys(input.env);
  if (direct) return { ...direct, region };
  const web = await webIdentityCredentials(input, text(input.env.AWS_ROLE_ARN), text(input.env.AWS_WEB_IDENTITY_TOKEN_FILE), region);
  if (web) return web;
  const container = await containerCredentials(input, region);
  if (container) return container;
  return undefined;
}

export function bearerFromEnv(env: AwsEnv): string | undefined {
  return text(env.AWS_BEARER_TOKEN_BEDROCK);
}

async function credentialsForProfile(
  input: { env: AwsEnv; fetch: typeof fetch; signal?: AbortSignal; now?: Date },
  profile: string,
  seen: Set<string>,
): Promise<(AwsSigningCredentials & { region?: string }) | undefined> {
  if (seen.has(profile) || seen.size >= ASSUME_ROLE_DEPTH) return undefined;
  seen.add(profile);
  const loaded = await loadProfile(input.env, profile);
  if (!loaded) return undefined;
  const keys = staticKeys(loaded);
  if (keys) return { ...keys, ...(loaded.region ? { region: loaded.region } : {}) };
  const role = text(loaded.role_arn);
  if (!role) return undefined;
  const sourceName = text(loaded.source_profile);
  if (sourceName) {
    const source = await credentialsForProfile(input, sourceName, seen);
    if (!source) return undefined;
    const assumed = await assumeRole(input, source, role, loaded.region || source.region || "us-east-1", text(loaded.role_session_name));
    return assumed ? { ...assumed, ...(loaded.region ? { region: loaded.region } : {}) } : undefined;
  }
  const sourceKind = text(loaded.credential_source);
  if (sourceKind === "Environment") {
    const source = staticKeys(input.env);
    if (!source) return undefined;
    return assumeRole(input, source, role, loaded.region || "us-east-1", text(loaded.role_session_name));
  }
  if (sourceKind === "EcsContainer") {
    const source = await containerCredentials(input, loaded.region || "us-east-1");
    if (!source) return undefined;
    return assumeRole(input, source, role, source.region, text(loaded.role_session_name));
  }
  const tokenFile = text(loaded.web_identity_token_file);
  if (tokenFile) return webIdentityCredentials(input, role, tokenFile, loaded.region || "us-east-1");
  return undefined;
}

interface ProfileNeed {
  ok: boolean;
  keys: boolean;
  container: boolean;
}

async function profileNeed(env: AwsEnv, profile: string, seen: Set<string>): Promise<ProfileNeed> {
  const none = { ok: false, keys: false, container: false };
  if (seen.has(profile) || seen.size >= ASSUME_ROLE_DEPTH) return none;
  seen.add(profile);
  const loaded = await loadProfile(env, profile);
  if (!loaded) return none;
  if (staticKeys(loaded)) return { ok: true, keys: false, container: false };
  if (!text(loaded.role_arn)) return none;
  if (text(loaded.source_profile)) return profileNeed(env, text(loaded.source_profile)!, seen);
  if (text(loaded.credential_source) === "Environment") return { ok: staticKeys(env) !== undefined, keys: true, container: false };
  if (text(loaded.credential_source) === "EcsContainer") {
    const container = text(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) !== undefined || text(env.AWS_CONTAINER_CREDENTIALS_FULL_URI) !== undefined;
    return { ok: container, keys: false, container };
  }
  const tokenFile = text(loaded.web_identity_token_file);
  return { ok: tokenFile !== undefined && await readable(tokenFile), keys: false, container: false };
}

async function assumeRole(
  input: { fetch: typeof fetch; signal?: AbortSignal; now?: Date },
  source: AwsSigningCredentials,
  roleArn: string,
  region: string,
  sessionName: string | undefined,
): Promise<AwsSigningCredentials | undefined> {
  const body = new URLSearchParams({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: sessionName || "amazme",
    DurationSeconds: "3600",
  }).toString();
  const url = new URL(`https://sts.${region}.amazonaws.com/`);
  const signed = signAwsRequest({
    method: "POST",
    url,
    body,
    region,
    service: "sts",
    credentials: source,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    ...(input.now ? { now: input.now } : {}),
  });
  const response = await input.fetch(url, { method: "POST", headers: signed.headers, body: signed.body, signal: input.signal });
  if (!response.ok) return undefined;
  return credentialsFromSts(await response.text(), input.now?.getTime() ?? Date.now());
}

async function webIdentityCredentials(
  input: { fetch: typeof fetch; signal?: AbortSignal },
  roleArn: string | undefined,
  tokenFile: string | undefined,
  region: string,
): Promise<AwsChainCredentials | undefined> {
  if (!roleArn || !tokenFile) return undefined;
  let token = "";
  try {
    token = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    return undefined;
  }
  if (!token) return undefined;
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: "amazme",
    WebIdentityToken: token,
    DurationSeconds: "3600",
  }).toString();
  const response = await input.fetch(`https://sts.${region}.amazonaws.com/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: input.signal,
  });
  if (!response.ok) return undefined;
  const credentials = credentialsFromSts(await response.text(), Date.now());
  return credentials ? { ...credentials, region } : undefined;
}

async function containerCredentials(
  input: { env: AwsEnv; fetch: typeof fetch; signal?: AbortSignal },
  region: string,
): Promise<AwsChainCredentials | undefined> {
  const relative = text(input.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI);
  const full = text(input.env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
  const url = full || (relative ? `http://169.254.170.2${relative.startsWith("/") ? relative : `/${relative}`}` : undefined);
  if (!url) return undefined;
  const authorization = text(input.env.AWS_CONTAINER_AUTHORIZATION_TOKEN) || await readOptional(text(input.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE));
  const response = await input.fetch(url, {
    method: "GET",
    headers: authorization ? { authorization } : {},
    signal: input.signal,
  });
  if (!response.ok) return undefined;
  let parsed: unknown;
  try {
    parsed = await response.json() as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const accessKeyId = text(record.AccessKeyId);
  const secretAccessKey = text(record.SecretAccessKey);
  const sessionToken = text(record.Token);
  if (!accessKeyId || !secretAccessKey || !usableUntil(text(record.Expiration), Date.now())) return undefined;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}), region };
}

function credentialsFromSts(xml: string, now: number): AwsSigningCredentials | undefined {
  const accessKeyId = xmlTag(xml, "AccessKeyId");
  const secretAccessKey = xmlTag(xml, "SecretAccessKey");
  const sessionToken = xmlTag(xml, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken || !usableUntil(xmlTag(xml, "Expiration"), now)) return undefined;
  return { accessKeyId, secretAccessKey, sessionToken };
}

/** A missing expiry is still usable. A past or unreadable expiry is not. */
function usableUntil(expiration: string | undefined, now: number): boolean {
  if (expiration === undefined) return true;
  const expiry = Date.parse(expiration);
  return Number.isFinite(expiry) && expiry - now > 60_000;
}

function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  const value = match?.[1]?.trim();
  return value || undefined;
}

interface ProfileFields {
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  region?: string;
  role_arn?: string;
  source_profile?: string;
  credential_source?: string;
  web_identity_token_file?: string;
  role_session_name?: string;
}

async function loadProfile(env: AwsEnv, profile: string): Promise<ProfileFields | undefined> {
  const credentials = parseIni(await readOptional(credentialsPath(env)), false);
  const config = parseIni(await readOptional(configPath(env)), true);
  const merged = { ...(config.get(profile) ?? {}), ...(credentials.get(profile) ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function parseIni(text: string | undefined, configStyle: boolean): Map<string, ProfileFields> {
  const profiles = new Map<string, ProfileFields>();
  if (!text) return profiles;
  let current: ProfileFields | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section?.[1]) {
      let name = section[1].trim();
      if (configStyle && name.startsWith("profile ")) name = name.slice("profile ".length).trim();
      current = profiles.get(name) ?? {};
      profiles.set(name, current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (isProfileKey(key)) current[key] = value;
  }
  return profiles;
}

function isProfileKey(key: string): key is keyof ProfileFields {
  return key === "aws_access_key_id" || key === "aws_secret_access_key" || key === "aws_session_token"
    || key === "region" || key === "role_arn" || key === "source_profile" || key === "credential_source"
    || key === "web_identity_token_file" || key === "role_session_name";
}

function staticKeys(source: { AWS_ACCESS_KEY_ID?: string; AWS_SECRET_ACCESS_KEY?: string; AWS_SESSION_TOKEN?: string; aws_access_key_id?: string; aws_secret_access_key?: string; aws_session_token?: string }): AwsSigningCredentials | undefined {
  const accessKeyId = text(source.AWS_ACCESS_KEY_ID) || text(source.aws_access_key_id);
  const secretAccessKey = text(source.AWS_SECRET_ACCESS_KEY) || text(source.aws_secret_access_key);
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = text(source.AWS_SESSION_TOKEN) || text(source.aws_session_token);
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function keyEnv(keys: AwsSigningCredentials, env: AwsEnv): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID: keys.accessKeyId,
    AWS_SECRET_ACCESS_KEY: keys.secretAccessKey,
    ...(keys.sessionToken ? { AWS_SESSION_TOKEN: keys.sessionToken } : {}),
    ...regionEnv(env),
  };
}

function profileEnv(env: AwsEnv, profile: string | undefined, need: ProfileNeed): Record<string, string> {
  const keys = need.keys ? staticKeys(env) : undefined;
  const relative = need.container ? text(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) : undefined;
  const full = need.container ? text(env.AWS_CONTAINER_CREDENTIALS_FULL_URI) : undefined;
  const token = need.container ? text(env.AWS_CONTAINER_AUTHORIZATION_TOKEN) : undefined;
  const tokenFile = need.container ? text(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) : undefined;
  return {
    ...(profile ? { AWS_PROFILE: profile } : {}),
    AWS_SHARED_CREDENTIALS_FILE: credentialsPath(env),
    AWS_CONFIG_FILE: configPath(env),
    ...(keys ? { AWS_ACCESS_KEY_ID: keys.accessKeyId, AWS_SECRET_ACCESS_KEY: keys.secretAccessKey, ...(keys.sessionToken ? { AWS_SESSION_TOKEN: keys.sessionToken } : {}) } : {}),
    ...(relative ? { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: relative } : {}),
    ...(full ? { AWS_CONTAINER_CREDENTIALS_FULL_URI: full } : {}),
    ...(token ? { AWS_CONTAINER_AUTHORIZATION_TOKEN: token } : {}),
    ...(tokenFile ? { AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: tokenFile } : {}),
    ...regionEnv(env),
  };
}

function containerEnv(env: AwsEnv): Record<string, string> | undefined {
  const relative = text(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI);
  const full = text(env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
  if (!relative && !full) return undefined;
  const token = text(env.AWS_CONTAINER_AUTHORIZATION_TOKEN);
  const tokenFile = text(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE);
  return {
    ...(relative ? { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: relative } : {}),
    ...(full ? { AWS_CONTAINER_CREDENTIALS_FULL_URI: full } : {}),
    ...(token ? { AWS_CONTAINER_AUTHORIZATION_TOKEN: token } : {}),
    ...(tokenFile ? { AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: tokenFile } : {}),
    ...regionEnv(env),
  };
}

function regionEnv(env: AwsEnv): Record<string, string> {
  const region = text(env.AWS_REGION);
  const fallback = text(env.AWS_DEFAULT_REGION);
  return {
    ...(region ? { AWS_REGION: region } : {}),
    ...(fallback ? { AWS_DEFAULT_REGION: fallback } : {}),
  };
}

function credentialsPath(env: AwsEnv): string {
  return text(env.AWS_SHARED_CREDENTIALS_FILE) || join(homedir(), ".aws", "credentials");
}

function configPath(env: AwsEnv): string {
  return text(env.AWS_CONFIG_FILE) || join(homedir(), ".aws", "config");
}

async function readOptional(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readable(path: string): Promise<boolean> {
  return (await readOptional(path)) !== undefined;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) return value.slice(1, -1);
  return value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
