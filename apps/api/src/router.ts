import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.ts";
import { securityHeaders } from "./security.ts";

export type Handler = (
  req: IncomingMessage & { params: Record<string, string>; body: unknown },
  res: ServerResponse,
  ctx: RouteContext
) => Promise<void>;

export interface RouteContext {
  traceId: string;
  url: URL;
  params: Record<string, string>;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

const routes: Route[] = [];

function compile(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = path
    .replace(/:[a-zA-Z_][a-zA-Z0-9_]*/g, (m) => {
      paramNames.push(m.slice(1));
      return "([^/]+)";
    })
    .replace(/\//g, "\\/");
  return { pattern: new RegExp(`^${regexStr}$`), paramNames };
}

export function route(method: string, path: string, handler: Handler): void {
  const { pattern, paramNames } = compile(path);
  routes.push({ method: method.toUpperCase(), pattern, paramNames, handler });
}

export function get(path: string, handler: Handler) { route("GET", path, handler); }
export function post(path: string, handler: Handler) { route("POST", path, handler); }
export function put(path: string, handler: Handler) { route("PUT", path, handler); }
export function patch(path: string, handler: Handler) { route("PATCH", path, handler); }
export function del(path: string, handler: Handler) { route("DELETE", path, handler); }

export function dispatch(
  method: string,
  pathname: string
): { handler: Handler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
    return { handler: route.handler, params };
  }
  return null;
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...securityHeaders(),
    ...headers
  });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw new Error("request_too_large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { return {}; }
}
