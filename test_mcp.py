import os
import asyncio
from pathlib import Path
import json

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

        # Helper to parse MCP tool result content (single text item with JSON-encoded string)
        def parse_text_content_json(tool_result: any) -> any:
            if isinstance(tool_result, dict):
                candidate = tool_result.get("content")
                if candidate is None and isinstance(tool_result.get("result"), dict):
                    candidate = tool_result["result"].get("content")
                if isinstance(candidate, list) and candidate:
                    first = candidate[0]
                    if isinstance(first, dict) and first.get("type") == "text":
                        text = first.get("text", "")
                        try:
                            return json.loads(text)
                        except Exception:
                            return None
            if isinstance(tool_result, str):
                try:
                    return json.loads(tool_result)
                except Exception:
                    return None
            return None

        # Perform a search using LI_SEARCH_NAME
        search_query = os.environ.get("LI_SEARCH_NAME")
        if not search_query:
            print("LI_SEARCH_NAME not set; skipping search+fetch test")
            return

        search_result = await client.call_tool("search", {"query": search_query})
        search_payload = parse_text_content_json(search_result) or {}
        results = search_payload.get("results") or []
        if not results:
            print("No search results for:", search_query)
            return
        first = results[0] or {}
        first_id = first.get("id")
        if not first_id:
            print("First search result missing 'id'; aborting")
            return
        print("First search result:")
        print(json.dumps(first, ensure_ascii=False, indent=2))

        # Fetch by id and print profile document
        fetch_result = await client.call_tool("fetch", {"id": first_id})
        fetch_doc = parse_text_content_json(fetch_result) or {}
        print("\nFetched profile document:")
        print(json.dumps(fetch_doc, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())


