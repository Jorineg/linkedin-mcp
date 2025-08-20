import os
import asyncio
from pathlib import Path

from dotenv import load_dotenv
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport


async def main() -> None:
    # Load .env if present (mirror TypeScript dotenv behavior)
    load_dotenv()

    # Config
    server_url = os.environ.get("MCP_URL", "http://localhost:3000/mcp")
    token_path = os.environ.get("TOKEN_PATH", "token.txt")
    print(f"SERVER_URL: {server_url}")

    # Read token (base64-encoded JSON cookies)
    token_file = Path(token_path)
    if not token_file.exists():
        raise FileNotFoundError(
            f"Token file not found at {token_file!s}. Ensure it contains base64(JSON) cookies."
        )
    linkedin_session_b64 = token_file.read_text(encoding="utf-8").strip()
    if not linkedin_session_b64:
        raise ValueError(
            "Token file is empty. It should contain base64-encoded JSON cookies."
        )

    # Create client with custom headers
    transport = StreamableHttpTransport(
        server_url,
        headers={
            # Custom header carrying base64(JSON) session cookies
            "linkedin_session": linkedin_session_b64,
        },
    )

    async with Client(transport=transport) as client:
        # Basic health check
        await client.ping()

        # List available tools
        tools = await client.list_tools()
        print("Tools:", tools)

        # Optionally call get_profile if LI_PUBLIC_ID is set
        public_identifier = os.environ.get("LI_PUBLIC_ID")
        if not public_identifier:
            print("LI_PUBLIC_ID not set; skipping get_profile test")
            return

        result = await client.call_tool(
            "get_profile",
            {"publicIdentifier": public_identifier},
        )
        # Print raw result; representation depends on server/tool implementation
        print("Profile:")
        print(result)


if __name__ == "__main__":
    asyncio.run(main())


