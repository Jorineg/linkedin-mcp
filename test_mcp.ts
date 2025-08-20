import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';

dotenv.config();

const SERVER_URL = process.env.MCP_URL || 'http://localhost:3000/mcp';
console.log('SERVER_URL:', SERVER_URL);

function callMcp(body: any, bearerToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const url = new URL(SERVER_URL);
        const isHttps = url.protocol === 'https:';
        const req = (isHttps ? https : http).request({
            method: 'POST',
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${bearerToken}`,
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
    const tokenPath = process.env.TOKEN_PATH || 'token.txt';
    const bearerToken = readFileSync(tokenPath, 'utf8').trim();
    if (!bearerToken) {
        console.error('token.txt is empty. Generate it with cookie_converter.js');
        process.exit(1);
    }

    // Test list_tools
    const tools = await callMcp({ type: 'list_tools' }, bearerToken);
    console.log('Tools:', tools);

    // Test search_accounts
    // const query = process.env.LI_SEARCH_NAME || 'Bill Gates';
    // const searchResp = await callMcp({ type: 'call_tool', name: 'search_accounts', params: { query } }, bearerToken);
    // console.log('Search results:', JSON.stringify(searchResp, null, 2));

    // Manual cookie auth probe first
    // const authProbe = await callMcp({ type: 'call_tool', name: 'auth_probe', params: {} }, bearerToken);
    // console.log('Auth probe:', JSON.stringify(authProbe, null, 2));

    // Then get_profile if configured
    const publicIdentifier = process.env.LI_PUBLIC_ID;
    if (!publicIdentifier) {
        console.warn('LI_PUBLIC_ID not set; skipping get_profile test');
        return;
    }
    const profileResp = await callMcp({ type: 'call_tool', name: 'get_profile', params: { publicIdentifier } }, bearerToken);
    console.log('Profile:', JSON.stringify(profileResp, null, 2));
})();


