/**
 * The HTTP server of the OAuth provider (`oauth` option, `--oauth-port`), on node:http or node:https only.
 * Routes: `/` (index), `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`
 * (discovery), `/authorize` (GET and POST, OpenID Connect Core 1.0 section 3.1.2.1), `/authorize/decision` (the
 * consent page form), `/token`, `/revoke`, `/userinfo` and `/jwks`.
 *
 * Bound to a loopback address (the default), it only answers requests for a loopback host name or the host of the
 * `issuer` option, so a web page can not rebind its DNS name to it. The JSON endpoints allow cross-origin requests,
 * like real providers do for browser-based clients; the pages are never framed and run no script.
 */

import http from 'node:http';
import https from 'node:https';
import { consentPage, indexPage, messagePage } from './pages.js';
import type { OAuthProvider, AuthorizeResult, JsonResult, PendingRequest } from './provider.js';
import { isLoopback, readRaw } from '../rest.js';

// a form of a mail client sign-in is small, larger bodies are refused
const BODY_LIMIT = 64 * 1024;

class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

/**
 * Reads an application/x-www-form-urlencoded body
 *
 * @param {Object} req HTTP request
 * @return {Promise<URLSearchParams>} the form
 */
async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
    // RFC 6749 sections 3.2 and 4.1.3: the parameters are form encoded
    if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] || '')) {
        req.resume();
        throw new HttpError(415, 'The body must be application/x-www-form-urlencoded (RFC 6749 section 4.1.3)');
    }
    const body = await readRaw(req, BODY_LIMIT, () => new HttpError(413, 'The body is larger than 64 KiB'));
    return new URLSearchParams(body.toString('utf-8'));
}

const SECURITY_HEADERS = {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
};

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

/**
 * The form-action sources of the consent page. Browsers check form-action on the redirect after the form too,
 * so the origin of the client's redirect URI must be allowed
 *
 * @param {Object} request Pending request
 * @return {String} CSP source list
 */
function formActionSources(request: PendingRequest): string {
    try {
        const url = new URL(request.redirectUri);
        return "'self' " + (url.origin !== 'null' ? url.origin : url.protocol);
    } catch {
        return "'self'";
    }
}

function sendHtml(res: http.ServerResponse, status: number, html: string, formAction = "'none'"): void {
    res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action " + formAction,
        'X-Frame-Options': 'DENY'
    });
    res.end(html);
}

function sendJson(res: http.ServerResponse, result: JsonResult): void {
    if (result.htmlError) {
        // like a provider behind a broken proxy
        sendHtml(res, result.status, '<!doctype html><title>Error</title><h1>Something went wrong</h1>');
        return;
    }
    const json = JSON.stringify(result.body);
    res.writeHead(result.status, {
        ...SECURITY_HEADERS,
        ...CORS_HEADERS,
        ...(result.headers || {}),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json)
    });
    res.end(json);
}

/**
 * Checks the Origin of the consent form: the issuer, or the loopback name the page was opened on. A browser that
 * sends no Origin, or "null" (Referrer-Policy: no-referrer), is let through; the request ID protects the form then
 *
 * @param {String} [origin] Origin header
 * @param {String} issuer Issuer URL
 * @param {String} [host] Host header
 * @return {Boolean} true if the form may come from there
 */
function sameSite(origin: string | undefined, issuer: string, host: string | undefined): boolean {
    if (!origin || origin === 'null' || origin === new URL(issuer).origin) {
        return true;
    }
    try {
        const url = new URL(origin);
        return isLoopback(url.hostname) && url.host === host;
    } catch {
        return false;
    }
}

/**
 * Creates the HTTP server of the provider, it does not listen yet
 *
 * @param {Object} provider OAuth provider
 * @param {Object} options `{ secure, host, credentials }`, credentials are the TLS key and certificate of `secure`
 * @return {Object} HTTP or HTTPS server
 */
function createOAuthServer(
    provider: OAuthProvider,
    options: { secure?: boolean | undefined; host: string; credentials: { key: string | Buffer; cert: string | Buffer } }
): http.Server {
    const answerAuthorize = (res: http.ServerResponse, result: AuthorizeResult, status: number) => {
        if (result.type === 'redirect') {
            res.writeHead(status, { ...SECURITY_HEADERS, Location: result.location, 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Redirecting to ' + result.location + '\n');
        } else if (result.type === 'page') {
            sendHtml(res, result.page.status, messagePage(result.page, provider.issuer));
        } else {
            const html = consentPage({ request: result.request, users: provider.pageUsers(), scopes: provider.scopes, issuer: provider.issuer });
            sendHtml(res, 200, html, formActionSources(result.request));
        }
    };

    const checkHost = (req: http.IncomingMessage) => {
        if (!isLoopback(options.host)) {
            return;
        }
        const host = (req.headers.host || '').replace(/:\d+$/, '');
        let issuerHost = '';
        try {
            issuerHost = new URL(provider.issuer).hostname;
        } catch {
            // no issuer yet
        }
        if (!isLoopback(host) && host.replace(/^\[|\]$/g, '') !== issuerHost.replace(/^\[|\]$/g, '')) {
            // a page that rebinds its DNS name to 127.0.0.1 sends its own host name
            throw new HttpError(421, 'Requests must use a loopback host name or the host of the issuer');
        }
    };

    const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
        checkHost(req);
        const url = new URL(req.url || '/', 'http://localhost');
        const method = (req.method || 'GET').toUpperCase();
        const route = method + ' ' + url.pathname;
        if (method === 'OPTIONS') {
            res.writeHead(204, { ...CORS_HEADERS, 'Access-Control-Max-Age': '600' });
            return res.end();
        }
        switch (route) {
            case 'GET /':
                return sendHtml(
                    res,
                    200,
                    indexPage({
                        issuer: provider.issuer,
                        consent: provider.consent,
                        clients: [...provider.clients.values()],
                        users: provider.pageUsers(),
                        mailScope: provider.mailScope
                    })
                );
            case 'GET /.well-known/openid-configuration':
            case 'GET /.well-known/oauth-authorization-server':
                return sendJson(res, { status: 200, body: provider.metadata() });
            case 'GET /jwks':
                return sendJson(res, { status: 200, body: provider.jwks() });
            case 'GET /authorize':
                return answerAuthorize(res, provider.authorize(url.searchParams), 302);
            case 'POST /authorize':
                // RFC 9700 section 4.12: 303 turns the POST into a GET, never 307
                return answerAuthorize(res, provider.authorize(await readForm(req)), 303);
            case 'POST /authorize/decision': {
                if (!sameSite(req.headers.origin, provider.issuer, req.headers.host)) {
                    throw new HttpError(403, 'The consent form must come from the consent page');
                }
                return answerAuthorize(res, provider.answerConsent(await readForm(req)), 303);
            }
            case 'POST /token':
                return sendJson(res, await provider.token(await readForm(req), req.headers.authorization));
            case 'POST /revoke':
                return sendJson(res, provider.revoke(await readForm(req), req.headers.authorization));
            case 'GET /userinfo':
                return sendJson(res, provider.userinfo(req.headers.authorization));
            case 'POST /userinfo':
                req.resume();
                return sendJson(res, provider.userinfo(req.headers.authorization));
            default: {
                const known = ['/', '/authorize', '/authorize/decision', '/token', '/revoke', '/userinfo', '/jwks'];
                const wellKnown = url.pathname.startsWith('/.well-known/');
                throw new HttpError(known.includes(url.pathname) || wellKnown ? 405 : 404, known.includes(url.pathname) ? 'Method not allowed' : 'Not found');
            }
        }
    };

    const listener = (req: http.IncomingMessage, res: http.ServerResponse) => {
        handle(req, res).catch((err: Error) => {
            const status = err instanceof HttpError ? err.status : 500;
            if (!res.headersSent) {
                // the token and revocation endpoints answer errors in JSON (RFC 6749 section 5.2)
                sendJson(res, { status, body: { error: status === 500 ? 'server_error' : 'invalid_request', error_description: err.message } });
            }
        });
    };

    return options.secure ? https.createServer(options.credentials, listener) : http.createServer(listener);
}

export { createOAuthServer };
