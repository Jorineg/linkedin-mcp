import dotenv from 'dotenv';
import http from 'http';
import https from 'https';

dotenv.config();

const SERVER_URL = process.env.MCP_URL || 'http://localhost:3000/mcp';
console.log('SERVER_URL:', SERVER_URL);

function callMcp(body: any, bearerJson: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const url = new URL(SERVER_URL);
        const bearerJsonString = JSON.stringify(bearerJson);
        const bearerB64 = Buffer.from(bearerJsonString, 'utf8').toString('base64');
        const isHttps = url.protocol === 'https:';
        const req = (isHttps ? https : http).request({
            method: 'POST',
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${bearerB64}`,
            },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
            });
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}

(async () => {
    const cookies = process.env.LI_COOKIES;
    const username = process.env.LI_USERNAME as string | undefined;
    const password = process.env.LI_PASSWORD as string | undefined;
    let bearer: any;
    if (cookies) {
        bearer = { username, cookies: JSON.parse(cookies) };
    } else if (username && password) {
        bearer = { username, password };
    } else {
        console.error('Please set LI_COOKIES or LI_USERNAME and LI_PASSWORD in .env');
        process.exit(1);
    }

    // Test list_tools
    const tools = await callMcp({ type: 'list_tools' }, bearer);
    console.log('Tools:', tools);

    // Test search_accounts
    const query = process.env.LI_SEARCH_NAME || 'Bill Gates';
    const searchResp = await callMcp({ type: 'call_tool', name: 'search_accounts', params: { query } }, bearer);
    console.log('Search results:', JSON.stringify(searchResp, null, 2));

    // Manual cookie auth probe first
    const authProbe = await callMcp({ type: 'call_tool', name: 'auth_probe', params: {} }, bearer);
    console.log('Auth probe:', JSON.stringify(authProbe, null, 2));

    // Then get_profile if configured
    const publicIdentifier = process.env.LI_PUBLIC_ID;
    if (!publicIdentifier) {
        console.warn('LI_PUBLIC_ID not set; skipping get_profile test');
        return;
    }
    const profileResp = await callMcp({ type: 'call_tool', name: 'get_profile', params: { publicIdentifier } }, bearer);
    console.log('Profile:', JSON.stringify(profileResp, null, 2));
})();


