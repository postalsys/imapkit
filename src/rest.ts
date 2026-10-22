/**
 * The REST API: the control API over HTTP, for tests written in any language. Off unless the `rest` option (or
 * `--rest-port`) turns it on. It is full control over the server, including the mail of every user, so it listens
 * on 127.0.0.1 by default, needs a bearer token on any other address, sends no CORS headers, takes JSON bodies
 * only (a browser can not send them cross-origin without a CORS preflight) and, without a token, only answers
 * requests for a loopback host name (DNS rebinding). Built on node:http only.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { ImapKitError, storeError } from './store-operations.js';
import type { IMAPConnection, IMAPServer, Mailbox, Message } from './types.js';
import type { ControlRoute as Route, MessageInfo } from './control.js';
import type { ScriptHandle, ScriptRule } from './script.js';

/** The HTTP server of the REST API, `endStreams()` ends the open event streams */
type RestServer = http.Server & { endStreams?: () => void };

/** Options of the REST API, the `rest` server option */
interface RestOptions {
    port?: number | undefined;
    /** address to listen on, 127.0.0.1 by default. Any other than a loopback address needs a token */
    host?: string | undefined;
    /** bearer token that every request must send in `Authorization: Bearer <token>` */
    token?: string | undefined;
}

// the largest literal a client can send is 64 MiB as well, see IMAPConnection#getMaxLiteralSize
const BODY_LIMIT = 64 * 1024 * 1024;

const STATUS_CODES: Record<string, number> = {
    NONEXISTENT: 404,
    NOTFOUND: 404,
    ALREADYEXISTS: 409,
    INVALID: 400,
    UNAUTHORIZED: 401,
    METHOD: 405,
    TOOBIG: 413,
    UNSUPPORTED: 415
};

/**
 * Checks if a host name or address is a loopback one
 *
 * @param {String} host Host name or address, can be in brackets
 * @return {Boolean} true for localhost, 127.0.0.0/8 and ::1
 */
function isLoopback(host: string): boolean {
    const name = host.replace(/^\[|\]$/g, '').toLowerCase();
    return name === 'localhost' || name === '::1' || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(name);
}

/**
 * Turns a UID path or query value into a number, the control API checks the rest
 *
 * @param {String} value Value from the URL
 * @return {Number} UID, NaN for anything that is not digits
 */
const toUid = (value: string): number => (/^\d+$/.test(value) ? Number(value) : NaN);

/**
 * A message for JSON: the source is base64
 *
 * @param {Object} message Message info of the control API
 * @return {Object} message with `raw` in base64
 */
function messageJson(message: MessageInfo): Record<string, unknown> {
    const { raw, ...rest } = message;
    return raw ? Object.assign(rest, { raw: raw.toString('base64'), encoding: 'base64' }) : rest;
}

/**
 * Decodes binary data of a request body, text unless the encoding is "base64"
 *
 * @param {*} value Value from the body
 * @param {*} encoding "utf-8" (default) or "base64"
 * @return {Buffer|*} data, values that are not strings are left to the control API to refuse
 */
function decodeBody(value: unknown, encoding: unknown): unknown {
    if (encoding !== undefined && encoding !== 'base64' && encoding !== 'utf-8') {
        throw storeError('encoding must be "utf-8" or "base64"', 'INVALID');
    }
    return encoding === 'base64' && typeof value === 'string' ? Buffer.from(value, 'base64') : value;
}

// the server events that GET /v1/events streams by default
const EVENT_TYPES = ['session', 'command', 'mailbox', 'append', 'expunge', 'flags', 'acl', 'script', 'reset'];
// event types that are streamed only when ?types= asks for them, the protocol trace of every session is a lot of data
const OPT_IN_EVENT_TYPES = ['trace'];

const sessionNumber = (origin: IMAPConnection | null | undefined) => (origin ? origin.sessionNumber : null);

/**
 * Turns the arguments of a server event into JSON data: mailboxes become paths, messages UIDs, sessions numbers
 *
 * @param {String} type Event name
 * @param {Array} args Event arguments
 * @return {Object} event data
 */
function eventData(type: string, args: any[]): unknown {
    switch (type) {
        case 'mailbox': {
            const { type: change, path, oldPath, origin } = args[0];
            return { type: change, path, oldPath, origin: sessionNumber(origin) };
        }
        case 'append':
        case 'expunge':
            return { path: (args[0] as Mailbox).path, uids: (args[1] as Message[]).map(message => message.uid), origin: sessionNumber(args[2]) };
        case 'trace': {
            const { session, direction, data } = args[0];
            return { session, direction, data: Buffer.from(data).toString('base64'), encoding: 'base64' };
        }
        case 'flags':
            return {
                path: (args[0] as Mailbox).path,
                messages: (args[1] as Message[]).map(message => ({ uid: message.uid, flags: message.flags.slice() })),
                origin: sessionNumber(args[2])
            };
        case 'acl':
            return { path: (args[0] as Mailbox).path };
        default:
            // session, command and script events are plain data already, reset has none
            return args[0] || {};
    }
}

/**
 * Streams server events as Server-Sent Events, `event: <type>` with the JSON data, until the client goes away
 *
 * @param {Object} server IMAP server
 * @param {Array} types Event types to send
 * @return {Function} writes the stream to a response
 */
function eventStream(server: IMAPServer, types: string[], streams: Set<http.ServerResponse>) {
    return (res: http.ServerResponse, req: http.IncomingMessage) => {
        streams.add(res);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
        res.write(': connected\n\n');
        const listeners = types.map(type => {
            const listener = (...args: unknown[]) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(eventData(type, args)) + '\n\n');
            server.on(type, listener);
            return { type, listener };
        });
        // a comment now and then keeps proxies from closing an idle stream
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        ping.unref();
        req.on('close', () => {
            streams.delete(res);
            clearInterval(ping);
            listeners.forEach(({ type, listener }) => server.removeListener(type, listener));
        });
    };
}

/**
 * Builds the route table of a server
 *
 * @param {Object} server IMAP server
 * @return {Array} routes
 */
function getRoutes(server: IMAPServer, streams: Set<http.ServerResponse> = new Set()): Route[] {
    const control = server.control;
    const ruleJson = (handle: ScriptHandle) => ({ id: handle.id, rule: handle.rule, matched: handle.matched, hits: handle.hits });

    const routes: Route[] = [
        { method: 'GET', path: '/v1/snapshot', summary: 'The storage in the shape of the storage option', handler: () => control.snapshot() },
        {
            method: 'POST',
            path: '/v1/reset',
            summary: 'Restores the mailboxes and users of the server options, disconnects every session',
            handler: () => {
                control.reset();
                return { reset: true };
            }
        },
        {
            method: 'POST',
            path: '/v1/shutdown',
            summary: 'Stops accepting connections, the server closes once the last client is gone ({ graceful: false } closes them)',
            handler: ({ body }) => {
                // the answer goes out first
                setImmediate(() => control.shutdown({ graceful: body.graceful !== false }).catch(() => false));
                return { status: 202, body: { shutdown: true } };
            }
        },
        { method: 'GET', path: '/v1/sessions', summary: 'Connected sessions', handler: () => control.sessions() },
        {
            method: 'GET',
            path: '/v1/events',
            summary:
                'Server events as Server-Sent Events (?types=session,command to choose: ' +
                EVENT_TYPES.concat(OPT_IN_EVENT_TYPES).join(', ') +
                ', trace only when asked for)',
            handler: ({ query }) => {
                const wanted = query.get('types');
                const types = wanted === null ? EVENT_TYPES : wanted.split(',');
                const known = EVENT_TYPES.concat(OPT_IN_EVENT_TYPES);
                const unknown = types.filter(type => known.indexOf(type) < 0);
                if (unknown.length) {
                    throw storeError('Unknown event type ' + unknown.join(', ') + ', expected ' + known.join(', '), 'INVALID');
                }
                return { stream: eventStream(server, types, streams) };
            }
        },
        {
            method: 'DELETE',
            path: '/v1/sessions/{session}',
            summary: 'Disconnects a session with BYE ({ text }) or a TCP reset ({ reset: true })',
            handler: ({ params, body }) => {
                if (!control.disconnect(toUid(params.session), { text: body.text, reset: body.reset })) {
                    throw storeError('Session ' + params.session + ' does not exist', 'NONEXISTENT');
                }
                return { disconnected: true };
            }
        },
        {
            method: 'POST',
            path: '/v1/sessions/{session}/inject',
            summary: 'Writes bytes to a session as they are ({ data, encoding })',
            handler: ({ params, body }) => {
                control.inject(
                    toUid(params.session),
                    body.encoding === 'base64' && typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : body.data
                );
                return { injected: true };
            }
        },
        { method: 'GET', path: '/v1/users', summary: 'Users, without credentials', handler: () => control.listUsers() },
        {
            method: 'POST',
            path: '/v1/users',
            summary: 'Adds a user ({ name, password, xoauth2 })',
            handler: ({ body }) => {
                control.addUser(body.name, { password: body.password, xoauth2: body.xoauth2 });
                return { status: 201, body: { name: body.name } };
            }
        },
        {
            method: 'PUT',
            path: '/v1/users/{name}',
            summary: 'Changes the password or the XOAUTH2 token of a user',
            handler: ({ params, body }) => {
                control.updateUser(params.name, { password: body.password, xoauth2: body.xoauth2 });
                return { name: params.name };
            }
        },
        {
            method: 'DELETE',
            path: '/v1/users/{name}',
            summary: 'Deletes a user and disconnects its sessions ({ disconnect: false } keeps them)',
            handler: ({ params, body }) => {
                control.deleteUser(params.name, { disconnect: body.disconnect });
                return { deleted: true };
            }
        },
        { method: 'GET', path: '/v1/mailboxes', summary: 'Every mailbox', handler: () => control.listMailboxes() },
        {
            method: 'POST',
            path: '/v1/mailboxes',
            summary: 'Creates a mailbox ({ path, subscribed })',
            handler: ({ body }) => ({ status: 201, body: control.createMailbox(body.path, { subscribed: body.subscribed }) })
        },
        { method: 'GET', path: '/v1/mailboxes/{path}', summary: 'A mailbox', handler: ({ params }) => control.getMailbox(params.path) },
        {
            method: 'DELETE',
            path: '/v1/mailboxes/{path}',
            summary: 'Deletes a mailbox, sessions that have it selected get BYE',
            handler: ({ params }) => {
                control.deleteMailbox(params.path);
                return { deleted: true };
            }
        },
        {
            method: 'POST',
            path: '/v1/mailboxes/{path}/rename',
            summary: 'Renames a mailbox ({ newPath })',
            handler: ({ params, body }) => control.renameMailbox(params.path, body.newPath)
        },
        {
            method: 'PUT',
            path: '/v1/mailboxes/{path}/subscription',
            summary: 'Subscribes a mailbox',
            handler: ({ params }) => ({ changed: control.subscribe(params.path) })
        },
        {
            method: 'DELETE',
            path: '/v1/mailboxes/{path}/subscription',
            summary: 'Unsubscribes a name',
            handler: ({ params }) => ({ changed: control.unsubscribe(params.path) })
        },
        {
            method: 'POST',
            path: '/v1/mailboxes/{path}/uidvalidity',
            summary: 'Gives the mailbox a new UIDVALIDITY ({ uidvalidity, uids, offset, seed })',
            handler: ({ params, body }) => control.resetUidValidity(params.path, body)
        },
        {
            method: 'GET',
            path: '/v1/mailboxes/{path}/messages',
            summary: 'Messages (?uids=1,2 to choose, ?raw=true for the base64 source)',
            handler: ({ params, query }) => {
                const uids = query.get('uids');
                return control
                    .listMessages(params.path, { uids: uids === null ? undefined : uids.split(',').map(toUid), raw: query.get('raw') === 'true' })
                    .map(messageJson);
            }
        },
        {
            method: 'POST',
            path: '/v1/mailboxes/{path}/messages',
            summary: 'Adds a message ({ raw, encoding, flags, internaldate, checks }), like a delivery, checks: true refuses it like APPEND would (quota)',
            handler: ({ params, body }) => ({
                status: 201,
                body: control.addMessage(
                    params.path,
                    {
                        raw: decodeBody(body.raw, body.encoding) as string,
                        flags: body.flags,
                        internaldate: body.internaldate
                    },
                    { checks: body.checks }
                )
            })
        },
        {
            method: 'POST',
            path: '/v1/mailboxes/{path}/messages/flags',
            summary: 'Changes flags ({ uids, flags, mode }), mode is set, add or remove',
            handler: ({ params, body }) => control.setFlags(params.path, body.uids, body.flags, body.mode || 'set')
        },
        {
            method: 'POST',
            path: '/v1/mailboxes/{path}/messages/expunge',
            summary: 'Removes messages ({ uids })',
            handler: ({ params, body }) => ({ uids: control.expungeMessages(params.path, body.uids) })
        },
        {
            method: 'POST',
            path: '/v1/mailboxes/{path}/messages/copy',
            summary: 'Copies messages ({ uids, target })',
            handler: ({ params, body }) => control.copyMessages(params.path, body.uids, body.target)
        },
        {
            method: 'POST',
            path: '/v1/mailboxes/{path}/messages/move',
            summary: 'Moves messages ({ uids, target })',
            handler: ({ params, body }) => control.moveMessages(params.path, body.uids, body.target)
        },
        {
            method: 'GET',
            path: '/v1/mailboxes/{path}/messages/{uid}',
            summary: 'A message with its base64 source',
            handler: ({ params }) => messageJson(control.getMessage(params.path, toUid(params.uid)))
        },
        {
            method: 'DELETE',
            path: '/v1/mailboxes/{path}/messages/{uid}',
            summary: 'Removes a message',
            handler: ({ params }) => ({ uids: control.expungeMessages(params.path, [toUid(params.uid)]) })
        },
        { method: 'GET', path: '/v1/script/rules', summary: 'Script rules with their hit counts', handler: () => server.script.rules.map(ruleJson) },
        {
            method: 'POST',
            path: '/v1/script/rules',
            summary: 'Adds a script rule or a list of them, in the JSON form of the --script file',
            handler: ({ body }) => {
                let handles: ScriptHandle | ScriptHandle[];
                try {
                    handles = server.script.add(body as ScriptRule | ScriptRule[]);
                } catch (err) {
                    throw storeError((err as Error).message, 'INVALID');
                }
                return { status: 201, body: Array.isArray(handles) ? handles.map(ruleJson) : ruleJson(handles) };
            }
        },
        {
            method: 'DELETE',
            path: '/v1/script/rules',
            summary: 'Removes every script rule',
            handler: () => {
                server.script.clear();
                return { deleted: true };
            }
        },
        {
            method: 'DELETE',
            path: '/v1/script/rules/{id}',
            summary: 'Removes a script rule',
            handler: ({ params }) => {
                const handle = server.script.rules.find(rule => String(rule.id) === params.id);
                if (!handle) {
                    throw storeError('Script rule ' + params.id + ' does not exist', 'NONEXISTENT');
                }
                handle.remove();
                return { deleted: true };
            }
        }
    ];
    // the operations of plugins (ACL, METADATA, QUOTA)
    routes.push(...control.routes);
    routes.push({ method: 'GET', path: '/v1/openapi.json', summary: 'This API as an OpenAPI document', handler: () => openApi(routes) });
    return routes;
}

/**
 * Describes the routes as an OpenAPI 3.1 document
 *
 * @param {Array} routes Route table
 * @return {Object} OpenAPI document
 */
function openApi(routes: Route[]): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    routes.forEach(route => {
        const parameters = (route.path.match(/\{(\w+)\}/g) || []).map(param => ({
            name: param.slice(1, -1),
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: param === '{path}' ? 'Storage name of the mailbox (modified UTF-7), URL encoded, a "/" in it as %2F' : undefined
        }));
        paths[route.path] = paths[route.path] || {};
        paths[route.path][route.method.toLowerCase()] = {
            summary: route.summary,
            parameters,
            responses: { default: { description: 'JSON, errors as { error: { code, message } }' } }
        };
    });
    return {
        openapi: '3.1.0',
        info: { title: 'ImapKit REST API', version: '1' },
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
        paths
    };
}

/**
 * Finds the route of a request
 *
 * @param {Array} routes Route table
 * @param {String} method HTTP method
 * @param {String} pathname URL path, still URL encoded
 * @return {Object} `{ route, params }`, route is null if the path is known with other methods only
 */
function matchRoute(routes: Route[], method: string, pathname: string): { route: Route | null; params: Record<string, string> } {
    const segments = pathname.split('/');
    let pathKnown = false;
    for (const route of routes) {
        const pattern = route.path.split('/');
        if (pattern.length !== segments.length) {
            continue;
        }
        const params: Record<string, string> = {};
        let matched = true;
        for (let i = 0; i < pattern.length && matched; i++) {
            if (pattern[i].startsWith('{')) {
                try {
                    params[pattern[i].slice(1, -1)] = decodeURIComponent(segments[i]);
                } catch {
                    throw storeError('Invalid URL encoding', 'INVALID');
                }
                matched = segments[i] !== '';
            } else {
                matched = pattern[i] === segments[i];
            }
        }
        if (matched) {
            if (route.method === method) {
                return { route, params };
            }
            pathKnown = true;
        }
    }
    if (pathKnown) {
        throw storeError('Method ' + method + ' is not allowed here', 'METHOD');
    }
    throw storeError('No such endpoint', 'NOTFOUND');
}

/**
 * Compares a bearer token in constant time
 *
 * @param {String} header Authorization header
 * @param {String} token Expected token
 * @return {Boolean} true if the header carries the token
 */
function hasToken(header: string | undefined, token: string): boolean {
    const match = /^Bearer (.+)$/i.exec(header || '');
    if (!match) {
        return false;
    }
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(digest(match[1]), digest(token));
}

/**
 * Reads a JSON request body
 *
 * @param {Object} req HTTP request
 * @return {Promise<Object>} the body, an empty object without one
 */
function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > BODY_LIMIT) {
                reject(storeError('Request body is larger than 64 MiB', 'TOOBIG'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('error', reject);
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (!text) {
                return resolve({});
            }
            let body: unknown;
            try {
                body = JSON.parse(text);
            } catch {
                return reject(storeError('Request body is not valid JSON', 'INVALID'));
            }
            if (!body || typeof body !== 'object') {
                return reject(storeError('Request body must be a JSON object or array', 'INVALID'));
            }
            resolve(body);
        });
    });
}

/**
 * Creates the HTTP server of the REST API, it does not listen yet
 *
 * @param {Object} server IMAP server
 * @param {Object} options `{ host, token }`
 * @return {Object} HTTP server
 * @throws {Error} for a host that is not a loopback address without a token
 */
function createRestServer(server: IMAPServer, options: RestOptions): RestServer {
    const host = options.host || '127.0.0.1';
    const token = options.token;
    if (token !== undefined && (typeof token !== 'string' || !token)) {
        throw new Error('The REST API token must be a non-empty string');
    }
    if (!token && !isLoopback(host)) {
        throw new Error('The REST API controls the whole server, it needs a token (rest.token, --rest-token) to listen on ' + host);
    }
    // open event streams, a shutdown ends them so that the server can close
    const streams = new Set<http.ServerResponse>();
    const routes = getRoutes(server, streams);

    const send = (res: http.ServerResponse, status: number, body: unknown) => {
        const json = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), 'Cache-Control': 'no-store' });
        res.end(json);
    };

    const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
        if (token) {
            if (!hasToken(req.headers.authorization, token)) {
                res.setHeader('WWW-Authenticate', 'Bearer');
                throw storeError('Missing or wrong bearer token', 'UNAUTHORIZED');
            }
        } else if (!isLoopback((req.headers.host || '').replace(/:\d+$/, ''))) {
            // a page that rebinds its DNS name to 127.0.0.1 sends its own host name
            throw storeError('Requests must use a loopback host name', 'UNAUTHORIZED');
        }
        const url = new URL(req.url || '/', 'http://localhost');
        const method = (req.method || 'GET').toUpperCase();
        const { route, params } = matchRoute(routes, method, url.pathname);
        let body: any = {};
        if (method !== 'GET') {
            const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
            // a browser page can POST a form or text/plain cross-origin without asking. A JSON request, and every PUT and
            // DELETE, needs a CORS preflight, which this server never allows
            if (!/^application\/json\b/i.test(req.headers['content-type'] || '') && (hasBody || method === 'POST')) {
                throw storeError('Requests must be application/json', 'UNSUPPORTED');
            }
            body = await readBody(req);
        }
        const result = (route as Route).handler({ params, query: url.searchParams, body });
        if (result && typeof result === 'object' && typeof (result as { stream?: unknown }).stream === 'function') {
            return (result as { stream: (res: http.ServerResponse, req: http.IncomingMessage) => void }).stream(res, req);
        }
        if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
            const { status, body: responseBody } = result as { status: number; body: unknown };
            return send(res, status, responseBody);
        }
        send(res, 200, result === undefined ? {} : result);
    };

    const rest: RestServer = http.createServer((req, res) => {
        handle(req, res).catch((err: Error & { code?: string }) => {
            const code = err instanceof ImapKitError ? err.code : 'SERVERERROR';
            // RFC 5530 codes of failed mailbox operations (CANNOT, HASCHILDREN ...) are conflicts with the state
            const status = STATUS_CODES[code] || (err instanceof ImapKitError ? 409 : 500);
            if (!res.headersSent) {
                send(res, status, { error: { code, message: err.message } });
            }
        });
    });
    rest.endStreams = () => streams.forEach(res => res.end());
    return rest;
}

export { createRestServer, isLoopback, getRoutes, openApi };
export type { RestOptions, RestServer };
