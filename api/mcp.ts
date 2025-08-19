import handler from '../mcp.js';

export const config = { runtime: 'nodejs' };

export default async function apiHandler(req: any, res: any) {
    return handler(req, res);
}