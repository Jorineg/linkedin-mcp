import { Client } from 'linkedin-private-api';
import dotenv from 'dotenv';
import fs from 'fs/promises';

dotenv.config();

const username = process.env.LI_USERNAME as string;
const password = process.env.LI_PASSWORD as string;
const cookiesJson = process.env.LI_COOKIES;
const baseDelayMs = Number(process.env.LI_DELAY_MS || 1500);
const directPublicId = process.env.LI_PUBLIC_ID as string | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429 && attempt < 5) {
        const retryAfter = Number(err?.response?.headers?.['retry-after']);
        const backoffMs = retryAfter ? retryAfter * 1000 : Math.min(30000, (1000 * 2 ** attempt) + Math.floor(Math.random() * 500));
        console.warn(`${label}: 429 rate limited. Retrying in ${backoffMs}ms (attempt ${attempt + 1})`);
        await sleep(backoffMs);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

(async () => {
  const client = new Client();
  try {
    if (process.env.LI_RESET === '1') {
      try { await fs.unlink('sessions.json'); } catch { }
    }

    const haveCreds = Boolean(username && password);
    if (haveCreds) {
      await client.login.userPass({ username, password, useCache: true });
    } else if (cookiesJson) {
      await client.login.userCookie({ username, cookies: JSON.parse(cookiesJson), useCache: false });
    } else {
      throw new Error('Provide LI_USERNAME/LI_PASSWORD or LI_COOKIES');
    }

    // tweak headers slightly to a modern browser UA
    try {
      const defaults: any = (client as any).request.request.defaults.headers;
      const referer = directPublicId
        ? `https://www.linkedin.com/in/${directPublicId.replace(/^\/*in\/*/, '')}/`
        : 'https://www.linkedin.com/feed/';
      (client as any).request.setHeaders({
        ...defaults,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        referer
      });
    } catch { }

    if (!directPublicId) {
      const me = await client.profile.getOwnProfile();
      const myFirst = (me as any).firstName || (me as any).localizedFirstName || '';
      const myLast = (me as any).lastName || (me as any).localizedLastName || '';
      console.log('Logged in as:', `${myFirst} ${myLast}`.trim() || 'Unknown');
    }

    // If a direct public identifier is provided, skip search entirely
    let publicIdentifier: string | undefined = directPublicId;
    if (!publicIdentifier) {
      await sleep(baseDelayMs);
      const peopleScroller = await client.search.searchPeople({ keywords: 'Christina Jing Xu', limit: 1 });
      const hits = await withRetry(() => peopleScroller.scrollNext(), 'people.scrollNext');
      console.log('Search hits:', hits.length);
      if (hits.length === 0) {
        console.log('No people found for keywords. Try a different name.');
        return;
      }
      const firstHit = hits[0];
      publicIdentifier = firstHit.profile.publicIdentifier;
    }
    await sleep(baseDelayMs);
    const fullProfile = await withRetry(() => client.profile.getProfile({ publicIdentifier }), 'profile.getProfile');
    // Also fetch raw response to access included entities (experience, education, skills, recommendations)
    const raw = await withRetry(() => (client as any).request.profile.getProfile({ publicIdentifier }), 'profile.getProfile(raw)');
    // Print a concise header and then the full JSON
    const fpFirst = (fullProfile as any).firstName || (fullProfile as any).localizedFirstName || '';
    const fpLast = (fullProfile as any).lastName || (fullProfile as any).localizedLastName || '';
    console.log('Found profile:', `${fpFirst} ${fpLast}`.trim(), fullProfile.publicIdentifier);
    console.log('\nExperience / Education / Skills / Recommendations:');
    try {
      const included = Array.isArray(raw?.included) ? raw.included : [];
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
      const skills = Object.entries(byType)
        .filter(([t]) => isType(t, 'skill'))
        .flatMap(([, arr]) => arr);
      const recommendations = Object.entries(byType)
        .filter(([t]) => isType(t, 'recommendation'))
        .flatMap(([, arr]) => arr);

      const normalizeDate = (obj: any) => {
        const y = obj?.year, m = obj?.month, d = obj?.day;
        return [y, m, d].filter(Boolean).join('-') || undefined;
      };

      console.log('\n- Experience:');
      for (const p of positions) {
        const title = p?.title || p?.name || p?.positionName || p?.localizedTitle;
        const company = p?.companyName || p?.company?.name || p?.entityLocalizedName;
        const time = p?.timePeriod || p?.dateRange || {};
        const start = normalizeDate(time?.startDate || time?.start || {});
        const end = normalizeDate(time?.endDate || time?.end || {});
        console.log(`  • ${title || 'Role'} at ${company || 'Company'}${start ? ` (${start} – ${end || 'present'})` : ''}`);
      }

      console.log('\n- Education:');
      for (const e of educations) {
        const school = e?.schoolName || e?.school?.name || e?.entityLocalizedName;
        const degree = e?.degreeName || e?.degree || e?.fieldOfStudy;
        const time = e?.timePeriod || e?.dateRange || {};
        const start = normalizeDate(time?.startDate || time?.start || {});
        const end = normalizeDate(time?.endDate || time?.end || {});
        console.log(`  • ${school || 'School'}${degree ? ` — ${degree}` : ''}${start ? ` (${start} – ${end || 'present'})` : ''}`);
      }

      console.log('\n- Skills:');
      for (const s of skills) {
        const name = s?.name || s?.skill?.name || s?.entityLocalizedName;
        if (name) console.log(`  • ${name}`);
      }

      console.log('\n- Recommendations:');
      for (const r of recommendations) {
        const text = r?.recommendationText || r?.text || r?.attributedText?.text;
        const from = r?.recommender?.name || r?.recommenderProfile?.miniProfile?.firstName;
        if (text) console.log(`  • ${from ? `${from}: ` : ''}${text}`);
      }

      // Optional: show what types exist for debugging
      const typeSummary = Object.fromEntries(Object.entries(byType).map(([t, arr]) => [t, arr.length]));
      console.log('\n(types present):', JSON.stringify(typeSummary, null, 2));
    } catch (e) {
      console.log('Could not parse included entities');
    }

    console.log('\nFull profile JSON:');
    console.log(JSON.stringify(fullProfile, null, 2));
  } catch (err: any) {
    if (err?.code === 'ERR_FR_TOO_MANY_REDIRECTS') {
      console.error('Too many redirects. Session cookies likely stale. Delete sessions.json or set LI_RESET=1, or provide fresh LI_COOKIES.');
    }
    if (err?.response) {
      console.error('HTTP error:', err.response.status, err.response.statusText);
      try { console.error('Response data:', JSON.stringify(err.response.data)); } catch { }
    } else {
      console.error(err);
    }
  }
})();