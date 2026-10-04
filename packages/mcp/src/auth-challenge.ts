/** Parsed Bearer authentication parameters shared by HTTP and OAuth. */
export interface BearerChallenge {
  resourceMetadataUrl?: URL;
  scope?: string;
  error?: string;
  errorDescription?: string;
}

/** Two authorization attempts can share work only when they handle the same challenge. */
export function authorizationChallengeKey(status: number, challenge: BearerChallenge): string {
  const scope = [...new Set((challenge.scope ?? "").split(/\s+/).filter(Boolean))].sort();
  return JSON.stringify([status, challenge.resourceMetadataUrl?.href, challenge.error, scope]);
}

/** Split authentication parameters without splitting quoted commas or escaped quotes. */
function authenticationParts(header: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { parts.push(header.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(header.slice(start).trim());
  return parts;
}

export function parseWwwAuthenticate(header: string | null): BearerChallenge {
  if (!header) return {};
  let scheme: string | undefined;
  const fields = new Map<string, string>();
  for (const part of authenticationParts(header)) {
    let parameter = part;
    const challenge = part.match(/^([\w-]+)\s+(.*)$/);
    if (challenge && !challenge[2]?.startsWith("=")) {
      if (scheme === "bearer") break;
      scheme = challenge[1]?.toLowerCase();
      parameter = challenge[2] ?? "";
    }
    if (scheme !== "bearer") continue;
    const match = parameter.match(/^([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s,]+))\s*$/);
    if (match) fields.set(match[1]!.toLowerCase(), (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1"));
  }
  const resourceMetadata = fields.get("resource_metadata");
  let resourceMetadataUrl: URL | undefined;
  if (resourceMetadata) {
    try { resourceMetadataUrl = new URL(resourceMetadata); } catch { resourceMetadataUrl = undefined; }
  }
  return {
    resourceMetadataUrl,
    scope: fields.get("scope") || undefined,
    error: fields.get("error") || undefined,
    errorDescription: fields.get("error_description") || undefined,
  };
}
