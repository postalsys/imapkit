// Helpers for the tests of the OAuth provider (src/oauth/): a server with the `oauth` option started before every
// test, PKCE pairs, and the requests a mail client sends

import { beforeEach, afterEach } from 'node:test';
import crypto from 'node:crypto';
import imapkit from '../../src/server.js';
import mockClient from '../../src/mock-client.js';
import { validateThen } from './validate-responses.js';
import type { AddressInfo } from 'node:net';
import type { IMAPServer } from '../../src/server.js';
import type { IMAPServerOptions } from '../../src/types.js';

export interface OAuthContext {
    server: IMAPServer;
    issuer: string;
    readonly imapPort: number;
    /** `oauth` events of the running test */
    events: Record<string, any>[];
}

export const REDIRECT = 'http://127.0.0.1:5000/cb';

/** Users with address-style names, the email claim is the user name */
export function users(): Record<string, any> {
    return {
        testuser: { password: 'testpass', xoauth2: { accessToken: 'testtoken' } },
        'alice@example.com': { password: 'pw', displayName: 'Alice Example' },
        'bob@example.com': { password: 'pw', oauth: { consent: 'deny' } }
    };
}

/**
 * Starts a server with the oauth option before every test and stops it afterwards
 *
 * @param {Function} getOptions returns the server options
 * @return {Object} context
 */
export function setupOAuth(getOptions: () => IMAPServerOptions): OAuthContext {
    const ctx: OAuthContext = {
        server: null as unknown as IMAPServer,
        issuer: '',
        events: [],
        get imapPort() {
            return (ctx.server.address() as AddressInfo).port;
        }
    };
    // the hooks return promises, Deno does not pass a done callback to node:test hooks
    beforeEach(async () => {
        const options = getOptions();
        ctx.server = imapkit(Object.assign({ oauth: {} }, options));
        ctx.events = [];
        ctx.server.on('oauth', event => ctx.events.push(event));
        await ctx.server.start(0, '127.0.0.1');
        ctx.issuer = ctx.server.oauth!.issuer;
    });
    afterEach(() => ctx.server.stop());
    return ctx;
}

/** A PKCE pair (RFC 7636 section 4.1 and 4.2) */
export function pkce(): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** GET /authorize without following the redirect */
export function authorize(issuer: string, params: Record<string, string>): Promise<Response> {
    return fetch(issuer + '/authorize?' + new URLSearchParams(params), { redirect: 'manual' });
}

/** The query of the Location header */
export function redirectParams(res: Response): URLSearchParams {
    const location = res.headers.get('location');
    if (!location) {
        throw new Error('No redirect, status ' + res.status);
    }
    return new URL(location).searchParams;
}

/** POSTs a form */
export async function postForm(url: string, form: Record<string, string> | URLSearchParams, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers),
        body: form instanceof URLSearchParams ? form : new URLSearchParams(form)
    });
}

/** POST /token, with the JSON answer */
export async function token(
    issuer: string,
    form: Record<string, string>,
    headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await postForm(issuer + '/token', form, headers);
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
}

/** Authorization request parameters of a public client with PKCE */
export function request(client: string, challenge: string, extra: Record<string, string> = {}): Record<string, string> {
    return Object.assign(
        {
            response_type: 'code',
            client_id: client,
            redirect_uri: REDIRECT,
            scope: 'openid email profile offline_access mail',
            state: 'state-1',
            code_challenge: challenge,
            code_challenge_method: 'S256'
        },
        extra
    );
}

/**
 * A whole sign-in of an approving client: authorize, then exchange the code
 *
 * @return {Promise<Object>} the token response
 */
export async function signIn(ctx: OAuthContext, extra: Record<string, string> = {}, client = 'imapkit-approve'): Promise<any> {
    const { verifier, challenge } = pkce();
    const params = request(client, challenge, Object.assign({ login_hint: 'alice@example.com' }, extra));
    const code = redirectParams(await authorize(ctx.issuer, params)).get('code');
    if (!code) {
        throw new Error('No code');
    }
    const answer = await token(ctx.issuer, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: params.redirect_uri,
        client_id: client,
        code_verifier: verifier
    });
    return answer.body;
}

/** Replays IMAP commands, the transcript goes through the response guardrail */
export function imap(ctx: OAuthContext, commands: string[]): Promise<string> {
    return new Promise(resolve => mockClient(ctx.imapPort, 'localhost', commands, false, (resp: Buffer) => validateThen(resp, () => resolve(resp.toString()))));
}

/** The XOAUTH2 initial response */
export function xoauth2(user: string, accessToken: string): string {
    return Buffer.from('user=' + user + '\x01auth=Bearer ' + accessToken + '\x01\x01').toString('base64');
}

/** The claims of a JWT, after checking its signature against the JWKS of the issuer */
export async function verifyJwt(issuer: string, jwt: string): Promise<Record<string, any>> {
    const [header, payload, signature] = jwt.split('.');
    const jwks = (await (await fetch(issuer + '/jwks')).json()) as any;
    const key = crypto.createPublicKey({ key: jwks.keys[0], format: 'jwk' });
    if (!crypto.verify('sha256', Buffer.from(header + '.' + payload), key, Buffer.from(signature, 'base64url'))) {
        throw new Error('Bad JWT signature');
    }
    if (JSON.parse(Buffer.from(header, 'base64url').toString()).kid !== jwks.keys[0].kid) {
        throw new Error('Unknown kid');
    }
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
}
