/**
 * The OAuth 2.0 / OpenID Connect provider of the `oauth` option (README "OAuth 2.0 and OpenID Connect"): the
 * authorization code flow with PKCE for mail clients, with tokens that IMAP (XOAUTH2, OAUTHBEARER) and SMTP (AUTH
 * XOAUTH2) accept. No passwords: a consent policy decides every sign-in, from the first rung that has one: a queued
 * decision, the user (picked by `login_hint`), the client, the server default. `prompt` shows the consent page,
 * where the tester picks an account and clicks Allow or Deny. Strict like the IMAP side: a request that breaks a
 * MUST of the RFCs is refused and the error description names the rule.
 *
 * This file holds the protocol logic and the state, src/oauth/http.ts the HTTP server and src/oauth/pages.ts the
 * pages. Times come from `server.now()`, so tests with a fixed clock can let tokens expire.
 */

import crypto from 'node:crypto';
import { ImapKitError } from '../store-operations.js';
import { isLoopback, safeEqual } from '../rest.js';
import { checkOutcome, describeOutcome, errorText, isErrorCode } from './policy.js';
import { defaultSigningKey, loadSigningKey, signJwt } from './jwt.js';
import type { ConsentPolicy, Outcome } from './policy.js';
import type { SigningKey } from './jwt.js';
import type { ControlRoute } from '../control.js';
import type { IMAPServer } from '../types.js';

/** A client of the `oauth.clients` option */
export interface OAuthClientOptions {
    /** the name the consent page shows, the client ID if not set */
    name?: string | undefined;
    /** a confidential client authenticates with this secret, a client without one is public and must use PKCE */
    secret?: string | undefined;
    /** registered redirect URIs. A loopback http URI matches any port (RFC 8252 section 7.3), a trailing `*` any rest */
    redirectUris?: string[] | undefined;
    /** the consent policy of the client, the server default if not set */
    consent?: ConsentPolicy | undefined;
}

/** The `oauth` option */
export interface OAuthOptions {
    port?: number | undefined;
    /** address to listen on, 127.0.0.1 by default */
    host?: string | undefined;
    /** HTTPS with the `credentials` or the bundled localhost certificate */
    secure?: boolean | undefined;
    /** the public base URL, when clients reach the provider through another address (a tunnel, a proxy) */
    issuer?: string | undefined;
    /** the default consent policy, `prompt` if not set */
    consent?: ConsentPolicy | undefined;
    /** registered clients by client ID, `imapkit`, `imapkit-approve` and `imapkit-deny` if not set */
    clients?: Record<string, OAuthClientOptions> | undefined;
    /** more scopes, name to the description the consent page shows */
    scopes?: Record<string, string> | undefined;
    /** the scope that IMAP and SMTP logins need, `mail` by default */
    mailScope?: string | undefined;
    /** `refuse` (default) answers a request for an unknown scope with invalid_scope, `drop` grants the others */
    unknownScopes?: 'refuse' | 'drop' | undefined;
    /** `offline_access` (default) issues refresh tokens only for that scope, `always` for every code exchange */
    refreshTokens?: 'offline_access' | 'always' | undefined;
    /** a new refresh token on every refresh, reuse of an old one revokes the grant */
    rotateRefreshTokens?: boolean | undefined;
    /** access token lifetime in seconds, 3600 by default */
    accessTokenTtl?: number | undefined;
    /** authorization code lifetime in seconds, 60 by default, at most 600 (RFC 6749 section 4.1.2) */
    codeTtl?: number | undefined;
    /** accepts the `plain` PKCE method, which RFC 7636 section 4.2 only allows for clients that can not do S256 */
    allowPlainPkce?: boolean | undefined;
    /** RSA private key in PEM for the ID tokens, a new key on every start if not set */
    signingKey?: string | Buffer | undefined;
}

/** A registered client */
export interface OAuthClient {
    id: string;
    name: string;
    secret: string | null;
    redirectUris: string[];
    consent: ConsentPolicy | null;
}

/** One line of the request checklist on the consent page */
export interface Check {
    level: 'ok' | 'note' | 'warn';
    text: string;
}

/** A checked authorization request */
export interface AuthRequest {
    client: OAuthClient;
    redirectUri: string;
    /** false when the request left redirect_uri out and the only registered URI was used */
    redirectUriSent: boolean;
    state: string | undefined;
    scope: string[];
    codeChallenge: string | undefined;
    codeChallengeMethod: string | undefined;
    nonce: string | undefined;
    loginHint: string | undefined;
    /** the user that login_hint names, null when it names nobody */
    hintUser: string | null | undefined;
    prompt: string[];
    checks: Check[];
    /** other parameters the request sent, they are ignored */
    ignored: string[];
}

/** A request waiting on the consent page */
export interface PendingRequest extends AuthRequest {
    id: string;
    expiresAt: number;
    source: string;
}

/** A page to show instead of a redirect */
export interface PageData {
    status: number;
    title: string;
    message: string;
    details?: string[] | undefined;
    tone: 'error' | 'info';
}

/** What the authorization endpoint answers */
export type AuthorizeResult = { type: 'redirect'; location: string } | { type: 'page'; page: PageData } | { type: 'consent'; request: PendingRequest };

/** A JSON answer of the token, revocation or userinfo endpoint */
export interface JsonResult {
    status: number;
    body: unknown;
    headers?: Record<string, string> | undefined;
    /** answer with an HTML error page instead of JSON, the html token fault */
    htmlError?: boolean | undefined;
}

/** A queued decision, see queueOAuthDecision() */
export interface QueuedDecision {
    id: number;
    decision: Outcome;
    client: string | undefined;
    user: string | undefined;
    remaining: number;
}

/** A queued fault of the token endpoint, see queueOAuthTokenFault() */
export interface TokenFault {
    id: number;
    grant: 'authorization_code' | 'refresh_token' | undefined;
    error: string | undefined;
    description: string | undefined;
    status: number | undefined;
    html: boolean;
    delay: number;
    /** claims to change in the ID token, null removes one */
    claims: Record<string, unknown> | undefined;
    remaining: number;
}

interface CodeRecord {
    clientId: string;
    user: string;
    redirectUri: string;
    redirectUriSent: boolean;
    scope: string[];
    challenge: string | undefined;
    method: string | undefined;
    nonce: string | undefined;
    expiresAt: number;
    authTime: number;
    grantId: string;
    used: boolean;
}

interface TokenRecord {
    token: string;
    type: 'access' | 'refresh';
    clientId: string;
    user: string;
    scope: string[];
    grantId: string;
    /** null for refresh tokens, which do not expire */
    expiresAt: number | null;
    revoked: boolean;
    /** a refresh token that rotation replaced */
    rotated: boolean;
    /** when the token was revoked or replaced, prune() forgets it a day later */
    endedAt: number | null;
}

/** What `server.checkAccessToken()` gets from the provider */
export type TokenCheck = { user: string } | { error: 'invalid_token' | 'insufficient_scope'; reason: string };

const LOOPBACK_REDIRECTS = ['http://127.0.0.1/*', 'http://localhost/*', 'http://[::1]/*'];

const DEFAULT_CLIENTS: Record<string, OAuthClientOptions> = {
    imapkit: { name: 'ImapKit test client', redirectUris: LOOPBACK_REDIRECTS },
    'imapkit-approve': { name: 'ImapKit test client (always allows)', redirectUris: LOOPBACK_REDIRECTS, consent: 'approve' },
    'imapkit-deny': { name: 'ImapKit test client (always denies)', redirectUris: LOOPBACK_REDIRECTS, consent: 'deny' }
};

// OpenID Connect Core 1.0 section 5.4 and 11, the consent page shows these descriptions
const STANDARD_SCOPES: Record<string, string> = {
    openid: 'Confirm who you are (OpenID Connect ID token)',
    email: 'See your email address',
    profile: 'See your name',
    offline_access: 'Stay signed in (a refresh token)'
};

const PROMPT_VALUES = ['none', 'login', 'consent', 'select_account'];

// RFC 6749 section 3.3: scope-token = 1*( %x21 / %x23-5B / %x5D-7E )
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
// RFC 7636 section 4.1: code-verifier = 43*128unreserved, the S256 challenge is 43 base64url characters
const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;

// parameters of an authorization request that the provider reads, the rest are listed as ignored on the consent page
const KNOWN_PARAMS = new Set([
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'code_challenge',
    'code_challenge_method',
    'nonce',
    'login_hint',
    'prompt',
    'response_mode',
    'request',
    'request_uri'
]);

const PENDING_TTL = 600 * 1000;
// how long an expired or revoked token is still known as such
const TOKEN_MEMORY = 24 * 3600 * 1000;

const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');

/**
 * Reads the parameters of a request. RFC 6749 section 3.1: a parameter without a value counts as omitted, and
 * one that is sent more than once is an error
 *
 * @param {URLSearchParams} input Query or form parameters
 * @return {Object} `{ values, duplicates }`
 */
function readParams(input: URLSearchParams): { values: Record<string, string>; duplicates: string[] } {
    const values: Record<string, string> = Object.create(null);
    const duplicates = new Set<string>();
    for (const [key, value] of input) {
        if (value === '') {
            continue;
        }
        if (key in values) {
            duplicates.add(key);
        }
        values[key] = value;
    }
    return { values, duplicates: [...duplicates] };
}

/**
 * Checks a registered redirect URI against the one a request sent
 *
 * @param {String} registered Registered URI, a trailing `*` matches any rest
 * @param {String} given URI of the request
 * @return {Boolean} true if they match
 */
function redirectMatches(registered: string, given: string): boolean {
    const wildcard = registered.endsWith('*');
    const base = wildcard ? registered.slice(0, -1) : registered;
    const same = (a: string, b: string) => (wildcard ? a.startsWith(b) : a === b);
    let baseUrl: URL;
    let givenUrl: URL;
    try {
        baseUrl = new URL(base);
        givenUrl = new URL(given);
    } catch {
        return false;
    }
    // RFC 8252 section 7.3: a loopback IP redirect URI matches with any port, the client picks it when it runs
    if (baseUrl.protocol === 'http:' && isLoopback(baseUrl.hostname) && !baseUrl.port) {
        return (
            givenUrl.protocol === 'http:' &&
            givenUrl.hostname === baseUrl.hostname &&
            same(givenUrl.pathname + givenUrl.search, baseUrl.pathname + baseUrl.search)
        );
    }
    // RFC 6749 section 3.1.2.3: otherwise a simple string comparison
    return same(given, base);
}

/**
 * Checks the clients of the options
 *
 * @param {Object} clients Client ID to options
 * @return {Map} client ID to client
 */
function loadClients(clients: Record<string, OAuthClientOptions>): Map<string, OAuthClient> {
    const result = new Map<string, OAuthClient>();
    for (const id of Object.keys(clients)) {
        result.set(id, makeClient(id, clients[id]));
    }
    return result;
}

/**
 * Checks the options of a client
 *
 * @param {String} id Client ID
 * @param {Object} options Client options
 * @return {Object} client
 * @throws {ImapKitError} INVALID for bad options
 */
function makeClient(id: unknown, options: OAuthClientOptions): OAuthClient {
    // RFC 6749 appendix A.1: client-id = *VSCHAR
    if (typeof id !== 'string' || !/^[\x20-\x7e]+$/.test(id)) {
        throw new ImapKitError('OAuth client ID must be a non-empty string of printable ASCII', 'INVALID');
    }
    const what = 'OAuth client ' + JSON.stringify(id);
    if (!options || typeof options !== 'object') {
        throw new ImapKitError(what + ' must be an object', 'INVALID');
    }
    const { name, secret, redirectUris, consent } = options;
    if (name !== undefined && (typeof name !== 'string' || !name)) {
        throw new ImapKitError(what + ': name must be a non-empty string', 'INVALID');
    }
    if (secret !== undefined && (typeof secret !== 'string' || !/^[\x20-\x7e]+$/.test(secret))) {
        throw new ImapKitError(what + ': secret must be a non-empty string of printable ASCII', 'INVALID');
    }
    const uris = redirectUris === undefined ? LOOPBACK_REDIRECTS : redirectUris;
    if (!Array.isArray(uris) || !uris.length) {
        throw new ImapKitError(what + ': redirectUris must be a non-empty list', 'INVALID');
    }
    for (const uri of uris) {
        const base = typeof uri === 'string' ? uri.replace(/\*$/, '') : '';
        let valid = !!base && !base.includes('#');
        try {
            new URL(base);
        } catch {
            valid = false;
        }
        if (!valid) {
            // RFC 6749 section 3.1.2: an absolute URI without a fragment
            throw new ImapKitError(what + ': redirect URI ' + JSON.stringify(uri) + ' must be an absolute URI without a fragment', 'INVALID');
        }
    }
    return {
        id,
        name: name || id,
        secret: secret === undefined ? null : secret,
        redirectUris: uris.slice(),
        consent: consent === undefined || consent === null ? null : (checkOutcome(consent, what + ': consent') as ConsentPolicy)
    };
}

/**
 * Reads a positive number option
 *
 * @param {*} value Option value
 * @param {Number} fallback Default
 * @param {String} what Option name
 * @param {Number} [max] Largest allowed value
 * @return {Number} value
 */
function positiveNumber(value: unknown, fallback: number, what: string, max = Infinity): number {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== 'number' || !(value > 0) || value > max) {
        throw new Error(what + ' must be a positive number' + (max < Infinity ? ' of at most ' + max : ''));
    }
    return value;
}

class OAuthProvider {
    server: IMAPServer;
    options: OAuthOptions;
    /** the base URL of the endpoints, set when the HTTP server listens (see listening()) */
    issuer: string;
    clients!: Map<string, OAuthClient>;
    consent!: ConsentPolicy;
    decisions!: QueuedDecision[];
    tokenFaults!: TokenFault[];
    pending!: Map<string, PendingRequest>;
    codes!: Map<string, CodeRecord>;
    tokens!: Map<string, TokenRecord>;
    scopes: Record<string, string>;
    mailScope: string;
    accessTokenTtl: number;
    codeTtl: number;
    queueCounter: number;
    key: SigningKey | null;

    constructor(server: IMAPServer, options: OAuthOptions) {
        this.server = server;
        this.options = options && typeof options === 'object' ? options : {};
        this.issuer = this.options.issuer ? this.checkIssuer(this.options.issuer) : '';
        this.mailScope = this.options.mailScope === undefined ? 'mail' : this.options.mailScope;
        if (typeof this.mailScope !== 'string' || !SCOPE_TOKEN.test(this.mailScope)) {
            throw new Error('oauth.mailScope must be a scope token (RFC 6749 section 3.3)');
        }
        this.scopes = Object.assign({}, STANDARD_SCOPES, { [this.mailScope]: 'Read, send and manage your mail over IMAP and SMTP' });
        for (const [name, description] of Object.entries(this.options.scopes || {})) {
            if (!SCOPE_TOKEN.test(name) || typeof description !== 'string') {
                throw new Error('oauth.scopes maps scope tokens (RFC 6749 section 3.3) to descriptions, ' + JSON.stringify(name) + ' is not one');
            }
            this.scopes[name] = description;
        }
        this.accessTokenTtl = positiveNumber(this.options.accessTokenTtl, 3600, 'oauth.accessTokenTtl');
        this.codeTtl = positiveNumber(this.options.codeTtl, 60, 'oauth.codeTtl', 600);
        const { unknownScopes, refreshTokens } = this.options;
        if (unknownScopes !== undefined && unknownScopes !== 'refuse' && unknownScopes !== 'drop') {
            throw new Error('oauth.unknownScopes must be "refuse" or "drop"');
        }
        if (refreshTokens !== undefined && refreshTokens !== 'offline_access' && refreshTokens !== 'always') {
            throw new Error('oauth.refreshTokens must be "offline_access" or "always"');
        }
        this.queueCounter = 0;
        // without the option, every provider shares one key, see defaultSigningKey()
        this.key = this.options.signingKey ? loadSigningKey(this.options.signingKey) : null;
        this.reset();
        server.on('reset', () => this.reset());
        this.registerControl();
    }

    /**
     * Checks an issuer URL of the options: http or https, no query or fragment (RFC 8414 section 2)
     *
     * @param {String} issuer URL
     * @return {String} the URL without a trailing slash
     */
    checkIssuer(issuer: unknown): string {
        let url: URL | null = null;
        try {
            url = new URL(String(issuer));
        } catch {
            // not a URL
        }
        if (!url || !/^https?:$/.test(url.protocol) || url.search || url.hash || typeof issuer !== 'string') {
            throw new Error('oauth.issuer must be an http or https URL without a query or fragment');
        }
        return issuer.replace(/\/+$/, '');
    }

    /** Restores the clients and the default policy of the options and forgets every token, request and queue */
    reset(): void {
        this.clients = loadClients(this.options.clients || DEFAULT_CLIENTS);
        this.consent = this.options.consent === undefined ? 'prompt' : (checkOutcome(this.options.consent, 'oauth.consent') as ConsentPolicy);
        this.decisions = [];
        this.tokenFaults = [];
        this.pending = new Map();
        this.codes = new Map();
        this.tokens = new Map();
    }

    /** Milliseconds since the epoch, from the `now` option */
    nowMs(): number {
        return this.server.now().getTime();
    }

    /**
     * Sets the issuer from the address the HTTP server listens on, unless the `issuer` option gave one
     *
     * @param {String} host Address
     * @param {Number} port Port
     */
    listening(host: string, port: number): void {
        if (!this.options.issuer) {
            // a wildcard address is reached on the loopback address, the bundled certificate covers 127.0.0.1 too
            const name = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? '[' + host + ']' : host;
            this.issuer = (this.options.secure ? 'https' : 'http') + '://' + name + ':' + port;
        }
    }

    /** The URL of the discovery document */
    discoveryUrl(): string {
        return this.issuer + '/.well-known/openid-configuration';
    }

    /** The users as the consent and index pages show them, the default user first */
    pageUsers(): { name: string; displayName: string | undefined; consent: ConsentPolicy | undefined }[] {
        return this.userNames().map(name => {
            const data = this.server.getUser(name) || {};
            return { name, displayName: data.displayName || undefined, consent: data.oauth && data.oauth.consent };
        });
    }

    /**
     * Marks a token as revoked or replaced by rotation
     *
     * @param {Object} record Token
     * @param {String} how "revoked" or "rotated"
     */
    endToken(record: TokenRecord, how: 'revoked' | 'rotated'): void {
        record[how] = true;
        record.endedAt = record.endedAt === null ? this.nowMs() : record.endedAt;
    }

    /**
     * Emits an `oauth` event, `{ type, ... }`, and logs it with the debug option
     *
     * @param {String} type Event type
     * @param {Object} data Event data
     */
    emit(type: string, data: Record<string, unknown>): void {
        const event = Object.assign({ type }, data);
        if (this.server.options.debug) {
            console.log('[OAuth] %s %s', type, JSON.stringify(data));
        }
        this.server.emit('oauth', event);
    }

    // Authorization endpoint

    /**
     * Answers an authorization request (RFC 6749 section 4.1.1, OpenID Connect Core 1.0 section 3.1.2.1)
     *
     * @param {URLSearchParams} input Query (GET) or form (POST) parameters
     * @return {Object} a redirect, a page, or a request for the consent page
     */
    authorize(input: URLSearchParams): AuthorizeResult {
        this.prune();
        const { values: p, duplicates } = readParams(input);

        // RFC 6749 section 4.1.2.1: without a valid client and redirect URI there is nowhere safe to redirect to
        if (duplicates.includes('client_id') || duplicates.includes('redirect_uri')) {
            return this.errorPage('client_id or redirect_uri is sent more than once', 'Every parameter may only be sent once (RFC 6749 section 3.1).');
        }
        if (!p.client_id) {
            return this.errorPage('The request has no client_id', 'Add the client_id of a registered client.', this.clientList());
        }
        const client = this.clients.get(p.client_id);
        if (!client) {
            return this.errorPage('Unknown client_id ' + JSON.stringify(p.client_id), 'This client is not registered.', this.clientList());
        }
        const redirect = this.resolveRedirect(client, p.redirect_uri);
        if (typeof redirect !== 'string') {
            return redirect;
        }

        const target = { redirectUri: redirect, state: p.state };
        const fail = (error: string, description: string): AuthorizeResult => {
            this.emit('authorize', { client: client.id, result: error, description });
            return this.redirectError(target, error, description);
        };
        const request = this.checkRequest(client, redirect, p, duplicates, fail);
        if ('type' in request) {
            return request;
        }

        const { outcome, source } = this.decide(request);
        this.emit('authorize', { client: client.id, user: request.hintUser || null, decision: describeOutcome(outcome), source, prompt: request.prompt });
        return this.finish(request, outcome, source);
    }

    /**
     * Checks the parameters of an authorization request after the client and the redirect URI
     *
     * @return {Object} the request, or the error redirect
     */
    checkRequest(
        client: OAuthClient,
        redirectUri: string,
        p: Record<string, string>,
        duplicates: string[],
        fail: (error: string, description: string) => AuthorizeResult
    ): AuthRequest | AuthorizeResult {
        if (duplicates.length) {
            return fail('invalid_request', duplicates.join(', ') + ' sent more than once (RFC 6749 section 3.1)');
        }
        // OpenID Connect Core 1.0 sections 6.1 and 6.2
        if (p.request) {
            return fail('request_not_supported', 'Request objects are not supported (OpenID Connect Core 1.0 section 6.1)');
        }
        if (p.request_uri) {
            return fail('request_uri_not_supported', 'request_uri is not supported (OpenID Connect Core 1.0 section 6.2)');
        }
        if (!p.response_type) {
            return fail('invalid_request', 'response_type is missing (RFC 6749 section 4.1.1)');
        }
        if (p.response_type !== 'code') {
            return fail('unsupported_response_type', 'Only the authorization code flow, response_type=code, is supported');
        }
        if (p.response_mode && p.response_mode !== 'query') {
            return fail('invalid_request', 'Only response_mode=query is supported');
        }

        const checks: Check[] = [];
        const scope = this.checkScope(p.scope, checks);
        if (typeof scope === 'string') {
            return fail('invalid_scope', scope);
        }
        const pkce = this.checkPkce(client, p, checks);
        if (pkce) {
            return fail('invalid_request', pkce);
        }
        const prompt = p.prompt ? p.prompt.split(' ') : [];
        const badPrompt = prompt.find(value => !PROMPT_VALUES.includes(value));
        if (badPrompt !== undefined) {
            return fail('invalid_request', 'Unknown prompt value ' + JSON.stringify(badPrompt) + ' (OpenID Connect Core 1.0 section 3.1.2.1)');
        }
        if (prompt.includes('none') && prompt.length > 1) {
            return fail('invalid_request', 'prompt=none can not be combined with other values (OpenID Connect Core 1.0 section 3.1.2.1)');
        }

        checks.push(
            p.state
                ? { level: 'ok', text: 'state is present (' + p.state.length + ' characters)' }
                : { level: 'warn', text: 'no state: the client can not tell this redirect from a forged one (RFC 6749 section 10.12)' }
        );
        if (scope.includes('openid')) {
            checks.push(
                p.nonce
                    ? { level: 'ok', text: 'nonce is present, the ID token carries it' }
                    : { level: 'note', text: 'no nonce: allowed for the code flow, the ID token carries none' }
            );
        }
        const hintUser = p.login_hint === undefined ? undefined : this.server.getUser(p.login_hint) ? p.login_hint : null;
        if (hintUser === null) {
            checks.push({ level: 'warn', text: 'login_hint ' + JSON.stringify(p.login_hint) + ' is not a user of this server' });
        } else if (hintUser) {
            checks.push({ level: 'ok', text: 'login_hint matches the user ' + hintUser });
        }
        return {
            client,
            redirectUri,
            redirectUriSent: p.redirect_uri !== undefined,
            state: p.state,
            scope,
            codeChallenge: p.code_challenge,
            codeChallengeMethod: p.code_challenge ? p.code_challenge_method || 'plain' : undefined,
            nonce: p.nonce,
            loginHint: p.login_hint,
            hintUser,
            prompt,
            checks,
            ignored: Object.keys(p).filter(key => !KNOWN_PARAMS.has(key))
        };
    }

    /**
     * Finds the redirect URI of a request
     *
     * @return {String|Object} the URI, or the error page
     */
    resolveRedirect(client: OAuthClient, given: string | undefined): string | AuthorizeResult {
        const registered = client.redirectUris.map(uri => '  ' + uri).join('\n');
        if (given === undefined) {
            // RFC 6749 section 4.1.1: OPTIONAL only when the client has a single registered URI
            const only = client.redirectUris.length === 1 && !client.redirectUris[0].endsWith('*') ? client.redirectUris[0] : null;
            if (only) {
                return only;
            }
            return this.errorPage(
                'The request has no redirect_uri',
                'Client ' + client.id + ' has more than one possible redirect URI, the request must name one.',
                ['Registered for ' + client.id + ':\n' + registered]
            );
        }
        if (given.includes('#')) {
            return this.errorPage('redirect_uri has a fragment', 'A redirect URI must not include a fragment (RFC 6749 section 3.1.2).', [
                'Received: ' + given
            ]);
        }
        if (!client.redirectUris.some(uri => redirectMatches(uri, given))) {
            return this.errorPage(
                'redirect_uri is not registered for ' + client.id,
                'The authorization server must not redirect to it (RFC 6749 section 4.1.2.1).',
                ['Received: ' + given, 'Registered (a loopback http URI matches any port, RFC 8252 section 7.3):\n' + registered]
            );
        }
        return given;
    }

    /**
     * Checks the scope parameter
     *
     * @return {Array|String} the granted scopes, or the error description
     */
    checkScope(value: string | undefined, checks: Check[]): string[] | string {
        if (!value) {
            // RFC 6749 section 3.3: without a default scope the server fails the request
            return 'scope is missing, ImapKit has no default scope (RFC 6749 section 3.3)';
        }
        const requested = [...new Set(value.split(' ').filter(Boolean))];
        const bad = requested.find(token => !SCOPE_TOKEN.test(token));
        if (bad !== undefined || !requested.length) {
            return 'Invalid scope ' + JSON.stringify(bad === undefined ? value : bad) + ' (RFC 6749 section 3.3)';
        }
        const unknown = requested.filter(token => !Object.hasOwn(this.scopes, token));
        if (unknown.length && this.options.unknownScopes !== 'drop') {
            return 'Unknown scope ' + unknown.join(' ') + ', known: ' + Object.keys(this.scopes).join(' ');
        }
        const scope = requested.filter(token => Object.hasOwn(this.scopes, token));
        if (!scope.length) {
            return 'None of the requested scopes is known, known: ' + Object.keys(this.scopes).join(' ');
        }
        checks.push(
            unknown.length
                ? { level: 'warn', text: 'unknown scopes are left out of the grant: ' + unknown.join(' ') }
                : { level: 'ok', text: 'every scope is known' }
        );
        if (!scope.includes(this.mailScope)) {
            checks.push({ level: 'warn', text: 'the ' + this.mailScope + ' scope is missing: IMAP and SMTP will refuse the token' });
        }
        return scope;
    }

    /**
     * Checks the PKCE parameters (RFC 7636 section 4.3, RFC 9700 section 2.1.1)
     *
     * @return {String|null} the error description, null if they are fine
     */
    checkPkce(client: OAuthClient, p: Record<string, string>, checks: Check[]): string | null {
        const challenge = p.code_challenge;
        if (!challenge) {
            if (p.code_challenge_method) {
                return 'code_challenge_method without code_challenge (RFC 7636 section 4.3)';
            }
            if (!client.secret) {
                return 'code_challenge is missing, public clients must use PKCE (RFC 9700 section 2.1.1)';
            }
            checks.push({ level: 'warn', text: 'no PKCE: confidential clients should use it too (RFC 9700 section 2.1.1)' });
            return null;
        }
        // RFC 7636 section 4.3: the method defaults to plain
        const method = p.code_challenge_method || 'plain';
        if (method !== 'S256' && method !== 'plain') {
            return 'Unknown code_challenge_method ' + JSON.stringify(method) + ' (RFC 7636 section 4.3)';
        }
        if (method === 'plain' && !this.options.allowPlainPkce) {
            return (
                (p.code_challenge_method ? 'code_challenge_method=plain' : 'code_challenge_method is missing, which means plain,') +
                ' but a client that can use S256 must use it (RFC 7636 section 4.2)'
            );
        }
        if (!PKCE_VALUE.test(challenge) || (method === 'S256' && challenge.length !== 43)) {
            return (
                'Invalid code_challenge, ' +
                (method === 'S256' ? 'S256 gives 43 base64url characters' : 'it must be 43 to 128 unreserved characters') +
                ' (RFC 7636 section 4.2)'
            );
        }
        checks.push({ level: method === 'S256' ? 'ok' : 'warn', text: 'PKCE ' + method + ' code challenge' });
        return null;
    }

    /**
     * Finds the decision of a request: a queued decision, the user of login_hint, the client, the server default
     *
     * @param {Object} request Checked request
     * @return {Object} `{ outcome, source }`
     */
    decide(request: AuthRequest): { outcome: Outcome; source: string } {
        const queued = this.decisions.find(
            item => (item.client === undefined || item.client === request.client.id) && (item.user === undefined || item.user === request.hintUser)
        );
        if (queued) {
            if (--queued.remaining <= 0) {
                this.decisions.splice(this.decisions.indexOf(queued), 1);
            }
            return { outcome: queued.decision, source: 'queued decision ' + queued.id };
        }
        const user = request.hintUser ? this.server.getUser(request.hintUser) : false;
        const userConsent = user && user.oauth && user.oauth.consent;
        if (userConsent) {
            return { outcome: userConsent as ConsentPolicy, source: 'user ' + request.hintUser };
        }
        if (request.client.consent) {
            return { outcome: request.client.consent, source: 'client ' + request.client.id };
        }
        return { outcome: this.consent, source: 'server default' };
    }

    /**
     * Carries out a decision
     *
     * @param {Object} request Checked request
     * @param {String|Object} outcome Decision
     * @param {String} source Where the decision came from
     * @param {String} [user] The user picked on the consent page
     * @return {Object} redirect, page or consent request
     */
    finish(request: AuthRequest, outcome: Outcome, source: string, user?: string): AuthorizeResult {
        const fail = (error: string, description: string) => this.redirectError(request, error, description);
        if (outcome === 'prompt') {
            if (request.prompt.includes('none')) {
                // OpenID Connect Core 1.0 section 3.1.2.1: no page for prompt=none
                return fail('consent_required', 'prompt=none, but the consent policy (' + source + ') shows the consent page');
            }
            const pending: PendingRequest = Object.assign({}, request, { id: randomToken(18), expiresAt: this.nowMs() + PENDING_TTL, source });
            this.pending.set(pending.id, pending);
            return { type: 'consent', request: pending };
        }
        if (outcome === 'deny') {
            return fail('access_denied', 'The sign-in was denied (' + source + ')');
        }
        if (typeof outcome === 'object') {
            return fail(outcome.error, outcome.description || 'Answered by ' + source);
        }
        if (outcome === 'no-redirect') {
            return {
                type: 'page',
                page: {
                    status: 200,
                    tone: 'info',
                    title: 'Not redirecting',
                    message:
                        'The decision (' +
                        source +
                        ') leaves this sign-in unanswered, so the client never gets its redirect. Use it to test how the client times out.'
                }
            };
        }
        const name = user || this.pickUser(request);
        if (!name) {
            return fail(
                'access_denied',
                request.loginHint === undefined
                    ? 'The server has no users'
                    : 'login_hint ' + JSON.stringify(request.loginHint) + ' is not a user of this server'
            );
        }
        const code = this.issueCode(request, name);
        this.emit('code', { client: request.client.id, user: name, scope: request.scope.join(' '), source, fault: outcome === 'approve' ? null : outcome });
        const params: Record<string, string> = { code };
        if (request.state !== undefined || outcome === 'wrong-state') {
            params.state = outcome === 'wrong-state' ? (request.state || '') + 'x-wrong-state' : (request.state as string);
        }
        return { type: 'redirect', location: this.redirectUrl(request.redirectUri, params, outcome === 'wrong-iss') };
    }

    /**
     * The user an approved request signs in: the user of login_hint, or the first user
     *
     * @return {String|null} user name, null if there is none
     */
    pickUser(request: AuthRequest): string | null {
        if (request.loginHint !== undefined) {
            return request.hintUser || null;
        }
        return this.userNames()[0] || null;
    }

    /** Sorted user names, the default user first */
    userNames(): string[] {
        return Object.keys(this.server.users).sort((a, b) => (a === 'testuser' ? -1 : b === 'testuser' ? 1 : a.localeCompare(b)));
    }

    /**
     * Answers the form of the consent page
     *
     * @param {URLSearchParams} form Form fields: request, action (allow, deny, outcome), user, remember, outcome, description
     * @return {Object} redirect or page
     */
    answerConsent(form: URLSearchParams): AuthorizeResult {
        this.prune();
        const id = form.get('request') || '';
        const request = this.pending.get(id);
        if (!request) {
            return this.errorPage(
                'This sign-in is no longer open',
                'It was answered already, it expired after 10 minutes, or the server was reset or restarted. Start the sign-in again from the client.'
            );
        }
        const action = form.get('action');
        const user = form.get('user') || '';
        if (action !== 'allow' && action !== 'deny' && action !== 'outcome') {
            return this.errorPage('Unknown action', 'The form sent action ' + JSON.stringify(action) + '.');
        }
        if (action !== 'deny' && !this.server.getUser(user)) {
            return this.errorPage('Choose an account', 'User ' + JSON.stringify(user) + ' does not exist. Go back and pick an account.');
        }
        let outcome: Outcome = action === 'allow' ? 'approve' : 'deny';
        if (action === 'outcome') {
            const value = form.get('outcome') || '';
            const description = form.get('description') || undefined;
            try {
                outcome = checkOutcome(value.startsWith('error:') ? { error: value.slice(6), description } : value, 'outcome', true);
            } catch (err) {
                return this.errorPage('Unknown outcome', (err as Error).message);
            }
        }
        this.pending.delete(id);
        if (form.get('remember') === 'on' && (outcome === 'approve' || outcome === 'deny')) {
            request.client.consent = outcome;
            this.emit('remember', { client: request.client.id, consent: outcome });
        }
        this.emit('consent', { client: request.client.id, user: action === 'deny' ? null : user, decision: describeOutcome(outcome) });
        return this.finish(request, outcome, 'consent page', user);
    }

    /**
     * Drops expired consent requests and codes, and tokens a day after they expired or ended. Until then a login with
     * one is refused as expired or revoked, after that as unknown
     */
    prune(): void {
        const now = this.nowMs();
        this.tokens.forEach((record, token) => {
            const ended = record.endedAt !== null ? record.endedAt : record.expiresAt;
            if (ended !== null && ended + TOKEN_MEMORY <= now) {
                this.tokens.delete(token);
            }
        });
        this.pending.forEach((request, id) => request.expiresAt <= now && this.pending.delete(id));
        // an expired code is still known for a while, so its exchange fails as expired
        this.codes.forEach((code, id) => code.expiresAt + PENDING_TTL <= now && this.codes.delete(id));
    }

    issueCode(request: AuthRequest, user: string): string {
        const code = randomToken();
        this.codes.set(code, {
            clientId: request.client.id,
            user,
            redirectUri: request.redirectUri,
            redirectUriSent: request.redirectUriSent,
            scope: request.scope,
            challenge: request.codeChallenge,
            method: request.codeChallengeMethod,
            nonce: request.nonce,
            expiresAt: this.nowMs() + this.codeTtl * 1000,
            authTime: Math.floor(this.nowMs() / 1000),
            grantId: randomToken(12),
            used: false
        });
        return code;
    }

    /**
     * Builds a redirect to the client, with `iss` (RFC 9207 section 2)
     *
     * @param {String} redirectUri Redirect URI, its query is kept (RFC 6749 section 3.1.2)
     * @param {Object} params Response parameters
     * @param {Boolean} [wrongIss] true sends another issuer, the wrong-iss fault
     * @return {String} URL
     */
    redirectUrl(redirectUri: string, params: Record<string, string>, wrongIss = false): string {
        const url = new URL(redirectUri);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
        url.searchParams.set('iss', wrongIss ? 'https://wrong-issuer.invalid' : this.issuer);
        return url.toString();
    }

    redirectError(target: { redirectUri: string; state: string | undefined }, error: string, description: string): AuthorizeResult {
        const params: Record<string, string> = { error, error_description: errorText(description) };
        if (target.state !== undefined) {
            // RFC 6749 section 4.1.2.1: REQUIRED if the request had it
            params.state = target.state;
        }
        return { type: 'redirect', location: this.redirectUrl(target.redirectUri, params) };
    }

    errorPage(title: string, message: string, details?: string[]): AuthorizeResult {
        this.emit('authorize', { client: null, result: 'error page', description: title });
        return { type: 'page', page: { status: 400, tone: 'error', title, message, details } };
    }

    clientList(): string[] {
        return ['Registered clients:\n' + [...this.clients.values()].map(client => '  ' + client.id + ' (' + client.name + ')').join('\n')];
    }

    // Token endpoint

    /**
     * Answers a token request (RFC 6749 sections 4.1.3 and 6)
     *
     * @param {URLSearchParams} form Form parameters
     * @param {String} [authorization] Authorization header
     * @return {Promise<Object>} JSON answer
     */
    async token(form: URLSearchParams, authorization: string | undefined): Promise<JsonResult> {
        this.prune();
        const { values: p, duplicates } = readParams(form);
        if (duplicates.length) {
            return tokenError('invalid_request', duplicates.join(', ') + ' sent more than once (RFC 6749 section 3.2)');
        }
        const grant = p.grant_type;
        const fault = this.takeTokenFault(grant);
        if (fault && fault.delay) {
            await new Promise(resolve => setTimeout(resolve, fault.delay));
        }
        if (fault && (fault.error || fault.html || fault.status)) {
            this.emit('token', { grant: grant || null, result: 'fault', fault: fault.id });
            if (fault.html) {
                return { status: fault.status || 500, body: null, htmlError: true };
            }
            return tokenError(fault.error || 'server_error', fault.description || 'Queued token fault ' + fault.id, fault.status || 400);
        }
        const auth = this.authenticateClient(p, authorization);
        if ('status' in auth) {
            return auth;
        }
        const client = auth.client;
        let result: JsonResult;
        if (!grant) {
            result = tokenError('invalid_request', 'grant_type is missing (RFC 6749 section 4.1.3)');
        } else if (grant === 'authorization_code') {
            result = this.exchangeCode(client, p, fault);
        } else if (grant === 'refresh_token') {
            result = this.refresh(client, p);
        } else {
            result = tokenError('unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token');
        }
        const body = result.body as Record<string, string>;
        this.emit('token', { grant: grant || null, client: client.id, result: result.status === 200 ? 'ok' : body.error, description: body.error_description });
        return result;
    }

    /**
     * Authenticates the client of a token or revocation request (RFC 6749 section 2.3)
     *
     * @return {Object} `{ client }` or the error answer
     */
    authenticateClient(p: Record<string, string>, authorization: string | undefined): { client: OAuthClient } | JsonResult {
        let id = p.client_id;
        let secret = p.client_secret;
        const basic = /^Basic +([A-Za-z0-9+/=]+)$/i.exec(authorization || '');
        if (authorization && !basic) {
            return tokenError('invalid_request', 'Only Basic authentication is supported in the Authorization header (RFC 6749 section 2.3.1)');
        }
        if (basic) {
            if (secret !== undefined) {
                return tokenError(
                    'invalid_request',
                    'The client used Basic authentication and client_secret, only one method is allowed (RFC 6749 section 2.3)'
                );
            }
            const decoded = Buffer.from(basic[1], 'base64').toString('utf-8');
            const colon = decoded.indexOf(':');
            // RFC 6749 section 2.3.1: client ID and secret are form encoded before they go into the header
            const decode = (value: string) => {
                try {
                    return decodeURIComponent(value.replace(/\+/g, ' '));
                } catch {
                    return null;
                }
            };
            const basicId = colon < 0 ? null : decode(decoded.slice(0, colon));
            const basicSecret = colon < 0 ? null : decode(decoded.slice(colon + 1));
            if (basicId === null || basicSecret === null) {
                return tokenError('invalid_client', 'Malformed Basic credentials', 401, { 'WWW-Authenticate': 'Basic realm="imapkit"' });
            }
            if (id !== undefined && id !== basicId) {
                return tokenError('invalid_request', 'client_id differs from the client of the Authorization header');
            }
            id = basicId;
            secret = basicSecret;
        }
        const challenge = basic ? { 'WWW-Authenticate': 'Basic realm="imapkit"' } : undefined;
        if (!id) {
            return tokenError('invalid_client', 'No client authentication and no client_id (RFC 6749 section 4.1.3)', 401, challenge);
        }
        const client = this.clients.get(id);
        if (!client) {
            return tokenError('invalid_client', 'Unknown client ' + JSON.stringify(id), 401, challenge);
        }
        if (client.secret === null) {
            if (secret !== undefined) {
                return tokenError('invalid_client', 'Client ' + id + ' is a public client without a secret, leave client_secret out', 401, challenge);
            }
            return { client };
        }
        if (secret === undefined || !safeEqual(secret, client.secret)) {
            return tokenError(
                'invalid_client',
                secret === undefined ? 'Client ' + id + ' is confidential, it must send its secret' : 'Wrong client secret',
                401,
                challenge
            );
        }
        return { client };
    }

    exchangeCode(client: OAuthClient, p: Record<string, string>, fault: TokenFault | null): JsonResult {
        if (!p.code) {
            return tokenError('invalid_request', 'code is missing (RFC 6749 section 4.1.3)');
        }
        const code = this.codes.get(p.code);
        if (!code || code.expiresAt <= this.nowMs()) {
            if (code) {
                this.codes.delete(p.code);
            }
            return tokenError(
                'invalid_grant',
                code ? 'The authorization code expired (' + this.codeTtl + ' seconds, RFC 6749 section 4.1.2)' : 'Unknown authorization code'
            );
        }
        if (code.clientId !== client.id) {
            return tokenError('invalid_grant', 'The authorization code was issued to another client (RFC 6749 section 4.1.3)');
        }
        if (code.used) {
            // RFC 6749 section 4.1.2: a second use fails, and the tokens of the first use are revoked
            const revoked = this.revokeGrant(code.grantId);
            this.emit('revoke', { client: client.id, user: code.user, reason: 'authorization code reused', tokens: revoked });
            return tokenError('invalid_grant', 'The authorization code was used already, its tokens are revoked now (RFC 6749 section 4.1.2)');
        }
        if (code.redirectUriSent ? p.redirect_uri !== code.redirectUri : p.redirect_uri !== undefined && p.redirect_uri !== code.redirectUri) {
            return tokenError(
                'invalid_grant',
                (p.redirect_uri === undefined ? 'redirect_uri is missing' : 'redirect_uri differs from the authorization request') +
                    ', it must be identical (RFC 6749 section 4.1.3)'
            );
        }
        const verifier = p.code_verifier;
        if (code.challenge) {
            if (!verifier) {
                return tokenError('invalid_grant', 'code_verifier is missing, the authorization request had a code_challenge (RFC 7636 section 4.5)');
            }
            if (!PKCE_VALUE.test(verifier)) {
                return tokenError('invalid_grant', 'Invalid code_verifier, it must be 43 to 128 unreserved characters (RFC 7636 section 4.1)');
            }
            const computed = code.method === 'S256' ? crypto.createHash('sha256').update(verifier).digest('base64url') : verifier;
            if (!safeEqual(computed, code.challenge)) {
                return tokenError('invalid_grant', 'code_verifier does not match the code_challenge (RFC 7636 section 4.6)');
            }
        } else if (verifier !== undefined) {
            // RFC 9700 section 2.1.1: a code_verifier without a code_challenge is a PKCE downgrade
            return tokenError('invalid_grant', 'code_verifier without a code_challenge in the authorization request (RFC 9700 section 2.1.1)');
        }
        if (!this.server.getUser(code.user)) {
            return tokenError('invalid_grant', 'User ' + code.user + ' does not exist any more');
        }
        code.used = true;
        return { status: 200, body: this.issueTokens(client, code.user, code.scope, code.grantId, { nonce: code.nonce, authTime: code.authTime, fault }) };
    }

    refresh(client: OAuthClient, p: Record<string, string>): JsonResult {
        if (!p.refresh_token) {
            return tokenError('invalid_request', 'refresh_token is missing (RFC 6749 section 6)');
        }
        const record = this.tokens.get(p.refresh_token);
        if (!record || record.type !== 'refresh' || record.revoked) {
            return tokenError('invalid_grant', record && record.revoked ? 'The refresh token was revoked' : 'Unknown refresh token');
        }
        if (record.clientId !== client.id) {
            return tokenError('invalid_grant', 'The refresh token was issued to another client (RFC 6749 section 6)');
        }
        if (record.rotated) {
            // RFC 9700 section 4.14.2: reuse of a rotated refresh token revokes the grant
            const revoked = this.revokeGrant(record.grantId);
            this.emit('revoke', { client: client.id, user: record.user, reason: 'rotated refresh token reused', tokens: revoked });
            return tokenError('invalid_grant', 'This refresh token was replaced by rotation, using it again revoked the grant (RFC 9700 section 4.14.2)');
        }
        if (!this.server.getUser(record.user)) {
            return tokenError('invalid_grant', 'User ' + record.user + ' does not exist any more');
        }
        let scope = record.scope;
        if (p.scope) {
            const requested = [...new Set(p.scope.split(' ').filter(Boolean))];
            const extra = requested.filter(token => !record.scope.includes(token));
            if (extra.length || !requested.length) {
                // RFC 6749 section 6: no scope beyond the original grant
                return tokenError('invalid_scope', 'Scope beyond the original grant: ' + (extra.join(' ') || p.scope) + ' (RFC 6749 section 6)');
            }
            scope = requested;
        }
        const body = this.issueTokens(client, record.user, scope, record.grantId, { refresh: record });
        return { status: 200, body };
    }

    /**
     * Issues an access token, and a refresh token and an ID token when the grant calls for them
     *
     * @return {Object} token response (RFC 6749 section 5.1)
     */
    issueTokens(
        client: OAuthClient,
        user: string,
        scope: string[],
        grantId: string,
        extra: { nonce?: string | undefined; authTime?: number | undefined; fault?: TokenFault | null | undefined; refresh?: TokenRecord | undefined }
    ): Record<string, unknown> {
        const now = this.nowMs();
        const accessToken = randomToken();
        this.tokens.set(accessToken, {
            token: accessToken,
            type: 'access',
            clientId: client.id,
            user,
            scope,
            grantId,
            expiresAt: now + this.accessTokenTtl * 1000,
            revoked: false,
            rotated: false,
            endedAt: null
        });
        const body: Record<string, unknown> = { access_token: accessToken, token_type: 'Bearer', expires_in: this.accessTokenTtl, scope: scope.join(' ') };
        if (extra.refresh) {
            if (this.options.rotateRefreshTokens) {
                this.endToken(extra.refresh, 'rotated');
                body.refresh_token = this.newRefreshToken(client, user, extra.refresh.scope, grantId);
            }
        } else if (this.options.refreshTokens === 'always' || scope.includes('offline_access')) {
            // OpenID Connect Core 1.0 section 11: offline_access asks for a refresh token
            body.refresh_token = this.newRefreshToken(client, user, scope, grantId);
        }
        if (!extra.refresh && scope.includes('openid')) {
            body.id_token = this.idToken(client, user, scope, extra.nonce, extra.authTime, extra.fault ? extra.fault.claims : undefined);
        }
        return body;
    }

    newRefreshToken(client: OAuthClient, user: string, scope: string[], grantId: string): string {
        const token = randomToken();
        this.tokens.set(token, {
            token,
            type: 'refresh',
            clientId: client.id,
            user,
            scope,
            grantId,
            expiresAt: null,
            revoked: false,
            rotated: false,
            endedAt: null
        });
        return token;
    }

    /**
     * Signs an ID token (OpenID Connect Core 1.0 section 2). The user name is the email address
     *
     * @return {String} JWT
     */
    idToken(
        client: OAuthClient,
        user: string,
        scope: string[],
        nonce: string | undefined,
        authTime: number | undefined,
        changes: Record<string, unknown> | undefined
    ): string {
        const iat = Math.floor(this.nowMs() / 1000);
        const claims: Record<string, unknown> = Object.assign(
            { iss: this.issuer, sub: user, aud: client.id, azp: client.id, iat, exp: iat + this.accessTokenTtl, auth_time: authTime || iat },
            nonce === undefined ? {} : { nonce },
            this.userClaims(user, scope)
        );
        for (const [key, value] of Object.entries(changes || {})) {
            if (value === null) {
                delete claims[key];
            } else {
                claims[key] = value;
            }
        }
        return signJwt(this.key || defaultSigningKey(), claims);
    }

    /** The claims of the email and profile scopes */
    userClaims(user: string, scope: string[]): Record<string, unknown> {
        const claims: Record<string, unknown> = {};
        if (scope.includes('email')) {
            claims.email = user;
            claims.email_verified = true;
        }
        const data = this.server.getUser(user);
        if (scope.includes('profile') && data && typeof data.displayName === 'string' && data.displayName) {
            claims.name = data.displayName;
        }
        return claims;
    }

    /** The public key of the ID tokens (RFC 7517) */
    jwks(): { keys: Record<string, string>[] } {
        return { keys: [(this.key || defaultSigningKey()).jwk] };
    }

    takeTokenFault(grant: string | undefined): TokenFault | null {
        const fault = this.tokenFaults.find(item => item.grant === undefined || item.grant === grant);
        if (!fault) {
            return null;
        }
        if (--fault.remaining <= 0) {
            this.tokenFaults.splice(this.tokenFaults.indexOf(fault), 1);
        }
        return fault;
    }

    /**
     * Revokes every token of a grant
     *
     * @return {Number} how many tokens were revoked
     */
    revokeGrant(grantId: string): number {
        let count = 0;
        this.tokens.forEach(record => {
            if (record.grantId === grantId && !record.revoked) {
                this.endToken(record, 'revoked');
                count++;
            }
        });
        return count;
    }

    // Revocation and userinfo

    /**
     * Answers a revocation request (RFC 7009 section 2)
     *
     * @return {Object} JSON answer
     */
    revoke(form: URLSearchParams, authorization: string | undefined): JsonResult {
        const { values: p, duplicates } = readParams(form);
        if (duplicates.length) {
            return tokenError('invalid_request', duplicates.join(', ') + ' sent more than once');
        }
        const auth = this.authenticateClient(p, authorization);
        if ('status' in auth) {
            return auth;
        }
        if (!p.token) {
            return tokenError('invalid_request', 'token is missing (RFC 7009 section 2.1)');
        }
        const record = this.tokens.get(p.token);
        if (!record) {
            // RFC 7009 section 2.2: an invalid token is not an error
            return { status: 200, body: {} };
        }
        if (record.clientId !== auth.client.id) {
            return tokenError('invalid_request', 'The token was issued to another client (RFC 7009 section 2.1)');
        }
        // RFC 7009 section 2.1: revoking a refresh token SHOULD also revoke the access tokens of the grant
        const count = record.type === 'refresh' ? this.revokeGrant(record.grantId) : Number(!record.revoked);
        this.endToken(record, 'revoked');
        this.emit('revoke', { client: auth.client.id, user: record.user, reason: record.type + ' token revoked by the client', tokens: count });
        return { status: 200, body: {} };
    }

    /**
     * Answers a UserInfo request (OpenID Connect Core 1.0 section 5.3)
     *
     * @param {String} [authorization] Authorization header with the access token
     * @return {Object} JSON answer
     */
    userinfo(authorization: string | undefined): JsonResult {
        const bearer = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization || '');
        const challenge = (error: string, description: string, status: number): JsonResult => ({
            status,
            body: { error, error_description: description },
            // RFC 6750 section 3
            headers: { 'WWW-Authenticate': 'Bearer' + (error ? ' error="' + error + '", error_description="' + description + '"' : '') }
        });
        if (!bearer) {
            return challenge('invalid_request', 'Send the access token as Authorization: Bearer <token> (RFC 6750 section 2.1)', 401);
        }
        const record = this.tokens.get(bearer[1]);
        const reason = this.tokenProblem(record);
        if (reason || !record) {
            return challenge('invalid_token', 'The access token is ' + (reason || 'unknown'), 401);
        }
        if (!record.scope.includes('openid')) {
            return challenge('insufficient_scope', 'The access token has no openid scope', 403);
        }
        return { status: 200, body: Object.assign({ sub: record.user }, this.userClaims(record.user, record.scope)) };
    }

    /**
     * Why an access token can not be used
     *
     * @return {String|null} "expired", "revoked" ..., null for a usable token
     */
    tokenProblem(record: TokenRecord | undefined): string | null {
        if (!record || record.type !== 'access') {
            return record ? 'a refresh token, not an access token' : 'unknown';
        }
        if (record.revoked) {
            return 'revoked';
        }
        if (record.expiresAt !== null && record.expiresAt <= this.nowMs()) {
            return 'expired';
        }
        if (!this.server.getUser(record.user)) {
            return 'for a user that does not exist any more';
        }
        return null;
    }

    /**
     * Checks an access token for an IMAP or SMTP login
     *
     * @param {String} token Access token
     * @param {String} [username] The user the client logs in as, any if not set
     * @param {String} via "imap" or "smtp", for the event
     * @return {Object|null} `{ user }` or `{ error, reason }`, null for a token the provider did not issue
     */
    verifyAccessToken(token: string, username: string | undefined, via: string): TokenCheck | null {
        const record = this.tokens.get(token);
        if (!record || record.type !== 'access') {
            return null;
        }
        let result: TokenCheck;
        const problem = this.tokenProblem(record);
        if (problem) {
            result = { error: 'invalid_token', reason: 'the access token is ' + problem };
        } else if (username !== undefined && username !== record.user) {
            result = { error: 'invalid_token', reason: 'the access token is for ' + record.user + ', not ' + username };
        } else if (!record.scope.includes(this.mailScope)) {
            result = { error: 'insufficient_scope', reason: 'the access token has no ' + this.mailScope + ' scope' };
        } else {
            result = { user: record.user };
        }
        this.emit('access', {
            via,
            client: record.clientId,
            user: record.user,
            result: 'user' in result ? 'ok' : result.error,
            reason: 'user' in result ? null : result.reason
        });
        return result;
    }

    /** The discovery document (OpenID Connect Discovery 1.0 section 3, RFC 8414 section 2) */
    metadata(): Record<string, unknown> {
        const authMethods = ['none', 'client_secret_basic', 'client_secret_post'];
        return {
            issuer: this.issuer,
            authorization_endpoint: this.issuer + '/authorize',
            token_endpoint: this.issuer + '/token',
            userinfo_endpoint: this.issuer + '/userinfo',
            jwks_uri: this.issuer + '/jwks',
            revocation_endpoint: this.issuer + '/revoke',
            scopes_supported: Object.keys(this.scopes),
            response_types_supported: ['code'],
            response_modes_supported: ['query'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: authMethods,
            revocation_endpoint_auth_methods_supported: authMethods,
            code_challenge_methods_supported: this.options.allowPlainPkce ? ['S256', 'plain'] : ['S256'],
            claims_supported: ['iss', 'sub', 'aud', 'azp', 'exp', 'iat', 'auth_time', 'nonce', 'email', 'email_verified', 'name'],
            prompt_values_supported: PROMPT_VALUES,
            authorization_response_iss_parameter_supported: true,
            request_parameter_supported: false,
            request_uri_parameter_supported: false
        };
    }

    // Control API

    describeClient(client: OAuthClient): Record<string, unknown> {
        return { id: client.id, name: client.name, confidential: client.secret !== null, redirectUris: client.redirectUris.slice(), consent: client.consent };
    }

    describeToken(record: TokenRecord): Record<string, unknown> {
        return {
            type: record.type,
            token: record.token,
            user: record.user,
            client: record.clientId,
            scope: record.scope.join(' '),
            expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
            expired: record.expiresAt !== null && record.expiresAt <= this.nowMs(),
            revoked: record.revoked,
            rotated: record.rotated
        };
    }

    /**
     * Selects tokens for the control API
     *
     * @param {Object} [filter] `{ user, client, token, type }`
     * @return {Array} token records
     */
    findTokens(filter?: { user?: unknown; client?: unknown; token?: unknown; type?: unknown }): TokenRecord[] {
        const f = filter || {};
        optionalStrings(f, ['user', 'client', 'token']);
        if (f.type !== undefined && f.type !== 'access' && f.type !== 'refresh') {
            throw new ImapKitError('type must be "access" or "refresh"', 'INVALID');
        }
        return [...this.tokens.values()].filter(
            record =>
                (f.user === undefined || record.user === f.user) &&
                (f.client === undefined || record.clientId === f.client) &&
                (f.token === undefined || record.token === f.token) &&
                (f.type === undefined || record.type === f.type)
        );
    }

    queueDecision(options?: { decision?: unknown; client?: unknown; user?: unknown; count?: unknown }): { id: number } {
        const o = options || {};
        const decision = checkOutcome(o.decision, 'decision', true);
        optionalStrings(o, ['client', 'user']);
        const id = ++this.queueCounter;
        this.decisions.push({ id, decision, client: o.client as string | undefined, user: o.user as string | undefined, remaining: countOption(o.count) });
        return { id };
    }

    queueTokenFault(options?: Record<string, unknown>): { id: number } {
        const o = options || {};
        const { grant, error, status, html, delay, claims } = o;
        optionalStrings(o, ['description']);
        if (grant !== undefined && grant !== 'authorization_code' && grant !== 'refresh_token') {
            throw new ImapKitError('grant must be "authorization_code" or "refresh_token"', 'INVALID');
        }
        if (error !== undefined && !isErrorCode(error)) {
            throw new ImapKitError('error must be an OAuth error code', 'INVALID');
        }
        if (status !== undefined && (!Number.isInteger(status) || (status as number) < 400 || (status as number) > 599)) {
            throw new ImapKitError('status must be an HTTP error status, 400 to 599', 'INVALID');
        }
        if (delay !== undefined && (typeof delay !== 'number' || !(delay >= 0) || delay > 600000)) {
            throw new ImapKitError('delay must be milliseconds, at most 600000', 'INVALID');
        }
        if (claims !== undefined && (!claims || typeof claims !== 'object' || Array.isArray(claims))) {
            throw new ImapKitError('claims must be an object, null values remove claims', 'INVALID');
        }
        if (error === undefined && !html && status === undefined && delay === undefined && claims === undefined) {
            throw new ImapKitError('A token fault needs error, status, html, delay or claims', 'INVALID');
        }
        const id = ++this.queueCounter;
        this.tokenFaults.push({
            id,
            grant: grant as TokenFault['grant'],
            error: error as string | undefined,
            description: o.description as string | undefined,
            status: status as number | undefined,
            html: !!html,
            delay: (delay as number) || 0,
            claims: claims as Record<string, unknown> | undefined,
            remaining: countOption(o.count)
        });
        return { id };
    }

    listClients(): Record<string, unknown>[] {
        return [...this.clients.values()].map(client => this.describeClient(client));
    }

    setClient(id: string, options: OAuthClientOptions): Record<string, unknown> {
        const client = makeClient(id, options);
        this.clients.set(client.id, client);
        return this.describeClient(client);
    }

    deleteClient(id: string): void {
        if (!this.clients.delete(id)) {
            throw new ImapKitError('OAuth client ' + JSON.stringify(id) + ' does not exist', 'NONEXISTENT');
        }
    }

    setConsent(consent: unknown): { consent: ConsentPolicy } {
        this.consent = checkOutcome(consent, 'consent') as ConsentPolicy;
        return { consent: this.consent };
    }

    listTokens(filter?: Record<string, unknown>): Record<string, unknown>[] {
        return this.findTokens(filter).map(record => this.describeToken(record));
    }

    expireTokens(filter?: Record<string, unknown>): { expired: number } {
        const records = this.findTokens(Object.assign({}, filter, { type: 'access' })).filter(record => !this.tokenProblem(record));
        const now = this.nowMs();
        records.forEach(record => (record.expiresAt = now));
        return { expired: records.length };
    }

    revokeTokens(filter?: Record<string, unknown>): { revoked: number } {
        const records = this.findTokens(filter).filter(record => !record.revoked);
        records.forEach(record => this.endToken(record, 'revoked'));
        if (records.length) {
            this.emit('revoke', { reason: 'control API', tokens: records.length });
        }
        return { revoked: records.length };
    }

    info(): Record<string, unknown> {
        return {
            issuer: this.issuer,
            discovery: this.issuer ? this.discoveryUrl() : null,
            consent: this.consent,
            mailScope: this.mailScope,
            scopes: Object.keys(this.scopes),
            clients: this.listClients(),
            decisions: this.decisions.map(item => Object.assign({}, item)),
            tokenFaults: this.tokenFaults.map(item => Object.assign({}, item))
        };
    }

    /** Adds the control operations and their REST routes, see README "Control API" */
    registerControl(): void {
        const control = this.server.control;
        const created = (body: unknown) => ({ status: 201, body });
        const deleted = () => ({ deleted: true });
        const tokenFilter = (query: URLSearchParams) => {
            const filter: Record<string, string> = {};
            for (const key of ['user', 'client', 'type']) {
                const value = query.get(key);
                if (value !== null) {
                    filter[key] = value;
                }
            }
            return filter;
        };
        // name, operation, then the REST route: method, path, summary and how a request calls the operation
        const operations: [string, (...args: any[]) => unknown, ControlRoute['method'], string, string, ControlRoute['handler']][] = [
            ['getOAuthInfo', () => this.info(), 'GET', '/v1/oauth', 'OAuth provider: issuer, default consent, clients, queues', () => control.getOAuthInfo()],
            [
                'listOAuthClients',
                () => this.listClients(),
                'GET',
                '/v1/oauth/clients',
                'Registered OAuth clients, without secrets',
                () => control.listOAuthClients()
            ],
            [
                'setOAuthClient',
                (id: string, options: OAuthClientOptions) => this.setClient(id, options),
                'PUT',
                '/v1/oauth/clients/{id}',
                'Registers or replaces an OAuth client ({ name, secret, redirectUris, consent })',
                ({ params, body }) => control.setOAuthClient(params.id, body)
            ],
            [
                'deleteOAuthClient',
                (id: string) => this.deleteClient(id),
                'DELETE',
                '/v1/oauth/clients/{id}',
                'Removes an OAuth client',
                ({ params }) => (control.deleteOAuthClient(params.id), deleted())
            ],
            [
                'setOAuthConsent',
                (consent: unknown) => this.setConsent(consent),
                'PUT',
                '/v1/oauth/consent',
                'Sets the default consent policy ({ consent }: prompt, approve, deny or { error, description })',
                ({ body }) => control.setOAuthConsent(body.consent)
            ],
            [
                'queueOAuthDecision',
                (options?: Record<string, unknown>) => this.queueDecision(options),
                'POST',
                '/v1/oauth/decisions',
                'Queues the decision of the next sign-ins ({ decision, client, user, count })',
                ({ body }) => created(control.queueOAuthDecision(body))
            ],
            [
                'listOAuthDecisions',
                () => this.decisions.map(item => Object.assign({}, item)),
                'GET',
                '/v1/oauth/decisions',
                'Queued sign-in decisions',
                () => control.listOAuthDecisions()
            ],
            [
                'clearOAuthDecisions',
                () => void (this.decisions = []),
                'DELETE',
                '/v1/oauth/decisions',
                'Removes the queued sign-in decisions',
                () => (control.clearOAuthDecisions(), deleted())
            ],
            [
                'queueOAuthTokenFault',
                (options?: Record<string, unknown>) => this.queueTokenFault(options),
                'POST',
                '/v1/oauth/token-faults',
                'Queues a fault of the token endpoint ({ grant, error, description, status, html, delay, claims, count })',
                ({ body }) => created(control.queueOAuthTokenFault(body))
            ],
            [
                'clearOAuthTokenFaults',
                () => void (this.tokenFaults = []),
                'DELETE',
                '/v1/oauth/token-faults',
                'Removes the queued token endpoint faults',
                () => (control.clearOAuthTokenFaults(), deleted())
            ],
            [
                'listOAuthTokens',
                (filter?: Record<string, unknown>) => this.listTokens(filter),
                'GET',
                '/v1/oauth/tokens',
                'Issued tokens (?user=&client=&type=access|refresh to choose)',
                ({ query }) => control.listOAuthTokens(tokenFilter(query))
            ],
            [
                'expireOAuthTokens',
                (filter?: Record<string, unknown>) => this.expireTokens(filter),
                'POST',
                '/v1/oauth/tokens/expire',
                'Lets access tokens expire now ({ user, client, token })',
                ({ body }) => control.expireOAuthTokens(body)
            ],
            [
                'revokeOAuthTokens',
                (filter?: Record<string, unknown>) => this.revokeTokens(filter),
                'POST',
                '/v1/oauth/tokens/revoke',
                'Revokes access and refresh tokens ({ user, client, token, type })',
                ({ body }) => control.revokeOAuthTokens(body)
            ]
        ];
        for (const [name, fn, method, path, summary, handler] of operations) {
            control.register(name, fn, [{ method, path, summary, handler }]);
        }
    }
}

/**
 * Checks that the listed keys of an object are strings when they are set
 *
 * @param {Object} object Options
 * @param {Array} keys Keys to check
 * @throws {ImapKitError} INVALID for a value that is not a string
 */
function optionalStrings(object: Record<string, unknown>, keys: string[]): void {
    for (const key of keys) {
        if (object[key] !== undefined && typeof object[key] !== 'string') {
            throw new ImapKitError(key + ' must be a string', 'INVALID');
        }
    }
}

/**
 * Reads the count of a queued item
 *
 * @param {*} value Count, 1 if not set
 * @return {Number} count
 */
function countOption(value: unknown): number {
    if (value === undefined) {
        return 1;
    }
    if (!Number.isInteger(value) || (value as number) < 1) {
        throw new ImapKitError('count must be a positive integer', 'INVALID');
    }
    return value as number;
}

/**
 * An error answer of the token endpoint (RFC 6749 section 5.2)
 *
 * @return {Object} JSON answer
 */
function tokenError(error: string, description: string, status = 400, headers?: Record<string, string>): JsonResult {
    return { status, body: { error, error_description: errorText(description) }, headers };
}

export { OAuthProvider, redirectMatches };
