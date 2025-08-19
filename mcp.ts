import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Client } from 'linkedin-private-api';
import fs from 'fs/promises';

type BearerAuth = { username: string; password: string };

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
    const auth = req.headers['authorization'] || req.headers['Authorization' as any];
    if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
        throw new Error('Missing Bearer auth');
    }
    const token = auth.slice('Bearer '.length).trim();
    let creds: any;
    try {
        creds = JSON.parse(token);
    } catch {
        throw new Error('Bearer must be a JSON string: {"username":"...","password":"..."}');
    }
    if (!creds?.username || !creds?.password) {
        throw new Error('Bearer JSON must include username and password');
    }
    return { username: String(creds.username), password: String(creds.password) };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let attempt = 0;
    while (attempt < 5) {
        try {
            return await fn();
        } catch (err: any) {
            const status = err?.response?.status;
            if (status === 429) {
                const retryAfter = Number(err?.response?.headers?.['retry-after']);
                const backoffMs = retryAfter ? retryAfter * 1000 : Math.min(30000, (1000 * 2 ** attempt) + Math.floor(Math.random() * 500));
                attempt += 1;
                await sleep(backoffMs);
                continue;
            }
            if (status === 404 && attempt < 2) {
                attempt += 1;
                await sleep(1000);
                continue;
            }
            throw err;
        }
    }
    return fn();
}

async function loginClient(auth: BearerAuth): Promise<Client> {
    // Always reset cached sessions as requested
    try { await fs.unlink('sessions.json'); } catch { }
    const client = new Client();
    await client.login.userPass({ username: auth.username, password: auth.password, useCache: false });
    return client;
}

function normalizeDate(obj: any): string | undefined {
    const y = obj?.year, m = obj?.month, d = obj?.day;
    const s = [y, m, d].filter(Boolean).join('-');
    return s || undefined;
}

async function searchAccounts(client: Client, query: string, limit = 10): Promise<SearchAccountResult[]> {
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
        const hits = await withRetry(() => scroller.scrollNext(), 'people.scrollNext');
        return hits.slice(0, limit).map((hit) => {
            const first = (hit.profile as any).firstName || '';
            const last = (hit.profile as any).lastName || '';
            const fullName = `${first} ${last}`.trim();
            const headline = (hit.profile as any).occupation || null;
            const publicIdentifier = (hit.profile as any).publicIdentifier;
            return { fullName, headline, location: null, publicIdentifier };
        });
    } catch (err: any) {
        throw err;
    }
}

async function getProfile(client: Client, publicIdentifier: string): Promise<ProfileResult> {
    try {
        const defaults: any = (client as any).request.request.defaults.headers;
        (client as any).request.setHeaders({
            ...defaults,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            referer: `https://www.linkedin.com/in/${publicIdentifier.replace(/^\/*in\/*/, '')}/`,
        });
    } catch { }
    await sleep(800);
    // High-level object
    const profile = await withRetry(() => client.profile.getProfile({ publicIdentifier }), 'profile.getProfile');
    // Raw response for included entities
    const raw = await withRetry(() => (client as any).request.profile.getProfile({ publicIdentifier }), 'profile.getProfile(raw)');
    const included: any[] = Array.isArray(raw?.included) ? raw.included : [];

    const byType: Record<string, any[]> = {};
    for (const item of included) {
        const t = item?.$type || 'unknown';
        if (!byType[t]) byType[t] = [];
        byType[t].push(item);
    }
    const isType = (s: string, needle: string) => s.toLowerCase().includes(needle);

    const positions = Object.entries(byType)
        .filter(([t]) => isType(t, 'position') || isType(t, 'positiongroup'))
        .flatMap(([, arr]) => arr);
    const educations = Object.entries(byType)
        .filter(([t]) => isType(t, 'education'))
        .flatMap(([, arr]) => arr);
    const skillsArr = Object.entries(byType)
        .filter(([t]) => isType(t, 'skill'))
        .flatMap(([, arr]) => arr);

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
        .filter(Boolean);

    const first = (profile as any).firstName || (profile as any).localizedFirstName || '';
    const last = (profile as any).lastName || (profile as any).localizedLastName || '';
    const fullName = `${first} ${last}`.trim();
    const birthDate = (profile as any).birthDateOn || null;
    const summary = (profile as any).summary
        || (profile as any).multiLocaleSummary && Object.values((profile as any).multiLocaleSummary)[0]
        || null;

    return { fullName, birthDate, summary, experience, education, skills };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
        if (req.method !== 'POST' || (req.url || '') !== '/mcp') {
            json(res, 404, { error: 'Not Found' });
            return;
        }

        // Auth
        let auth: BearerAuth;
        try {
            auth = parseBearer(req);
        } catch (e: any) {
            json(res, 401, { error: e?.message || 'Unauthorized' });
            return;
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
            json(res, 200, { tools });
            return;
        }

        if (body.type === 'call_tool') {
            const client = await loginClient(auth);
            try {
                if (body.name === 'search_accounts') {
                    const q = body.params?.query || '';
                    const limit = Math.min(Math.max(Number(body.params?.limit ?? 10), 1), 25);
                    try {
                        const results = await searchAccounts(client, q, limit);
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
                    const result = await getProfile(client, publicIdentifier);
                    json(res, 200, { result });
                    return;
                }
                json(res, 400, { error: `Unknown tool ${body.name}` });
            } finally {
                // No persistent connection required
            }
            return;
        }

        json(res, 400, { error: 'Unsupported request' });
    } catch (err: any) {
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


