import type { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs/promises';
import LinkedInPkg from 'linkedin-private-api';

export const config = { runtime: 'nodejs' };

type BearerAuth = { username?: string; password?: string; cookies?: any };
type McpRequest =
    | { type: 'list_tools' }
    | { type: 'call_tool'; name: 'search_accounts'; params: { query: string; limit?: number } }
    | { type: 'call_tool'; name: 'get_profile'; params: { publicIdentifier: string } };

type SearchAccountResult = {
    fullName: string;
    headline: string | null;
    location: string | null;
    publicIdentifier: string;
};

type ExperienceItem = { title: string | null; company: string | null; start?: string; end?: string };
type EducationItem = { school: string | null; degree?: string | null; start?: string; end?: string };
type ProfileResult = {
    fullName: string;
    birthDate?: string | null;
    summary?: string | null;
    experience: ExperienceItem[];
    education: EducationItem[];
    skills: string[];
};

const ADVERTISE_SEARCH = false;

const json = (res: ServerResponse, status: number, data: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
};

const parseBody = async (req: IncomingMessage): Promise<any> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
};

const parseBearer = (req: IncomingMessage): BearerAuth => {
    const auth = req.headers['authorization'] as string | undefined;
    if (!auth || !auth.startsWith('Bearer ')) throw new Error('Missing Bearer auth');
    const token = auth.slice('Bearer '.length).trim();
    const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
    let creds: any = tryParse(token);
    if (!creds) {
        // Try base64 (including base64url) decode
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
    if (!result.cookies && !(result.username && result.password)) throw new Error('Bearer must include cookies or username/password');
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
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (attempt < 5) {
        try { return await fn(); } catch (err: any) {
            const status = err?.response?.status;
            if (status === 429) {
                const retryAfter = Number(err?.response?.headers?.['retry-after']);
                const backoffMs = retryAfter ? retryAfter * 1000 : Math.min(30000, (1000 * 2 ** attempt) + Math.floor(Math.random() * 500));
                attempt += 1; await sleep(backoffMs); continue;
            }
            if (status === 404 && attempt < 2) { attempt += 1; await sleep(1000); continue; }
            throw err;
        }
    }
    return fn();
}

async function loginClient(auth: BearerAuth): Promise<any> {
    if (process.env.LI_RESET === '1') { try { await fs.unlink('sessions.json'); } catch { } }
    const ClientCtor = (LinkedInPkg as any).Client;
    const client = new ClientCtor();
    const providedCookies = auth.cookies;
    if (providedCookies) {
        const cookiesArr = Array.isArray(providedCookies) ? providedCookies : JSON.parse(String(providedCookies));
        const username = auth.username || process.env.LI_USERNAME || '';
        await client.login.userCookie({ username, cookies: cookiesArr, useCache: true });
        return client;
    }
    if (auth.username && auth.password) {
        await client.login.userPass({ username: auth.username, password: auth.password, useCache: true });
        return client;
    }
    throw new Error('No valid auth provided');
}

function normalizeDate(obj: any): string | undefined {
    const y = obj?.year, m = obj?.month, d = obj?.day;
    const s = [y, m, d].filter(Boolean).join('-');
    return s || undefined;
}

async function searchAccounts(client: any, query: string, limit = 10): Promise<SearchAccountResult[]> {
    try {
        try {
            const defaults: any = (client as any).request.request.defaults.headers;
            (client as any).request.setHeaders({
                ...defaults,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                referer: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`,
            });
        } catch { }
        await sleep(1200);
        const scroller = await client.search.searchPeople({ keywords: query, limit });
        const hits: any[] = await withRetry(() => scroller.scrollNext());
        return hits.slice(0, limit).map((hit: any) => {
            const first = (hit.profile as any).firstName || '';
            const last = (hit.profile as any).lastName || '';
            const fullName = `${first} ${last}`.trim();
            const headline = (hit.profile as any).occupation || null;
            const publicIdentifier = (hit.profile as any).publicIdentifier;
            return { fullName, headline, location: null, publicIdentifier };
        });
    } catch (err: any) { throw err; }
}

async function getProfile(client: any, publicIdentifier: string): Promise<ProfileResult> {
    try {
        const defaults: any = (client as any).request.request.defaults.headers;
        (client as any).request.setHeaders({
            ...defaults,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            referer: `https://www.linkedin.com/in/${publicIdentifier.replace(/^\/*in\/*/, '')}/`,
        });
    } catch { }
    await sleep(800);
    const profile: any = await withRetry(() => client.profile.getProfile({ publicIdentifier }));
    const raw: any = await withRetry(() => (client as any).request.profile.getProfile({ publicIdentifier }));
    const included: any[] = Array.isArray(raw?.included) ? raw.included : [];

    const byType: Record<string, any[]> = {};
    for (const item of included) { const t = item?.$type || 'unknown'; (byType[t] ||= []).push(item); }
    const isType = (s: string, needle: string) => s.toLowerCase().includes(needle);

    const positions = Object.entries(byType).filter(([t]) => isType(t, 'position') || isType(t, 'positiongroup')).flatMap(([, a]) => a);
    const educations = Object.entries(byType).filter(([t]) => isType(t, 'education')).flatMap(([, a]) => a);
    const skillsArr = Object.entries(byType).filter(([t]) => isType(t, 'skill')).flatMap(([, a]) => a);

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

    const skills = skillsArr.map((s: any) => s?.name || s?.skill?.name || s?.entityLocalizedName).filter(Boolean) as string[];
    const first = (profile as any).firstName || (profile as any).localizedFirstName || '';
    const last = (profile as any).lastName || (profile as any).localizedLastName || '';
    const fullName = `${first} ${last}`.trim();
    const birthDate = (profile as any).birthDateOn || null;
    const summary = (profile as any).summary || ((profile as any).multiLocaleSummary && Object.values((profile as any).multiLocaleSummary as any)[0]) || null;
    return { fullName, birthDate, summary, experience, education, skills };
}

export default async function handler(req: any, res: any) {
    try {
        if (req.method !== 'POST' || (req.url || '') !== '/api/mcp') { return json(res, 404, { error: 'Not Found' }); }
        let auth: BearerAuth | null = null;
        try { auth = parseBearer(req); } catch (e: any) { auth = getAuthFromEnv(); if (!auth) return json(res, 401, { error: e?.message || 'Unauthorized' }); }
        const body = await parseBody(req) as McpRequest; if (!body || typeof body !== 'object') return json(res, 400, { error: 'Invalid JSON body' });

        if (body.type === 'list_tools') {
            const tools: any[] = [];
            if (ADVERTISE_SEARCH) tools.push({ name: 'search_accounts', description: 'Search LinkedIn people by keywords and return first page of results', parameters: { query: 'string', limit: 'number (optional, default 10)' } });
            tools.push({ name: 'get_profile', description: 'Fetch a LinkedIn profile by publicIdentifier and return summary, experience, education and skills', parameters: { publicIdentifier: 'string' } });
            return json(res, 200, { tools });
        }

        if (body.type === 'call_tool') {
            const client = await loginClient(auth);
            if (body.name === 'search_accounts') {
                const q = body.params?.query || ''; const limit = Math.min(Math.max(Number(body.params?.limit ?? 10), 1), 25);
                try { const results = await searchAccounts(client, q, limit); return json(res, 200, { results }); }
                catch (e: any) { const status = e?.response?.status; const note = status ? `search denied by LinkedIn (status ${status})` : 'search failed'; return json(res, 200, { results: [], note }); }
            }
            if (body.name === 'get_profile') {
                const publicIdentifier = body.params?.publicIdentifier; if (!publicIdentifier) return json(res, 400, { error: 'publicIdentifier is required' });
                await sleep(500); const result = await getProfile(client, publicIdentifier); return json(res, 200, { result });
            }
            return json(res, 400, { error: 'Unknown tool' });
        }

        return json(res, 400, { error: 'Unsupported request' });
    } catch (err: any) {
        if (err?.response) return json(res, err.response.status || 500, { error: err.response.statusText || 'LinkedIn error', data: err.response.data });
        return json(res, 500, { error: err?.message || 'Internal Server Error' });
    }
}

