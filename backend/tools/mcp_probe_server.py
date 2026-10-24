"""Official SDK stdio probe. Only run in an explicitly named disposable workspace."""
import argparse
import asyncio
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel


class EchoResult(BaseModel):
    text: str
    total: int
    cwd: str


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, required=True)
    args = parser.parse_args()
    workspace = args.workspace.resolve(strict=True)
    if workspace != Path.cwd() or workspace.name != "workspace":
        raise SystemExit("Probe must run in its explicitly owned workspace")
    with (workspace / "mcp-starts.txt").open("a") as log:
        log.write("x")
    server = FastMCP("AmazMe native interoperability probe")

    @server.tool()
    def native_echo(text: str, numbers: list[int]) -> EchoResult:
        """Append text to this probe's marker once and return a structured result."""
        with (workspace / "mcp-effect.txt").open("a") as log:
            log.write(text)
        return EchoResult(text=text, total=sum(numbers), cwd=str(workspace))

    @server.tool()
    async def native_wait(seconds: float) -> str:
        """Wait in this disposable probe to exercise service cancellation."""
        await asyncio.sleep(min(60, max(0, seconds)))
        return "wait completed"

    server.run(transport="stdio")


if __name__ == "__main__":
    main()
