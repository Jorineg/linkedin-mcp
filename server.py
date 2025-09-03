from typing import Any, Dict, List, Optional
import json
import os
from urllib.parse import urlparse, unquote
import requests
from dotenv import load_dotenv

# FastMCP 2.0 API
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
from linkedin import fetch_and_parse_profile



# Instantiate FastMCP (tools defined below)
load_dotenv()
mcp = FastMCP("LinkedIn MCP: Profile Only")


@mcp.tool
def get_profile(publicIdentifier: str) -> Dict[str, Any]:
    """
    Fetch a LinkedIn profile by publicIdentifier and return summary, experience, education, and skills.
    Public identifier is the part of the profile URL after /in/
    """
    headers = {}
    try:
        headers = get_http_headers() or {}
    except Exception:
        headers = {}

    session_header = None
    # normalize header names to lowercase keys
    for k, v in list(headers.items()):
        if isinstance(k, str) and k.lower() == "linkedin_session":
            session_header = v
            break

    if not session_header:
        raise ValueError("Missing 'linkedin_session' header")

    # brief throttle removed; FastMCP will manage concurrency; LinkedIn rate-limit still possible client-side
    return fetch_and_parse_profile(publicIdentifier, str(session_header))


def _extract_linkedin_public_identifier(url: str) -> Optional[str]:
    """
    Extract LinkedIn public identifier from a profile URL.
    Accepts only profile URLs under /in/ and ignores companies, jobs, etc.
    Returns None when the URL is not a LinkedIn profile URL.
    """
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()
        if not hostname.endswith("linkedin.com"):
            return None

        # Normalize path
        path = parsed.path or ""
        # Ensure leading slash and collapse multiple slashes
        if not path.startswith("/"):
            path = "/" + path
        segments = [seg for seg in path.split("/") if seg]
        if not segments:
            return None

        # Accept only /in/{publicIdentifier}[/*]
        if segments[0] != "in":
            return None

        if len(segments) < 2:
            return None

        public_identifier = unquote(segments[1])

        # Strip common tracking suffixes from identifier if present
        public_identifier = public_identifier.strip()
        if not public_identifier:
            return None

        return public_identifier
    except Exception:
        return None


def _as_text_content(payload: Any) -> Dict[str, Any]:
    """
    Wrap a payload object in an MCP-compliant content array with a single text item
    containing a JSON-encoded string, matching deep research tool expectations.
    """
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(payload, ensure_ascii=False),
            }
        ]
    }


@mcp.tool
def search(query: str) -> Dict[str, Any]:
    """
    Search for relevant LinkedIn profiles for a free-text query.

    Arguments:
    - query: single query string (e.g., name, company, title). The search is restricted to LinkedIn profile URLs.

    Returns:
    - content: a single item array with { type: "text", text: JSON-string } where text encodes
      { "results": [{ "id", "title", "url", ... }] }. Additional fields (e.g., snippet, rank) may be present.
    """
    # Reuse LinkedIn-restricted search and map to required schema
    rows = search_linkedin_profiles(query=query)
    results: List[Dict[str, Any]] = []
    for item in rows:
        results.append(
            {
                "id": item.get("linkedinId") or "",
                "title": item.get("title", ""),
                "url": item.get("link", ""),
                "snippet": item.get("snippet", ""),
                "rank": item.get("rank"),
            }
        )
    return _as_text_content({"results": results})


@mcp.tool
def fetch(id: str) -> Dict[str, Any]:
    """
    Fetch a LinkedIn profile by its publicIdentifier and return a document.

    Arguments:
    - id: unique identifier for the profile (LinkedIn publicIdentifier, i.e., the part after /in/)

    Returns:
    - content: a single item array with { type: "text", text: JSON-string } where text encodes
      { "id", "title", "text", "url", "metadata" }. The "text" field is a JSON string
      of the raw profile data.
    """
    # Acquire session header (same logic as get_profile)
    headers = {}
    try:
        headers = get_http_headers() or {}
    except Exception:
        headers = {}

    session_header = None
    for k, v in list(headers.items()):
        if isinstance(k, str) and k.lower() == "linkedin_session":
            session_header = v
            break
    if not session_header:
        raise ValueError("Missing 'linkedin_session' header")

    profile = fetch_and_parse_profile(id, str(session_header))
    full_name = str(profile.get("fullName") or id).strip()
    headline = profile.get("headline") or ""
    location = profile.get("location") or ""
    industry = profile.get("industry") or ""

    url = f"https://www.linkedin.com/in/{id}/"

    doc: Dict[str, Any] = {
        "id": id,
        "title": full_name or id,
        # Place the raw structured profile as a JSON string for the document text
        "text": json.dumps(profile, ensure_ascii=False),
        "url": url,
        "metadata": {
            "source": "linkedin_profile",
            "headline": headline,
            "location": location,
            "industry": industry,
        },
    }
    return _as_text_content(doc)

@mcp.tool
def search_linkedin_profiles(query: str, country: str = "us", results: int = 10, page: int = 0) -> List[Dict[str, Any]]:
    """
    LinkedIn-only search tool. Uses Google via Scrapingdog but ALWAYS restricts to LinkedIn profile URLs.

    Important usage rules:
    - This tool ONLY searches the LinkedIn website and ONLY for personal profile pages (paths under /in/).
    - Do NOT use this to search anything else (no companies, jobs, posts, or non-LinkedIn sites).
    - Returns items with: title, snippet, link, rank, and linkedinId (derived from the URL) suitable for get_profile.

    Parameters:
    - query: free-text person query (e.g., name, company, title). The tool will add 'site:linkedin.com/in'.
    - country: 2-letter country code for Google localization (default "us").
    - results: number of results to fetch (1-100; default 10).
    - page: page index starting at 0 (default 0).
    """
    api_key = os.environ.get("SCRAPINGDOG_API_KEY") or os.environ.get("SCRAPING_DOG_API_KEY")
    if not api_key:
        raise ValueError("Missing SCRAPINGDOG_API_KEY in environment (.env)")

    # Always restrict to LinkedIn profile URLs
    restricted_query = f"site:linkedin.com/in {query}".strip()

    params = {
        "api_key": api_key,
        "query": restricted_query,
        "results": str(max(1, min(int(results), 100))),
        "country": country or "us",
        "page": str(max(0, int(page))),
        # Keep defaults for other params; no need for advanced features here
    }

    resp = requests.get("https://api.scrapingdog.com/google/", params=params, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"Scrapingdog error: HTTP {resp.status_code} - {resp.text[:300]}")

    payload = resp.json()
    organic = payload.get("organic_data") or []

    results_out: List[Dict[str, Any]] = []
    for item in organic:
        link = item.get("link") or item.get("displayed_link") or ""
        linkedin_id = _extract_linkedin_public_identifier(link)
        if not linkedin_id:
            # Skip non-profile or malformed entries to ensure profiles-only guarantee
            continue

        results_out.append(
            {
                "title": item.get("title", ""),
                "snippet": item.get("snippet", ""),
                "link": link,
                "rank": item.get("rank"),
                "linkedinId": linkedin_id,
            }
        )

    return results_out


try:
    # Use FastMCP's built-in ASGI app (per ASGI integration guide)
    # Endpoint defaults to /mcp/; adjust path if needed
    # Enable stateless mode for serverless platforms (e.g., Vercel) where lifespan events
    # may not run, avoiding the need for a background task group
    app = mcp.http_app(stateless_http=True)
except Exception:  # pragma: no cover
    app = None  # type: ignore


