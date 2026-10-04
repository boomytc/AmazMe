export class McpHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, message: string, body = "") {
    super(message);
    this.name = "McpHttpError";
    this.status = status;
    this.body = body;
  }
}

export class McpAuthRequiredError extends McpHttpError {
  readonly wwwAuthenticate: string | null;

  constructor(response: Response, body = "") {
    super(response.status, "MCP server requires authentication", body);
    this.name = "McpAuthRequiredError";
    this.wwwAuthenticate = response.headers.get("www-authenticate");
  }
}

export class McpSessionExpiredError extends McpHttpError {
  constructor(body = "") {
    super(404, "MCP session expired", body);
    this.name = "McpSessionExpiredError";
  }
}
