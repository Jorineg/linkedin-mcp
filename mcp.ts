import { createServer, IncomingMessage, ServerResponse } from 'http';
import https from 'https';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

type BearerAuth = { username?: string; password?: string; cookies?: any };

type McpRequest =
    | { type: 'list_tools' }
    | { type: 'call_tool'; name: 'search_accounts'; params: { query: string; limit?: number } }
    | { type: 'call_tool'; name: 'get_profile'; params: { publicIdentifier: string } }
    | { type: 'call_tool'; name: 'auth_probe'; params?: {} };

type SearchAccountResult = {
    fullName: string;
    headline: string | null;
    location: string | null;
    publicIdentifier: string;
};

type ExperienceItem = {
    title: string | null;
    company: string | null;
    start?: string;
    end?: string;
};

type EducationItem = {
    school: string | null;
    degree?: string | null;
    start?: string;
    end?: string;
};

type ProfileResult = {
    fullName: string;
    birthDate?: string | null;
    summary?: string | null;
    experience: ExperienceItem[];
    education: EducationItem[];
    skills: string[];
};

// Toggle whether to advertise the search tool in list_tools (implementation remains)
const ADVERTISE_SEARCH = false;

const json = (res: ServerResponse, status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
};

const parseBody = async (req: IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    // Try JSON first
    try { return JSON.parse(raw); } catch { /* fall through */ }
    // Fallback: parse x-www-form-urlencoded
    const params = new URLSearchParams(raw);
    const obj: Record<string, any> = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    return obj;
};

// In-memory OAuth storage (ephemeral)
const issuedAuthCodes = new Map<string, {
    code_challenge?: string;
    code_challenge_method?: 'S256' | 'plain';
    createdAt: number;
    // Persist the credentials captured during authorize step
    authInfo: BearerAuth;
}>();
const issuedAccessTokens = new Map<string, {
    authInfo: BearerAuth;
    createdAt: number;
    expiresAt: number; // epoch ms
}>();

function baseUrlFrom(req: IncomingMessage): string {
    const proto = (req.headers['x-forwarded-proto'] as string) || (req.socket as any)?.encrypted ? 'https' : 'http';
    const host = String(req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost');
    return `${proto}://${host}`;
}

function setWwwAuthenticate(res: ServerResponse, baseUrl: string) {
    const wwwAuthHeader = `Bearer realm="MCP Server", resource_metadata_uri="${baseUrl}/.well-known/oauth-protected-resource"`;
    res.setHeader('WWW-Authenticate', wwwAuthHeader);
}

function b64urlSha256(input: string): string {
    const hash = crypto.createHash('sha256').update(input).digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    return hash;
}

const parseBearer = (req: IncomingMessage): BearerAuth => {
    const auth = (req.headers['authorization'] as any) || (req.headers['Authorization' as any] as any);
    if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
        throw new Error('Missing Bearer auth');
    }
    const token = auth.slice('Bearer '.length).trim();
    // 1) If token matches an issued OAuth access token, return mapped credentials
    const fromIssued = issuedAccessTokens.get(token);
    if (fromIssued) {
        if (Date.now() > fromIssued.expiresAt) {
            issuedAccessTokens.delete(token);
        } else {
            return fromIssued.authInfo;
        }
    }
    const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
    let creds: any = tryParse(token);
    if (!creds) {
        try {
            const normalized = token.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(token.length / 4) * 4, '=');
            const decoded = Buffer.from(normalized, 'base64').toString('utf8');
            creds = tryParse(decoded);
        } catch { /* ignore */ }
    }
    if (!creds) throw new Error('Bearer must be JSON or base64(JSON)');
    const result: BearerAuth = {};
    if (creds?.username) result.username = String(creds.username);
    if (creds?.password) result.password = String(creds.password);
    if (creds?.cookies) result.cookies = creds.cookies;
    if (!result.cookies && !(result.username && result.password)) {
        throw new Error('Bearer must include cookies or username/password');
    }
    return result;
};

function getAuthFromEnv(): BearerAuth | null {
    const cookiesJson = process.env.LI_COOKIES;
    const envUsername = process.env.LI_USERNAME as string | undefined;
    const envPassword = process.env.LI_PASSWORD as string | undefined;
    if (cookiesJson) {
        return { username: envUsername, cookies: cookiesJson };
    }
    if (envUsername && envPassword) {
        return { username: envUsername, password: envPassword };
    }
    return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dbg(...args: any[]) {
    if (process.env.LI_DEBUG === '1' || process.env.LI_DEBUG_SEARCH === '1') {
        // eslint-disable-next-line no-console
        console.log('[LI]', ...args);
    }
}

function serializeCookieHeader(arr: any[]): string {
    const parts: string[] = [];
    for (const c of arr) {
        if (!c || typeof c !== 'object') continue;
        const name = String(c.name || '').trim();
        if (!name) continue;
        const value = String(c.value ?? '').trim();
        parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
}

async function manualAuthProbe(auth: BearerAuth): Promise<{ status: number; location?: string; bodyPreview?: string }> {
    const provided = auth.cookies;
    if (!provided) throw new Error('auth_probe requires cookies');
    const cookiesArr = Array.isArray(provided) ? provided : JSON.parse(String(provided));
    const js = cookiesArr.find((c: any) => String(c?.name).toUpperCase() === 'JSESSIONID');
    const jsValue = typeof js?.value === 'string' && js.value.startsWith('"') && js.value.endsWith('"')
        ? js.value.slice(1, -1)
        : String(js?.value || '');
    const cookieHeader = serializeCookieHeader(cookiesArr);
    const headers: Record<string, string> = {
        'user-agent': process.env.LI_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'x-restli-protocol-version': '2.0.0',
        'referer': 'https://www.linkedin.com/feed/',
        'cookie': cookieHeader,
    };
    if (jsValue) headers['csrf-token'] = jsValue;
    return await new Promise((resolve, reject) => {
        const req = https.request({
            method: 'GET',
            hostname: 'www.linkedin.com',
            path: '/voyager/api/me',
            headers
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                const preview = raw.length > 1000 ? raw.slice(0, 1000) + '…' : raw;
                resolve({ status: res.statusCode || 0, location: String(res.headers['location'] || ''), bodyPreview: preview });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function authCookiesFromBearer(auth: BearerAuth): any[] {
    const provided = auth.cookies;
    const raw = Array.isArray(provided) ? provided : JSON.parse(String(provided));
    return raw.map((c: any) => {
        if (String(c?.name).toUpperCase() === 'JSESSIONID' && typeof c?.value === 'string') {
            const v = c.value;
            const unquoted = v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
            return { ...c, value: unquoted };
        }
        return c;
    });
}

async function manualGet<T = any>(auth: BearerAuth, path: string, referer: string, label?: string): Promise<T> {
    const cookiesArr = authCookiesFromBearer(auth);
    const js = cookiesArr.find((c: any) => String(c?.name).toUpperCase() === 'JSESSIONID');
    const jsValue = String(js?.value || '');
    const cookieHeader = serializeCookieHeader(cookiesArr);
    const langCookie = cookiesArr.find((c: any) => String(c?.name) === 'lang');
    const langValue: string | undefined = typeof langCookie?.value === 'string' ? langCookie.value : undefined;
    const langParam = langValue && /lang=([a-z-]+)/i.test(langValue) ? /lang=([a-z-]+)/i.exec(langValue)![1] : undefined;
    const xLiLang = langParam ? langParam.replace('-', '_') : 'en_US';
    const headers: Record<string, string> = {
        'user-agent': process.env.LI_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'x-restli-protocol-version': '2.0.0',
        'referer': referer,
        'cookie': cookieHeader,
        'accept-language': 'en-US,en;q=0.9',
        'x-li-lang': xLiLang,
        'x-li-track': '{"clientVersion":"1.11.*","osName":"web","osVersion":"unknown","deviceFormFactor":"DESKTOP","mpName":"voyager-web"}',
    };
    if (jsValue) headers['csrf-token'] = jsValue.startsWith('ajax:') ? jsValue : `ajax:${jsValue}`;
    return await new Promise((resolve, reject) => {
        const req = https.request({ method: 'GET', hostname: 'www.linkedin.com', path, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (process.env.LI_DEBUG === '1' || process.env.LI_DEBUG_SEARCH === '1') {
                    dbg((label || 'GET'), path, 'status', res.statusCode, 'bytes', raw.length);
                    const preview = raw.slice(0, 200).replace(/\s+/g, ' ');
                    dbg('preview:', preview);
                }
                try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function manualGetProfileRaw(auth: BearerAuth, publicIdentifier: string): Promise<any> {
    const pid = publicIdentifier.replace(/^\/*in\/*/, '');
    const referer = `https://www.linkedin.com/in/${pid}/`;
    const path = `/voyager/api/identity/profiles/${encodeURIComponent(pid)}/profileView`;
    return await manualGet(auth, path, referer);
}

function parseVoyagerProfile(raw: any): ProfileResult {
    const included: any[] = Array.isArray(raw?.included) ? raw.included : [];
    const byType: Record<string, any[]> = {};
    for (const item of included) {
        const t = String(item?.$type || 'unknown');
        (byType[t] ||= []).push(item);
    }
    const isType = (s: string, needle: string) => s.toLowerCase().includes(needle);

    const miniProfiles = Object.entries(byType)
        .filter(([t]) => isType(t, 'miniprofile'))
        .flatMap(([, arr]) => arr);
    const mini = miniProfiles[0] || {};
    const first = mini?.firstName || '';
    const last = mini?.lastName || '';
    const fullName = `${first} ${last}`.trim();

    const positions = Object.entries(byType)
        .filter(([t]) => isType(t, 'position') || isType(t, 'positiongroup'))
        .flatMap(([, arr]) => arr);
    const educations = Object.entries(byType)
        .filter(([t]) => isType(t, 'education'))
        .flatMap(([, arr]) => arr);
    const skillsArr = Object.entries(byType)
        .filter(([t]) => isType(t, 'skill'))
        .flatMap(([, arr]) => arr);

    const normalizeDate = (obj: any): string | undefined => {
        const y = obj?.year, m = obj?.month, d = obj?.day;
        const s = [y, m, d].filter(Boolean).join('-');
        return s || undefined;
    };

    const experience: ExperienceItem[] = positions.map((p: any) => {
        const title = p?.title || p?.name || p?.positionName || p?.localizedTitle || null;
        const company = p?.companyName || p?.company?.name || p?.entityLocalizedName || null;
        const time = p?.timePeriod || p?.dateRange || {};
        const start = normalizeDate(time?.startDate || time?.start || {});
        const end = normalizeDate(time?.endDate || time?.end || {});
        return { title, company, start, end };
    });

    const education: EducationItem[] = educations.map((e: any) => {
        const school = e?.schoolName || e?.school?.name || e?.entityLocalizedName || null;
        const degree = e?.degreeName || e?.degree || e?.fieldOfStudy || null;
        const time = e?.timePeriod || e?.dateRange || {};
        const start = normalizeDate(time?.startDate || time?.start || {});
        const end = normalizeDate(time?.endDate || time?.end || {});
        return { school, degree, start, end };
    });

    const skills = skillsArr
        .map((s: any) => s?.name || s?.skill?.name || s?.entityLocalizedName)
        .filter(Boolean) as string[];

    const birthDate = null;
    const summary = null;
    return { fullName, birthDate, summary, experience, education, skills };
}

async function manualSearchPeopleRaw(auth: BearerAuth, query: string, limit = 10): Promise<any> {
    const qStr = String(query || '');
    const count = Math.min(Math.max(limit, 1), 25);
    const params = new URLSearchParams({
        count: String(count),
        filters: 'List(resultType->PEOPLE)',
        origin: 'GLOBAL_SEARCH_HEADER',
        q: 'all',
        start: '0',
        queryContext: 'List(spellCorrectionEnabled->true,relatedSearchesEnabled->true,kcardTypes->PROFILE|COMPANY)'
    });
    if (qStr) params.set('keywords', qStr);
    const path = `/voyager/api/search/blended?${params.toString()}`;
    const qEnc = encodeURIComponent(qStr);
    const referer = `https://www.linkedin.com/search/results/people/?keywords=${qEnc}`;
    dbg('search blended (py) request');
    const blended = await manualGet(auth, path, referer, 'search-blended-py');
    return blended;
}

function parsePeopleFromBlended(raw: any): SearchAccountResult[] {
    const results: SearchAccountResult[] = [];
    try {
        const elements = Array.isArray(raw?.data?.elements) ? raw.data.elements : [];
        const personRows: any[] = [];
        for (const section of elements) {
            const items = Array.isArray(section?.elements) ? section.elements : [];
            for (const item of items) personRows.push(item);
        }
        for (const row of personRows) {
            const publicIdentifier = row?.publicIdentifier || row?.target?.publicIdentifier || row?.title?.text?.text || '';
            if (!publicIdentifier) continue;
            const first = row?.title?.text?.text?.split(' ')?.[0] || '';
            const last = row?.title?.text?.text?.split(' ')?.slice(1).join(' ') || '';
            const fullName = `${first} ${last}`.trim() || row?.title?.text?.text || 'Unknown';
            const headline = row?.headline?.text?.text || row?.subtitle?.text?.text || null;
            results.push({ fullName, headline, location: null, publicIdentifier });
            if (results.length >= 25) break;
        }
        if (results.length === 0) {
            // fallback to included/miniprofile if present
            const included: any[] = Array.isArray(raw?.included) ? raw.included : [];
            const byType: Record<string, any[]> = {};
            for (const item of included) {
                const t = String(item?.$type || 'unknown');
                (byType[t] ||= []).push(item);
            }
            const miniProfiles = Object.entries(byType)
                .filter(([t]) => String(t).toLowerCase().includes('miniprofile'))
                .flatMap(([, arr]) => arr);
            for (const mp of miniProfiles) {
                const first = mp?.firstName || '';
                const last = mp?.lastName || '';
                const fullName = `${first} ${last}`.trim();
                const publicIdentifier = mp?.publicIdentifier || '';
                const headline = mp?.occupation || null;
                if (publicIdentifier) results.push({ fullName, headline, location: null, publicIdentifier });
                if (results.length >= 25) break;
            }
        }
    } catch { }
    return results;
}

async function searchAccounts(auth: BearerAuth, query: string, limit = 10): Promise<SearchAccountResult[]> {
    const raw = await manualSearchPeopleRaw(auth, query, limit);
    const results = parsePeopleFromBlended(raw).slice(0, limit);
    dbg('parsed search results:', results.length);
    if (results.length === 0) {
        // Try a gentler origin and no filters as a fallback
        const q = encodeURIComponent(query);
        const referer = `https://www.linkedin.com/search/results/people/?keywords=${q}`;
        const path = `/voyager/api/search/blended?keywords=${q}&q=all&count=${Math.min(Math.max(limit, 1), 25)}&start=0`;
        try {
            dbg('search blended (alt) request');
            const alt = await manualGet(auth, path, referer, 'search-blended-alt');
            const parsed = parsePeopleFromBlended(alt).slice(0, limit);
            dbg('parsed alt search results:', parsed.length);
            return parsed;
        } catch (e: any) { dbg('search blended (alt) failed:', e?.message || String(e)); }
    }
    return results;
}

async function getProfile(auth: BearerAuth, publicIdentifier: string): Promise<ProfileResult> {
    const raw = await manualGetProfileRaw(auth, publicIdentifier);
    return parseVoyagerProfile(raw);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
        // Propagate Mcp-Session-Id
        const incomingSessionId = String((req.headers['mcp-session-id'] as string) || '').trim();
        const effectiveSessionId = incomingSessionId || crypto.randomBytes(8).toString('hex');
        res.setHeader('Mcp-Session-Id', effectiveSessionId);

        const urlPath = String(req.url || '');
        const baseUrl = baseUrlFrom(req);

        // OAuth 2.1 discovery: protected resource metadata
        if (req.method === 'GET' && (urlPath === '/.well-known/oauth-protected-resource')) {
            json(res, 200, {
                issuer: baseUrl,
                authorization_servers: [`${baseUrl}/.well-known/oauth-authorization-server`]
            });
            return;
        }

        // OAuth 2.1 discovery: authorization server metadata
        if (req.method === 'GET' && (urlPath === '/.well-known/oauth-authorization-server')) {
            json(res, 200, {
                issuer: baseUrl,
                authorization_endpoint: `${baseUrl}/oauth/authorize`,
                token_endpoint: `${baseUrl}/oauth/token`,
                code_challenge_methods_supported: ['S256', 'plain'],
                grant_types_supported: ['authorization_code'],
                response_types_supported: ['code']
            });
            return;
        }

        // OAuth 2.1 authorization endpoint (minimal; expects Authorization header with credentials)
        if (req.method === 'GET' && urlPath.startsWith('/oauth/authorize')) {
            const urlObj = new URL(baseUrl + urlPath);
            const response_type = urlObj.searchParams.get('response_type') || 'code';
            const redirect_uri = urlObj.searchParams.get('redirect_uri') || '';
            const state = urlObj.searchParams.get('state') || '';
            const code_challenge = urlObj.searchParams.get('code_challenge') || undefined;
            const code_challenge_method = (urlObj.searchParams.get('code_challenge_method') as any) || 'S256';
            if (response_type !== 'code') {
                json(res, 400, { error: 'unsupported_response_type' });
                return;
            }
            let authInfo: BearerAuth | null = null;
            try { authInfo = parseBearer(req); } catch { authInfo = getAuthFromEnv(); }
            if (!authInfo) {
                setWwwAuthenticate(res, baseUrl);
                json(res, 401, { error: 'Missing credentials for authorization' });
                return;
            }
            const code = crypto.randomBytes(24).toString('hex');
            issuedAuthCodes.set(code, {
                code_challenge,
                code_challenge_method: (code_challenge_method === 'plain' ? 'plain' : 'S256'),
                createdAt: Date.now(),
                authInfo
            });
            if (redirect_uri) {
                const sep = redirect_uri.includes('?') ? '&' : '?';
                const loc = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
                res.statusCode = 302;
                res.setHeader('Location', loc);
                res.end();
                return;
            }
            json(res, 200, { code, state });
            return;
        }

        // OAuth 2.1 token endpoint (authorization_code + PKCE)
        if (req.method === 'POST' && urlPath === '/oauth/token') {
            const body = await parseBody(req);
            const grant_type = String(body.grant_type || '');
            if (grant_type !== 'authorization_code') {
                json(res, 400, { error: 'unsupported_grant_type' });
                return;
            }
            const code = String(body.code || '');
            const code_verifier = String(body.code_verifier || '');
            const data = issuedAuthCodes.get(code);
            if (!data) {
                json(res, 400, { error: 'invalid_grant' });
                return;
            }
            if (data.code_challenge) {
                if (!code_verifier) {
                    json(res, 400, { error: 'code_verifier_required' });
                    return;
                }
                const calculated = (data.code_challenge_method === 'S256') ? b64urlSha256(code_verifier) : code_verifier;
                if (calculated !== data.code_challenge) {
                    json(res, 401, { error: 'invalid_code_verifier' });
                    return;
                }
            }
            issuedAuthCodes.delete(code);
            const access_token = crypto.randomBytes(32).toString('hex');
            const now = Date.now();
            const ttlMs = 3600 * 1000; // 1 hour
            issuedAccessTokens.set(access_token, { authInfo: data.authInfo, createdAt: now, expiresAt: now + ttlMs });
            json(res, 200, { access_token, token_type: 'Bearer', expires_in: Math.floor(ttlMs / 1000) });
            return;
        }

        if (req.method !== 'POST' || (urlPath !== '/mcp' && urlPath !== '/api/mcp')) {
            json(res, 404, { error: 'Not Found' });
            return;
        }

        // Auth
        let auth: BearerAuth | null = null;
        try {
            auth = parseBearer(req);
        } catch (e: any) {
            auth = getAuthFromEnv();
            if (!auth) {
                setWwwAuthenticate(res, baseUrl);
                json(res, 401, { error: e?.message || 'Unauthorized' });
                return;
            }
        }

        const body = await parseBody(req) as any;
        if (!body || typeof body !== 'object') {
            json(res, 400, { error: 'Invalid JSON body' });
            return;
        }

        // Support JSON-RPC style for Streamable HTTP compatibility
        const isJsonRpc = body && body.jsonrpc === '2.0' && typeof body.method === 'string';
        const rpcId = isJsonRpc ? body.id : undefined;

        const replyRpc = (payload: any) => {
            if (isJsonRpc) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ jsonrpc: '2.0', id: rpcId, ...payload }));
            } else {
                json(res, 200, payload);
            }
        };

        const method = isJsonRpc ? String(body.method) : undefined;
        if (body.type === 'list_tools' || method === 'tools/list' || method === 'list_tools') {
            const tools: any[] = [];
            if (ADVERTISE_SEARCH) {
                tools.push({
                    name: 'search_accounts',
                    description: 'Search LinkedIn people by keywords and return first page of results',
                    parameters: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            query: { type: 'string', description: 'Keywords to search for (e.g. name, title, company)' },
                            limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 }
                        },
                        required: ['query']
                    }
                });
            }
            tools.push({
                name: 'get_profile',
                description: 'Fetch a LinkedIn profile by publicIdentifier and return summary, experience, education and skills',
                parameters: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        publicIdentifier: { type: 'string', description: 'Public identifier from profile URL, e.g. "in/NAME" or plain handle' }
                    },
                    required: ['publicIdentifier']
                }
            });
            tools.push({
                name: 'auth_probe',
                description: 'Check cookie auth by calling LinkedIn voyager/api/me directly (manual request)',
                parameters: { type: 'object', additionalProperties: false, properties: {} }
            });
            if (isJsonRpc) {
                replyRpc({ result: { tools } });
            } else {
                json(res, 200, { tools });
            }
            return;
        }

        if (body.type === 'call_tool' || method === 'tools/call' || method === 'call_tool') {
            const name = isJsonRpc ? String(body.params?.name || '') : String(body.name || '');
            const params = isJsonRpc ? (body.params?.arguments || body.params || {}) : (body.params || {});
            if (name === 'auth_probe') {
                const probe = await manualAuthProbe(auth);
                if (isJsonRpc) return replyRpc({ result: { probe } });
                json(res, 200, { probe });
                return;
            }
            try {
                if (name === 'search_accounts') {
                    const q = params?.query || '';
                    dbg('search_accounts:', { q, limit: params?.limit });
                    const limit = Math.min(Math.max(Number(params?.limit ?? 10), 1), 25);
                    try {
                        const results = await searchAccounts(auth, q, limit);
                        if (isJsonRpc) return replyRpc({ result: { results } });
                        json(res, 200, { results });
                    } catch (e: any) {
                        const status = e?.response?.status;
                        const note = status ? `search denied by LinkedIn (status ${status})` : 'search failed';
                        dbg('search_accounts failed:', e?.message || String(e));
                        if (isJsonRpc) return replyRpc({ result: { results: [], note } });
                        json(res, 200, { results: [], note });
                    }
                    return;
                }
                if (name === 'get_profile') {
                    const publicIdentifier = params?.publicIdentifier;
                    if (!publicIdentifier) {
                        if (isJsonRpc) return replyRpc({ error: { code: -32602, message: 'publicIdentifier is required' } });
                        json(res, 400, { error: 'publicIdentifier is required' });
                        return;
                    }
                    // brief throttle to reduce rate limiting
                    await sleep(500);
                    try {
                        const result = await getProfile(auth as any, publicIdentifier);
                        if (isJsonRpc) return replyRpc({ result: { result } });
                        json(res, 200, { result });
                    } catch (e: any) {
                        const status = e?.response?.status;
                        const csrf = String(e?.response?.data || '').includes('CSRF');
                        if (status === 403 || csrf) {
                            // Fallback to manual voyager call
                            try {
                                const raw = await manualGetProfileRaw(auth, publicIdentifier);
                                const parsed = parseVoyagerProfile(raw);
                                if (isJsonRpc) return replyRpc({ result: { result: parsed, note: 'library failed (CSRF), used manual voyager fallback' } });
                                json(res, 200, { result: parsed, note: 'library failed (CSRF), used manual voyager fallback' });
                            } catch (fallbackErr: any) {
                                if (isJsonRpc) return replyRpc({ error: { code: -32000, message: 'LinkedIn library and fallback both failed', data: fallbackErr?.message || String(fallbackErr) } });
                                json(res, 500, { error: 'LinkedIn library and fallback both failed', data: fallbackErr?.message || String(fallbackErr) });
                            }
                        } else {
                            if (isJsonRpc) return replyRpc({ error: { code: -32000, message: e?.message || 'Failed to get profile' } });
                            json(res, 500, { error: e?.message || 'Failed to get profile' });
                        }
                    }
                    return;
                }
                if (isJsonRpc) return replyRpc({ error: { code: -32601, message: 'Unknown tool' } });
                json(res, 400, { error: `Unknown tool` });
            } finally {
                // No persistent connection required
            }
            return;
        }

        json(res, 400, { error: 'Unsupported request' });
    } catch (err: any) {
        if (err?.code === 'ERR_FR_TOO_MANY_REDIRECTS') {
            const hint = 'Too many redirects. Session cookies likely stale or blocked. Set LI_RESET=1 and try fresh LI_COOKIES.';
            return json(res, 500, { error: hint });
        }
        if (err?.response) {
            json(res, err.response.status || 500, { error: err.response.statusText || 'LinkedIn error', data: err.response.data });
            return;
        }
        json(res, 500, { error: err?.message || 'Internal Server Error' });
    }
}

// Start server locally. On Vercel, export default handler.
if (!process.env.VERCEL) {
    const port = Number(process.env.PORT || 3000);
    createServer(handle).listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`MCP server listening on http://localhost:${port}/mcp`);
    });
}

export default async function vercelHandler(req: any, res: any) {
    return handle(req, res);
}


