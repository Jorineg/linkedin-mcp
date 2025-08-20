import base64
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import requests

# FastMCP 2.0 API
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers



# Instantiate FastMCP (tools defined below)
mcp = FastMCP("LinkedIn MCP: Profile Only")


def _try_parse_json(s: str) -> Optional[Any]:
    try:
        return json.loads(s)
    except Exception:
        return None


def _b64_to_str(b64: str) -> Optional[str]:
    try:
        # add base64 padding if missing
        normalized = b64.replace("-", "+").replace("_", "/")
        pad = "=" * (-len(normalized) % 4)
        decoded = base64.b64decode(normalized + pad)
        return decoded.decode("utf-8", errors="ignore")
    except Exception:
        return None


def _serialize_cookie_header(cookies: List[Dict[str, Any]]) -> str:
    parts: List[str] = []
    for c in cookies:
        name = str(c.get("name", "")).strip()
        if not name:
            continue
        value = str(c.get("value", "")).strip()
        parts.append(f"{name}={value}")
    return "; ".join(parts)


def _normalize_cookies(raw: Any) -> List[Dict[str, Any]]:
    cookies = raw if isinstance(raw, list) else []
    result: List[Dict[str, Any]] = []
    for c in cookies:
        if not isinstance(c, dict):
            continue
        name = str(c.get("name", ""))
        if not name:
            continue
        value = c.get("value", "")
        if isinstance(value, str) and value.startswith('"') and value.endswith('"') and name.upper() == 'JSESSIONID':
            value = value[1:-1]
        result.append({**c, "name": name, "value": value})
    return result


def _extract_lang_headers(cookies: List[Dict[str, Any]]) -> Tuple[str, str]:
    x_li_lang = "en_US"
    accept_language = "en-US,en;q=0.9"
    for c in cookies:
        if c.get("name") == "lang":
            v = str(c.get("value", ""))
            m = re.search(r"lang=([a-zA-Z-]+)", v)
            if m:
                x_li_lang = m.group(1).replace("-", "_")
                break
    return x_li_lang, accept_language


def _linkedin_headers(cookies: List[Dict[str, Any]], referer: str) -> Dict[str, str]:
    cookie_header = _serialize_cookie_header(cookies)
    js = next((c for c in cookies if str(c.get("name", "")).upper() == "JSESSIONID"), None)
    js_value = str((js or {}).get("value", ""))
    x_li_lang, accept_language = _extract_lang_headers(cookies)
    headers: Dict[str, str] = {
        "user-agent": os.getenv(
            "LI_UA",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        ),
        "accept": "application/vnd.linkedin.normalized+json+2.1",
        "x-restli-protocol-version": "2.0.0",
        "referer": referer,
        "cookie": cookie_header,
        "accept-language": accept_language,
        "x-li-lang": x_li_lang,
        "x-li-track": '{"clientVersion":"1.11.*","osName":"web","osVersion":"unknown","deviceFormFactor":"DESKTOP","mpName":"voyager-web"}',
    }
    if js_value:
        headers["csrf-token"] = js_value if js_value.startswith("ajax:") else f"ajax:{js_value}"
    return headers


def _manual_get(path: str, referer: str, cookies: List[Dict[str, Any]]) -> Any:
    headers = _linkedin_headers(cookies, referer)
    resp = requests.get(
        f"https://www.linkedin.com{path}", headers=headers, allow_redirects=False, timeout=20
    )
    if resp.status_code == 302:
        raise ValueError("Invalid LinkedIn session (302 redirect) - login data invalid or expired")
    if resp.status_code != 200:
        # include small preview for debugging
        text = resp.text[:200]
        raise RuntimeError(f"LinkedIn request failed ({resp.status_code}): {text}")
    try:
        return resp.json()
    except Exception:
        raise RuntimeError(f"Non-JSON response from LinkedIn ({resp.status_code})")


def _manual_get_profile_raw(cookies: List[Dict[str, Any]], public_identifier: str) -> Any:
    pid = re.sub(r"^/*in/*", "", str(public_identifier))
    referer = f"https://www.linkedin.com/in/{pid}/"
    path = f"/voyager/api/identity/profiles/{requests.utils.quote(pid, safe='')}/profileView"
    return _manual_get(path, referer, cookies)


def _parse_voyager_profile(raw: Any) -> Dict[str, Any]:
    included = raw.get("included") if isinstance(raw, dict) else []
    included = included if isinstance(included, list) else []

    by_type: Dict[str, List[Any]] = {}
    for item in included:
        t = str(item.get("$type", "unknown")) if isinstance(item, dict) else "unknown"
        by_type.setdefault(t, []).append(item)

    def is_type(s: str, needle: str) -> bool:
        return needle.lower() in s.lower()

    def find_by_entity_urn(urn: Optional[str]) -> Optional[Dict[str, Any]]:
        if not urn:
            return None
        for i in included:
            if isinstance(i, dict) and i.get("entityUrn") == urn:
                return i
        return None

    profile_urn = None
    if isinstance(raw, dict):
        data = raw.get("data") or {}
        if isinstance(data, dict):
            profile_urn = data.get("*profile")
    profile = find_by_entity_urn(profile_urn)
    if not profile:
        profiles = [i for t, arr in by_type.items() for i in arr if is_type(t, "identity.profile.profile")]
        profile = profiles[0] if profiles else None

    mini_urn = (profile or {}).get("*miniProfile") if isinstance(profile, dict) else None
    mini = find_by_entity_urn(mini_urn)
    if not mini:
        minis = [i for t, arr in by_type.items() for i in arr if is_type(t, "identity.shared.miniprofile")]
        mini = minis[0] if minis else None

    any_with_name = None
    if not profile and not mini:
        for i in included:
            if isinstance(i, dict) and isinstance(i.get("firstName"), str) and isinstance(i.get("lastName"), str):
                any_with_name = i
                break
    any_with_headline = next((i for i in included if isinstance(i, dict) and isinstance(i.get("headline"), str)), None)
    any_with_occupation = next((i for i in included if isinstance(i, dict) and isinstance(i.get("occupation"), str)), None)
    any_with_location = next(
        (i for i in included if isinstance(i, dict) and (isinstance(i.get("geoLocationName"), str) or isinstance(i.get("locationName"), str))),
        None,
    )
    any_with_industry = next((i for i in included if isinstance(i, dict) and isinstance(i.get("industryName"), str)), None)

    first = (profile or {}).get("firstName") if isinstance(profile, dict) else None
    if not first:
        first = (mini or {}).get("firstName") if isinstance(mini, dict) else None
    if not first and isinstance(any_with_name, dict):
        first = any_with_name.get("firstName")
    last = (profile or {}).get("lastName") if isinstance(profile, dict) else None
    if not last:
        last = (mini or {}).get("lastName") if isinstance(mini, dict) else None
    if not last and isinstance(any_with_name, dict):
        last = any_with_name.get("lastName")
    full_name = (f"{first or ''} {last or ''}").strip()

    headline = (profile or {}).get("headline") if isinstance(profile, dict) else None
    if headline is None and isinstance(any_with_headline, dict):
        headline = any_with_headline.get("headline")
    occupation = (mini or {}).get("occupation") if isinstance(mini, dict) else None
    if occupation is None and isinstance(any_with_occupation, dict):
        occupation = any_with_occupation.get("occupation")
    location = None
    if isinstance(profile, dict):
        location = profile.get("geoLocationName") or profile.get("locationName")
    if location is None and isinstance(any_with_location, dict):
        location = any_with_location.get("geoLocationName") or any_with_location.get("locationName")
    industry = None
    if isinstance(profile, dict):
        industry = profile.get("industryName")
    if industry is None and isinstance(any_with_industry, dict):
        industry = any_with_industry.get("industryName")

    positions = [i for t, arr in by_type.items() for i in arr if is_type(t, "position") or is_type(t, "positiongroup")]
    educations = [i for t, arr in by_type.items() for i in arr if is_type(t, "education")]
    skills_arr = [i for t, arr in by_type.items() for i in arr if is_type(t, "skill")]

    def normalize_date(obj: Optional[Dict[str, Any]]) -> Optional[str]:
        if not isinstance(obj, dict):
            return None
        y = obj.get("year")
        m = obj.get("month")
        d = obj.get("day")
        parts = [str(p) for p in [y, m, d] if p]
        return "-".join(parts) if parts else None

    experience = []
    for p in positions:
        if not isinstance(p, dict):
            continue
        title = p.get("title") or p.get("name") or p.get("positionName") or p.get("localizedTitle")
        company = None
        if isinstance(p.get("company"), dict):
            company = p["company"].get("name")
        company = company or p.get("companyName") or p.get("entityLocalizedName")
        description = p.get("description")
        time_range = p.get("timePeriod") or p.get("dateRange") or {}
        start = normalize_date(time_range.get("startDate") or time_range.get("start") or {})
        end = normalize_date(time_range.get("endDate") or time_range.get("end") or {})
        experience.append({
            "title": title or None,
            "company": company or None,
            "description": description or None,
            "start": start,
            "end": end,
        })

    education = []
    for e in educations:
        if not isinstance(e, dict):
            continue
        school = None
        if isinstance(e.get("school"), dict):
            school = e["school"].get("name")
        school = school or e.get("schoolName") or e.get("entityLocalizedName")
        degree = e.get("degreeName") or e.get("degree") or e.get("fieldOfStudy")
        time_range = e.get("timePeriod") or e.get("dateRange") or {}
        start = normalize_date(time_range.get("startDate") or time_range.get("start") or {})
        end = normalize_date(time_range.get("endDate") or time_range.get("end") or {})
        education.append({
            "school": school or None,
            "degree": degree or None,
            "start": start,
            "end": end,
        })

    skills = []
    for s in skills_arr:
        if not isinstance(s, dict):
            continue
        n = s.get("name")
        if not n and isinstance(s.get("skill"), dict):
            n = s["skill"].get("name")
        n = n or s.get("entityLocalizedName")
        if n:
            skills.append(str(n))

    return {
        "fullName": full_name,
        "headline": headline or None,
        "occupation": occupation or None,
        "location": location or None,
        "industry": industry or None,
        "experience": experience,
        "education": education,
        "skills": skills,
    }


def _get_session_from_header(header_value: Optional[str]) -> List[Dict[str, Any]]:
    if not header_value:
        raise ValueError("Missing 'linkedin_session' header")
    # header should be base64(JSON)
    decoded = _b64_to_str(header_value.strip())
    parsed = _try_parse_json(decoded or "") if decoded else None
    if not parsed:
        # try as raw JSON
        parsed = _try_parse_json(header_value)
    if not parsed:
        raise ValueError("linkedin_session must be base64(JSON) or JSON")
    if isinstance(parsed, dict) and "cookies" in parsed:
        cookies_raw = parsed.get("cookies")
    else:
        cookies_raw = parsed
    cookies = _normalize_cookies(cookies_raw)
    if not cookies:
        raise ValueError("No cookies provided in linkedin_session")
    return cookies


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

    cookies = _get_session_from_header(str(session_header))

    # brief throttle removed; FastMCP will manage concurrency; LinkedIn rate-limit still possible client-side
    raw = _manual_get_profile_raw(cookies, publicIdentifier)
    parsed = _parse_voyager_profile(raw)
    return parsed


try:
    # Use FastMCP's built-in ASGI app (per ASGI integration guide)
    # Endpoint defaults to /mcp/; adjust path if needed
    # Enable stateless mode for serverless platforms (e.g., Vercel) where lifespan events
    # may not run, avoiding the need for a background task group
    app = mcp.http_app(stateless_http=True)
except Exception:  # pragma: no cover
    app = None  # type: ignore


