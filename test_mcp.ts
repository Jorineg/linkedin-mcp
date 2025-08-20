import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import { readFileSync } from 'fs';

dotenv.config();

// FastMCP http_app() mounts the MCP endpoint at /mcp/ by default
const SERVER_URL = process.env.MCP_URL || 'http://localhost:3000/mcp';
console.log('SERVER_URL:', SERVER_URL);

const PROTOCOL_VERSION = '2025-06-18';

function postJson(body: any, headers: Record<string, string>, expectedId: string | number): Promise<{ body: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const url = new URL(SERVER_URL);
        const isHttps = url.protocol === 'https:';
        const req = (isHttps ? https : http).request({
            method: 'POST',
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            headers,
        }, (res) => {
            const contentType = String(res.headers['content-type'] || '');
            if (contentType.includes('text/event-stream')) {
                // Parse SSE stream; resolve when we receive a JSON-RPC response with matching id
                let buffer = '';
                const finish = (obj: any) => {
                    res.removeAllListeners('data');
                    res.removeAllListeners('end');
                    resolve({ body: obj, headers: res.headers });
                };
                const tryProcess = () => {
                    const parts = buffer.split(/\r?\n\r?\n/);
                    // Keep last partial in buffer
                    buffer = parts.pop() || '';
                    for (const part of parts) {
                        // SSE event: lines like "event: message", "data: ..."
                        const lines = part.split(/\r?\n/);
                        let dataLines: string[] = [];
                        for (const line of lines) {
                            if (line.startsWith('data:')) {
                                dataLines.push(line.slice(5).trimStart());
                            }
                        }
                        if (dataLines.length > 0) {
                            const dataStr = dataLines.join('\n');
                            try {
                                const obj = JSON.parse(dataStr);
                                if (obj && obj.jsonrpc === '2.0' && obj.id === expectedId) {
                                    finish(obj);
                                    return;
                                }
                            } catch {
                                // ignore non-JSON data frames
                            }
                        }
                    }
                };
                res.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                    tryProcess();
                });
                res.on('end', () => {
                    // If stream ended without matching response, try final parse
                    tryProcess();
                    // Fall back: resolve with last chunk if nothing matched
                    resolve({ body: buffer, headers: res.headers });
                });
            } else {
                const chunks: Buffer[] = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let parsed: any = raw;
                    try { parsed = JSON.parse(raw); } catch { /* leave as string */ }
                    resolve({ body: parsed, headers: res.headers });
                });
            }
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}

async function initialize(): Promise<string | null> {
    const initRequest = {
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'linkedin-mcp-test', version: '0.1.0' },
        },
    };
    const { headers } = await postJson(initRequest, {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
    }, initRequest.id);
    const sessionId = (headers['mcp-session-id'] as string) || null;
    return sessionId;
}

async function sendInitialized(sessionId: string | null): Promise<void> {
    const initializedNotification = {
        jsonrpc: '2.0',
        method: 'initialized',
        params: {},
    };
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    try {
        await postJson(initializedNotification, headers, '');
    } catch {
        // ignore; servers may return 202 with no body
    }
}

function callMcp(body: any, linkedinSessionB64: string, sessionId: string | null): Promise<any> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        // Custom header carrying base64(JSON) session cookies
        'linkedin_session': linkedinSessionB64,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    return postJson(body, headers, body.id).then(({ body }) => body);
}

(async () => {
    const tokenPath = process.env.TOKEN_PATH || 'token.txt';
    const sessionB64 = readFileSync(tokenPath, 'utf8').trim();
    if (!sessionB64) {
        console.error('token.txt is empty. Generate it with cookie_converter.js (should output base64 JSON cookies).');
        process.exit(1);
    }

    // Initialize MCP session per Streamable HTTP spec to obtain session ID
    const sessionId = await initialize();
    await sendInitialized(sessionId);
    // Avoid race: give server a brief moment to finalize initialization
    await new Promise((r) => setTimeout(r, 200));

    // Test list_tools (no params per spec)
    const tools = await callMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, sessionB64, sessionId);
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
    const profileResp = await callMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_profile', arguments: { publicIdentifier } } }, sessionB64, sessionId);
    console.log('Profile:', JSON.stringify(profileResp, null, 2));
})();


