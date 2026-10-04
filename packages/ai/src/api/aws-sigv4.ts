import { createHash, createHmac, type BinaryLike } from "node:crypto";

export interface AwsSigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignedAwsRequest {
  headers: Record<string, string>;
  body: string;
}

/**
 * Sign one HTTPS request with Signature Version 4.
 * The host is part of the signature. Callers send the returned headers with `body` unchanged.
 */
export function signAwsRequest(input: {
  method: string;
  url: URL;
  body: string;
  region: string;
  service: string;
  credentials: AwsSigningCredentials;
  headers?: Record<string, string>;
  now?: Date;
  /** Bedrock requires this header. The published IAM example omits it. */
  payloadHashHeader?: boolean;
}): SignedAwsRequest {
  const amzDate = amzTimestamp(input.now ?? new Date());
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(input.body);
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (name.toLowerCase() === "authorization" || name.toLowerCase() === "host") continue;
    headers.set(name.toLowerCase(), collapse(value));
  }
  headers.set("host", input.url.host);
  headers.set("x-amz-date", amzDate);
  if (input.payloadHashHeader !== false) headers.set("x-amz-content-sha256", payloadHash);
  if (input.credentials.sessionToken) headers.set("x-amz-security-token", input.credentials.sessionToken);

  const names = [...headers.keys()].sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers.get(name)}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url.pathname),
    canonicalQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = hmacHex(signingKey(input.credentials.secretAccessKey, dateStamp, input.region, input.service), stringToSign);
  const signed = Object.fromEntries(headers);
  signed.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: signed, body: input.body };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const dateKey = hmacRaw(`AWS4${secret}`, date);
  const regionKey = hmacRaw(dateKey, region);
  const serviceKey = hmacRaw(regionKey, service);
  return hmacRaw(serviceKey, "aws4_request");
}

function hmacRaw(key: BinaryLike, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function amzTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function canonicalUri(pathname: string): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = `/${segments.join("/")}${segments.length > 0 && path.endsWith("/") ? "/" : ""}`;
  // Non-S3 SigV4 signs the escaped request path after another URI encoding pass.
  return encodeRfc3986(normalized).replace(/%2F/g, "/");
}

function canonicalQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of params.entries()) pairs.push([encodeRfc3986(name), encodeRfc3986(value)]);
  pairs.sort((left, right) => left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : left[0] < right[0] ? -1 : 1);
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function collapse(value: string): string {
  return value.trim().replace(/[ \t]+/g, " ");
}
