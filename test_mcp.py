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
    print(f"SERVER_URL: {server_url}")

    # No headers required; server reads LI_AT from .env
    transport = StreamableHttpTransport(server_url)

    async with Client(transport=transport) as client:
        # Basic health check
        await client.ping()

        # List available tools
        tools = await client.list_tools()
        print("Tools:", tools)

        # Helper to parse MCP tool result content, unwrapping nested content layers
        def parse_text_content_json(tool_result: any) -> any:
            # Normalize input: prefer structured_content/data when present
            candidate = None
            if isinstance(tool_result, dict) or isinstance(tool_result, str):
                candidate = tool_result
            else:
                # Duck-type fastmcp CallToolResult
                structured = getattr(tool_result, "structured_content", None)
                if structured is not None:
                    candidate = structured
                else:
                    data = getattr(tool_result, "data", None)
                    if data is not None:
                        candidate = data
                    else:
                        content_attr = getattr(tool_result, "content", None)
                        if isinstance(content_attr, list) and content_attr:
                            first = content_attr[0]
                            text_val = getattr(first, "text", None)
                            type_val = getattr(first, "type", None)
                            if text_val is not None and type_val == "text":
                                candidate = {"content": [{"type": "text", "text": text_val}]}

            # Iteratively unwrap: content[{type:text, text: JSON-string}] → JSON → possibly same shape again
            def unwrap(obj: any) -> any:
                current = obj
                # Also support when current is a raw JSON string
                if isinstance(current, str):
                    try:
                        current = json.loads(current)
                    except Exception:
                        return None
                # Unwrap nested content blocks until we reach the payload
                max_layers = 5
                for _ in range(max_layers):
                    if isinstance(current, dict) and isinstance(current.get("content"), list) and current["content"]:
                        first = current["content"][0]
                        if isinstance(first, dict) and first.get("type") == "text":
                            text = first.get("text", "")
                            try:
                                current = json.loads(text)
                                continue
                            except Exception:
                                return None
                    break
                return current

            if candidate is None:
                return None
            return unwrap(candidate)

        # Perform a search using LI_SEARCH_NAME
        search_query = os.environ.get("LI_SEARCH_NAME")
        if not search_query:
            print("LI_SEARCH_NAME not set; skipping search+fetch test")
            return

        search_result = await client.call_tool("search", {"query": search_query})
        print("Search result:")
        print(search_result)
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


