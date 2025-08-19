import { createServer, IncomingMessage, ServerResponse } from 'http';
import https from 'https';
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
    return raw ? JSON.parse(raw) : {};
};

const parseBearer = (req: IncomingMessage): BearerAuth => {
    const auth = (req.headers['authorization'] as any) || (req.headers['Authorization' as any] as any);
    if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
        throw new Error('Missing Bearer auth');
    }
    const token = auth.slice('Bearer '.length).trim();
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

async function manualGet<T = any>(auth: BearerAuth, path: string, referer: string): Promise<T> {
    const cookiesArr = authCookiesFromBearer(auth);
    const js = cookiesArr.find((c: any) => String(c?.name).toUpperCase() === 'JSESSIONID');
    const jsValue = String(js?.value || '');
    const cookieHeader = serializeCookieHeader(cookiesArr);
    const headers: Record<string, string> = {
        'user-agent': process.env.LI_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'x-restli-protocol-version': '2.0.0',
        'referer': referer,
        'cookie': cookieHeader,
    };
    if (jsValue) headers['csrf-token'] = jsValue;
    return await new Promise((resolve, reject) => {
        const req = https.request({ method: 'GET', hostname: 'www.linkedin.com', path, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
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
    const q = encodeURIComponent(query);
    const start = 0;
    const count = Math.min(Math.max(limit, 1), 25);
    const filters = encodeURIComponent('List(resultType->PEOPLE)');
    const path = `/voyager/api/search/people?keywords=${q}&origin=GLOBAL_SEARCH_HEADER&q=all&filters=${filters}&count=${count}&start=${start}`;
    const referer = `https://www.linkedin.com/search/results/people/?keywords=${q}`;
    return await manualGet(auth, path, referer);
}

function parsePeopleFromBlended(raw: any): SearchAccountResult[] {
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
    const results: SearchAccountResult[] = [];
    for (const mp of miniProfiles) {
        const first = mp?.firstName || '';
        const last = mp?.lastName || '';
        const fullName = `${first} ${last}`.trim();
        const publicIdentifier = mp?.publicIdentifier || '';
        const headline = mp?.occupation || null;
        const location = null;
        if (publicIdentifier) results.push({ fullName, headline, location, publicIdentifier });
        if (results.length >= 10) break;
    }
    return results;
}

async function searchAccounts(auth: BearerAuth, query: string, limit = 10): Promise<SearchAccountResult[]> {
    const raw = await manualSearchPeopleRaw(auth, query, limit);
    return parsePeopleFromBlended(raw).slice(0, limit);
}

async function getProfile(auth: BearerAuth, publicIdentifier: string): Promise<ProfileResult> {
    const raw = await manualGetProfileRaw(auth, publicIdentifier);
    return parseVoyagerProfile(raw);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
        if (req.method !== 'POST' || (req.url || '') !== '/mcp') {
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
                json(res, 401, { error: e?.message || 'Unauthorized' });
                return;
            }
        }

        const body = await parseBody(req) as McpRequest;
        if (!body || typeof body !== 'object') {
            json(res, 400, { error: 'Invalid JSON body' });
            return;
        }

        if (body.type === 'list_tools') {
            const tools: any[] = [];
            if (ADVERTISE_SEARCH) {
                tools.push({
                    name: 'search_accounts',
                    description: 'Search LinkedIn people by keywords and return first page of results',
                    parameters: { query: 'string', limit: 'number (optional, default 10)' }
                });
            }
            tools.push({
                name: 'get_profile',
                description: 'Fetch a LinkedIn profile by publicIdentifier and return summary, experience, education and skills',
                parameters: { publicIdentifier: 'string' }
            });
            tools.push({
                name: 'auth_probe',
                description: 'Check cookie auth by calling LinkedIn voyager/api/me directly (manual request)',
                parameters: {}
            });
            json(res, 200, { tools });
            return;
        }

        if (body.type === 'call_tool') {
            if (body.name === 'auth_probe') {
                const probe = await manualAuthProbe(auth);
                json(res, 200, { probe });
                return;
            }
            try {
                if (body.name === 'search_accounts') {
                    const q = body.params?.query || '';
                    const limit = Math.min(Math.max(Number(body.params?.limit ?? 10), 1), 25);
                    try {
                        const results = await searchAccounts(auth, q, limit);
                        json(res, 200, { results });
                    } catch (e: any) {
                        const status = e?.response?.status;
                        const note = status ? `search denied by LinkedIn (status ${status})` : 'search failed';
                        json(res, 200, { results: [], note });
                    }
                    return;
                }
                if (body.name === 'get_profile') {
                    const publicIdentifier = body.params?.publicIdentifier;
                    if (!publicIdentifier) {
                        json(res, 400, { error: 'publicIdentifier is required' });
                        return;
                    }
                    // brief throttle to reduce rate limiting
                    await sleep(500);
                    try {
                        const result = await getProfile(auth as any, publicIdentifier);
                        json(res, 200, { result });
                    } catch (e: any) {
                        const status = e?.response?.status;
                        const csrf = String(e?.response?.data || '').includes('CSRF');
                        if (status === 403 || csrf) {
                            // Fallback to manual voyager call
                            try {
                                const raw = await manualGetProfileRaw(auth, publicIdentifier);
                                const parsed = parseVoyagerProfile(raw);
                                json(res, 200, { result: parsed, note: 'library failed (CSRF), used manual voyager fallback' });
                            } catch (fallbackErr: any) {
                                json(res, 500, { error: 'LinkedIn library and fallback both failed', data: fallbackErr?.message || String(fallbackErr) });
                            }
                        } else {
                            json(res, 500, { error: e?.message || 'Failed to get profile' });
                        }
                    }
                    return;
                }
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


