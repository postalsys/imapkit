// The OAuth 2.0 / OpenID Connect provider (src/oauth/): discovery, the authorization endpoint with its decision
// ladder and consent page, the token, revocation and userinfo endpoints, and the rules it is strict about

import { describe, it } from 'node:test';
import assert from 'node:assert';
import imapkit from '../src/server.js';
import { redirectMatches } from '../src/oauth/provider.js';
import { REDIRECT, authorize, pkce, postForm, redirectParams, request, setupOAuth, signIn, token, users, verifyJwt } from './helpers/oauth.js';

describe('OAuth discovery and pages', () => {
    const ctx = setupOAuth(() => ({ users: users() }));

    it('serves the discovery document at both well-known paths (OpenID Connect Discovery 1.0, RFC 8414)', async () => {
        for (const path of ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server']) {
            const res = await fetch(ctx.issuer + path);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
            const doc = (await res.json()) as any;
            assert.strictEqual(doc.issuer, ctx.issuer);
            assert.match(ctx.issuer, /^http:\/\/127\.0\.0\.1:\d+$/);
            assert.strictEqual(doc.token_endpoint, ctx.issuer + '/token');
            assert.deepStrictEqual(doc.code_challenge_methods_supported, ['S256']);
            assert.deepStrictEqual(doc.response_types_supported, ['code']);
            assert.strictEqual(doc.authorization_response_iss_parameter_supported, true);
            assert.ok(doc.scopes_supported.includes('mail'));
        }
    });

    it('serves the signing key and an index page with the clients', async () => {
        const jwks = (await (await fetch(ctx.issuer + '/jwks')).json()) as any;
        assert.strictEqual(jwks.keys.length, 1);
        assert.strictEqual(jwks.keys[0].kty, 'RSA');
        assert.strictEqual(jwks.keys[0].alg, 'RS256');
        const res = await fetch(ctx.issuer + '/');
        const html = await res.text();
        assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
        assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
        assert.match(html, /imapkit-approve/);
        assert.match(html, /ImapKit test client \(always denies\)/);
        assert.match(html, /NOT A REAL SIGN-IN/);
    });

    it('answers unknown paths with 404, wrong methods with 405 and CORS preflights with 204', async () => {
        assert.strictEqual((await fetch(ctx.issuer + '/nope')).status, 404);
        assert.strictEqual((await fetch(ctx.issuer + '/token')).status, 405);
        const preflight = await fetch(ctx.issuer + '/token', { method: 'OPTIONS' });
        assert.strictEqual(preflight.status, 204);
        assert.match(preflight.headers.get('access-control-allow-headers') || '', /Authorization/);
    });

    it('has no users named like Object.prototype properties', async () => {
        const query = redirectParams(await authorize(ctx.issuer, request('imapkit-approve', pkce().challenge, { login_hint: 'constructor' })));
        assert.strictEqual(query.get('error'), 'access_denied');
        assert.strictEqual(ctx.server.getUser('__proto__'), false);
    });

    it('refuses a host name that is not loopback (DNS rebinding)', async () => {
        const http = await import('node:http');
        const status = await new Promise<number>(resolve => {
            http.get(ctx.issuer + '/.well-known/openid-configuration', { headers: { Host: 'evil.example.com' } }, res => {
                res.resume();
                resolve(res.statusCode || 0);
            });
        });
        assert.strictEqual(status, 421);
    });
});

describe('OAuth authorization code flow', () => {
    const ctx = setupOAuth(() => ({ users: users() }));

    it('approves, redirects with code, state and iss, and exchanges the code for tokens', async () => {
        const { verifier, challenge } = pkce();
        const params = request('imapkit-approve', challenge, { login_hint: 'alice@example.com', nonce: 'n-1' });
        const res = await authorize(ctx.issuer, params);
        assert.strictEqual(res.status, 302);
        const query = redirectParams(res);
        assert.strictEqual(new URL(res.headers.get('location')!).origin + new URL(res.headers.get('location')!).pathname, REDIRECT);
        assert.strictEqual(query.get('state'), 'state-1');
        // RFC 9207 section 2
        assert.strictEqual(query.get('iss'), ctx.issuer);

        const answer = await token(ctx.issuer, {
            grant_type: 'authorization_code',
            code: query.get('code')!,
            redirect_uri: REDIRECT,
            client_id: 'imapkit-approve',
            code_verifier: verifier
        });
        assert.strictEqual(answer.status, 200);
        assert.strictEqual(answer.headers.get('cache-control'), 'no-store');
        assert.strictEqual(answer.body.token_type, 'Bearer');
        assert.strictEqual(answer.body.expires_in, 3600);
        assert.strictEqual(answer.body.scope, 'openid email profile offline_access mail');
        assert.ok(answer.body.refresh_token);
        const claims = await verifyJwt(ctx.issuer, answer.body.id_token);
        assert.strictEqual(claims.iss, ctx.issuer);
        assert.strictEqual(claims.aud, 'imapkit-approve');
        assert.strictEqual(claims.sub, 'alice@example.com');
        assert.strictEqual(claims.email, 'alice@example.com');
        assert.strictEqual(claims.email_verified, true);
        assert.strictEqual(claims.name, 'Alice Example');
        assert.strictEqual(claims.nonce, 'n-1');
        assert.strictEqual(claims.exp - claims.iat, 3600);
        assert.ok(ctx.events.some(event => event.type === 'authorize' && event.source === 'client imapkit-approve'));
    });

    it('issues no refresh token without offline_access, and no ID token without openid (OpenID Connect Core 1.0 section 11)', async () => {
        const body = await signIn(ctx, { scope: 'mail' });
        assert.ok(body.access_token);
        assert.strictEqual(body.refresh_token, undefined);
        assert.strictEqual(body.id_token, undefined);
        const withEmail = await signIn(ctx, { scope: 'openid email' });
        const claims = await verifyJwt(ctx.issuer, withEmail.id_token);
        assert.strictEqual(claims.name, undefined);
        assert.strictEqual(claims.nonce, undefined);
    });

    it('denies with access_denied, state and iss for a denying client', async () => {
        const query = redirectParams(await authorize(ctx.issuer, request('imapkit-deny', pkce().challenge)));
        assert.strictEqual(query.get('error'), 'access_denied');
        assert.strictEqual(query.get('state'), 'state-1');
        assert.strictEqual(query.get('iss'), ctx.issuer);
        assert.match(query.get('error_description')!, /client imapkit-deny/);
    });

    it('takes the first user without login_hint, and refuses a login_hint that is not a user', async () => {
        const body = await signIn(ctx, { login_hint: '' });
        const claims = await verifyJwt(ctx.issuer, body.id_token);
        assert.strictEqual(claims.sub, 'testuser');
        const query = redirectParams(await authorize(ctx.issuer, request('imapkit-approve', pkce().challenge, { login_hint: 'nobody@example.com' })));
        assert.strictEqual(query.get('error'), 'access_denied');
        assert.match(query.get('error_description')!, /nobody@example\.com/);
    });

    it('keeps the query of a redirect URI and accepts POST authorization requests with 303', async () => {
        ctx.server.control.setOAuthClient('app', { redirectUris: ['https://app.example.com/cb?tenant=1'], consent: 'approve', secret: 's3cret' });
        const res = await postForm(ctx.issuer + '/authorize', {
            response_type: 'code',
            client_id: 'app',
            scope: 'mail',
            state: 's'
        });
        assert.strictEqual(res.status, 303);
        const location = new URL(res.headers.get('location')!);
        assert.strictEqual(location.origin + location.pathname, 'https://app.example.com/cb');
        assert.strictEqual(location.searchParams.get('tenant'), '1');
        assert.ok(location.searchParams.get('code'));
    });
});

describe('OAuth decision ladder', () => {
    const ctx = setupOAuth(() => ({ users: users(), oauth: { consent: 'approve' } }));
    const decision = async (client: string, extra: Record<string, string> = {}) => {
        const query = redirectParams(await authorize(ctx.issuer, request(client, pkce().challenge, extra)));
        return query.get('error') || (query.get('code') ? 'code' : 'none');
    };

    it('uses the server default, then the client, then the user, then a queued decision', async () => {
        assert.strictEqual(await decision('imapkit'), 'code');
        assert.strictEqual(await decision('imapkit-deny'), 'access_denied');
        // bob@example.com has consent: deny
        assert.strictEqual(await decision('imapkit', { login_hint: 'bob@example.com' }), 'access_denied');
        assert.strictEqual(await decision('imapkit-approve', { login_hint: 'bob@example.com' }), 'access_denied');
        ctx.server.control.queueOAuthDecision({ decision: 'approve', user: 'bob@example.com' });
        assert.strictEqual(await decision('imapkit-deny', { login_hint: 'bob@example.com' }), 'code');
        assert.strictEqual(await decision('imapkit-deny', { login_hint: 'bob@example.com' }), 'access_denied');
    });

    it('consumes a queued decision count times, only for its client', async () => {
        ctx.server.control.queueOAuthDecision({ decision: { error: 'temporarily_unavailable', description: 'Try later' }, client: 'imapkit', count: 2 });
        assert.strictEqual(await decision('imapkit-approve'), 'code');
        assert.strictEqual(await decision('imapkit'), 'temporarily_unavailable');
        assert.strictEqual(ctx.server.control.listOAuthDecisions()[0].remaining, 1);
        assert.strictEqual(await decision('imapkit'), 'temporarily_unavailable');
        assert.strictEqual(await decision('imapkit'), 'code');
        ctx.server.control.queueOAuthDecision({ decision: 'deny' });
        ctx.server.control.clearOAuthDecisions();
        assert.strictEqual(await decision('imapkit'), 'code');
    });

    it('breaks the redirect on purpose: wrong-state, wrong-iss, no-redirect', async () => {
        ctx.server.control.queueOAuthDecision({ decision: 'wrong-state' });
        let query = redirectParams(await authorize(ctx.issuer, request('imapkit', pkce().challenge)));
        assert.ok(query.get('code'));
        assert.notStrictEqual(query.get('state'), 'state-1');
        ctx.server.control.queueOAuthDecision({ decision: 'wrong-iss' });
        query = redirectParams(await authorize(ctx.issuer, request('imapkit', pkce().challenge)));
        assert.strictEqual(query.get('iss'), 'https://wrong-issuer.invalid');
        ctx.server.control.queueOAuthDecision({ decision: 'no-redirect' });
        const res = await authorize(ctx.issuer, request('imapkit', pkce().challenge));
        assert.strictEqual(res.status, 200);
        assert.match(await res.text(), /Not redirecting/);
    });

    it('answers prompt=none with consent_required when the policy is prompt (OpenID Connect Core 1.0 section 3.1.2.1)', async () => {
        ctx.server.control.setOAuthConsent('prompt');
        assert.strictEqual(await decision('imapkit', { prompt: 'none' }), 'consent_required');
        // a server policy wins over prompt=consent
        assert.strictEqual(await decision('imapkit-approve', { prompt: 'consent' }), 'code');
    });
});

describe('OAuth consent page', () => {
    const ctx = setupOAuth(() => ({ users: users() }));

    const open = async (extra: Record<string, string> = {}) => {
        const res = await authorize(ctx.issuer, request('imapkit', pkce().challenge, extra));
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        const id = /name="request" value="([^"]+)"/.exec(html)![1];
        return { res, html, id };
    };

    it('shows the client, the accounts with login_hint chosen, the scopes and the checks', async () => {
        const { res, html } = await open({ login_hint: 'alice@example.com', access_type: 'offline' });
        assert.match(html, /ImapKit test client wants to access your mailbox/);
        assert.match(html, /value="alice@example\.com" checked/);
        assert.match(html, /auto: deny/);
        assert.match(html, /Read, send and manage your mail over IMAP and SMTP/);
        assert.match(html, /PKCE S256 code challenge/);
        assert.match(html, /ignored parameters: access_type/);
        assert.match(html, /NOT A REAL SIGN-IN/);
        // browsers check form-action on the redirect after the form too
        assert.match(res.headers.get('content-security-policy') || '', /form-action 'self' http:\/\/127\.0\.0\.1:5000/);
    });

    it('warns about a missing state and a login_hint that is not a user', async () => {
        const { html } = await open({ state: '', login_hint: 'ghost@example.com' });
        assert.match(html, /no state/);
        assert.match(html, /ghost@example\.com&quot; is not a user/);
        assert.match(html, /<details open>/);
    });

    it('allows with the chosen account and answers 303 (RFC 9700 section 4.12)', async () => {
        const { verifier, challenge } = pkce();
        const html = await (await authorize(ctx.issuer, request('imapkit', challenge))).text();
        const id = /name="request" value="([^"]+)"/.exec(html)![1];
        const res = await postForm(ctx.issuer + '/authorize/decision', { request: id, action: 'allow', user: 'alice@example.com' });
        assert.strictEqual(res.status, 303);
        const query = redirectParams(res);
        const answer = await token(ctx.issuer, {
            grant_type: 'authorization_code',
            code: query.get('code')!,
            redirect_uri: REDIRECT,
            client_id: 'imapkit',
            code_verifier: verifier
        });
        assert.strictEqual((await verifyJwt(ctx.issuer, answer.body.id_token)).sub, 'alice@example.com');
        // the request is answered
        const again = await postForm(ctx.issuer + '/authorize/decision', { request: id, action: 'allow', user: 'alice@example.com' });
        assert.strictEqual(again.status, 400);
        assert.match(await again.text(), /no longer open/);
    });

    it('denies, sends other outcomes and remembers a choice for the client', async () => {
        let { id } = await open();
        let query = redirectParams(await postForm(ctx.issuer + '/authorize/decision', { request: id, action: 'deny' }));
        assert.strictEqual(query.get('error'), 'access_denied');

        ({ id } = await open());
        query = redirectParams(
            await postForm(ctx.issuer + '/authorize/decision', {
                request: id,
                action: 'outcome',
                user: 'testuser',
                outcome: 'error:server_error',
                description: 'Boom'
            })
        );
        assert.strictEqual(query.get('error'), 'server_error');
        assert.strictEqual(query.get('error_description'), 'Boom');

        ({ id } = await open());
        query = redirectParams(
            await postForm(ctx.issuer + '/authorize/decision', { request: id, action: 'outcome', user: 'testuser', outcome: 'wrong-state' })
        );
        assert.ok(query.get('code'));
        assert.notStrictEqual(query.get('state'), 'state-1');

        ({ id } = await open());
        await postForm(ctx.issuer + '/authorize/decision', { request: id, action: 'allow', user: 'testuser', remember: 'on' });
        assert.strictEqual(ctx.server.control.listOAuthClients().find((client: any) => client.id === 'imapkit').consent, 'approve');
        assert.ok(redirectParams(await authorize(ctx.issuer, request('imapkit', pkce().challenge))).get('code'));
    });

    it('refuses an unknown user, an unknown action, an unknown outcome and a cross-origin form', async () => {
        const { id } = await open();
        assert.match(await (await postForm(ctx.issuer + '/authorize/decision', { request: id, action: 'allow', user: 'nobody' })).text(), /Choose an account/);
        assert.match(await (await postForm(ctx.issuer + '/authorize/decision', { request: id, action: 'jump' })).text(), /Unknown action/);
        assert.match(
            await (await postForm(ctx.issuer + '/authorize/decision', { request: id, action: 'outcome', user: 'testuser', outcome: 'fly' })).text(),
            /Unknown outcome/
        );
        const foreign = await postForm(
            ctx.issuer + '/authorize/decision',
            { request: id, action: 'allow', user: 'testuser' },
            { Origin: 'https://evil.example.com' }
        );
        assert.strictEqual(foreign.status, 403);
        // the page opened on another loopback name of the same port, the Host header names it too
        const port = new URL(ctx.issuer).port;
        const http = await import('node:http');
        const status = await new Promise<number>(resolve => {
            const req = http.request(
                ctx.issuer + '/authorize/decision',
                {
                    method: 'POST',
                    headers: { Host: 'localhost:' + port, Origin: 'http://localhost:' + port, 'Content-Type': 'application/x-www-form-urlencoded' }
                },
                res => {
                    res.resume();
                    resolve(res.statusCode || 0);
                }
            );
            req.end('request=unknown&action=deny');
        });
        assert.strictEqual(status, 400, 'not refused for its origin, the request is unknown');
        // still open after the refusals
        assert.strictEqual((await postForm(ctx.issuer + '/authorize/decision', { request: id, action: 'allow', user: 'testuser' })).status, 303);
        assert.strictEqual(
            (await fetch(ctx.issuer + '/authorize/decision', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status,
            415
        );
    });
});

describe('OAuth authorization request errors', () => {
    const ctx = setupOAuth(() => ({ users: users(), oauth: { consent: 'approve' } }));
    const page = async (params: Record<string, string>) => {
        const res = await authorize(ctx.issuer, params);
        assert.strictEqual(res.status, 400, 'no redirect');
        assert.strictEqual(res.headers.get('location'), null);
        return res.text();
    };
    const redirected = async (params: Record<string, string>) => {
        const query = redirectParams(await authorize(ctx.issuer, params));
        assert.strictEqual(query.get('iss'), ctx.issuer);
        return [query.get('error'), query.get('error_description')];
    };

    it('shows an error page and does not redirect for a bad client or redirect URI (RFC 6749 section 4.1.2.1)', async () => {
        const challenge = pkce().challenge;
        assert.match(await page(request('', challenge)), /no client_id/);
        assert.match(await page(request('unknown', challenge)), /Unknown client_id &quot;unknown&quot;[\s\S]*imapkit-approve/);
        assert.match(await page(request('imapkit', challenge, { redirect_uri: 'https://evil.example.com/cb' })), /not registered for imapkit/);
        assert.match(await page(request('imapkit', challenge, { redirect_uri: REDIRECT + '#frag' })), /has a fragment/);
        assert.match(await page(request('imapkit', challenge, { redirect_uri: '' })), /no redirect_uri/);
        const params = new URLSearchParams(request('imapkit', challenge));
        params.append('client_id', 'imapkit');
        const res = await fetch(ctx.issuer + '/authorize?' + params, { redirect: 'manual' });
        assert.strictEqual(res.status, 400);
    });

    it('redirects with the error for other problems', async () => {
        const { challenge } = pkce();
        assert.deepStrictEqual((await redirected(request('imapkit', challenge, { response_type: '' })))[0], 'invalid_request');
        assert.deepStrictEqual((await redirected(request('imapkit', challenge, { response_type: 'token' })))[0], 'unsupported_response_type');
        assert.deepStrictEqual((await redirected(request('imapkit', challenge, { response_mode: 'fragment' })))[0], 'invalid_request');
        assert.deepStrictEqual((await redirected(request('imapkit', challenge, { request: 'eyJ' })))[0], 'request_not_supported');
        assert.deepStrictEqual((await redirected(request('imapkit', challenge, { request_uri: 'https://x' })))[0], 'request_uri_not_supported');
        assert.deepStrictEqual((await redirected(request('imapkit', challenge, { prompt: 'none consent' })))[0], 'invalid_request');
        assert.deepStrictEqual((await redirected(request('imapkit', challenge, { prompt: 'sometimes' })))[0], 'invalid_request');
        const params = new URLSearchParams(request('imapkit', challenge));
        params.append('scope', 'mail');
        const query = redirectParams(await fetch(ctx.issuer + '/authorize?' + params, { redirect: 'manual' }));
        assert.match(query.get('error_description')!, /scope sent more than once/);
    });

    it('is strict about scopes (RFC 6749 section 3.3)', async () => {
        const { challenge } = pkce();
        const [missing, missingText] = await redirected(request('imapkit', challenge, { scope: '' }));
        assert.strictEqual(missing, 'invalid_scope');
        assert.match(missingText!, /no default scope/);
        const [unknown, unknownText] = await redirected(request('imapkit', challenge, { scope: 'mail https://mail.google.com/' }));
        assert.strictEqual(unknown, 'invalid_scope');
        assert.match(unknownText!, /https:\/\/mail\.google\.com\//);
        assert.strictEqual((await redirected(request('imapkit', challenge, { scope: 'mail "quoted"' })))[0], 'invalid_scope');
    });

    it('requires PKCE S256 from public clients (RFC 9700 section 2.1.1, RFC 7636 sections 4.2 and 4.3)', async () => {
        const { challenge } = pkce();
        const [noPkce, noPkceText] = await redirected(request('imapkit', '', { code_challenge_method: '' }));
        assert.strictEqual(noPkce, 'invalid_request');
        assert.match(noPkceText!, /public clients must use PKCE/);
        const [noMethod, noMethodText] = await redirected(request('imapkit', challenge, { code_challenge_method: '' }));
        assert.strictEqual(noMethod, 'invalid_request');
        assert.match(noMethodText!, /missing, which means plain/);
        assert.match((await redirected(request('imapkit', challenge, { code_challenge_method: 'plain' })))[1]!, /must use it/);
        assert.match((await redirected(request('imapkit', challenge, { code_challenge_method: 'S512' })))[1]!, /Unknown code_challenge_method/);
        assert.match((await redirected(request('imapkit', 'short')))[1]!, /Invalid code_challenge/);
        assert.match((await redirected(request('imapkit', '', { code_challenge_method: 'S256' })))[1]!, /without code_challenge/);
    });
});

describe('OAuth options', () => {
    it('drops unknown scopes with unknownScopes: drop and accepts plain PKCE with allowPlainPkce', async () => {
        const server = imapkit({ oauth: { consent: 'approve', unknownScopes: 'drop', allowPlainPkce: true, scopes: { extra: 'Extra access' } } });
        await server.start(0, '127.0.0.1');
        try {
            const issuer = server.oauth!.issuer;
            const verifier = pkce().verifier;
            const params = request('imapkit', verifier, { code_challenge_method: 'plain', scope: 'mail extra unknown' });
            const code = redirectParams(await authorize(issuer, params)).get('code')!;
            const answer = await token(issuer, {
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT,
                client_id: 'imapkit',
                code_verifier: verifier
            });
            assert.strictEqual(answer.body.scope, 'mail extra');
            const doc = (await (await fetch(issuer + '/.well-known/openid-configuration')).json()) as any;
            assert.deepStrictEqual(doc.code_challenge_methods_supported, ['S256', 'plain']);
        } finally {
            await server.stop();
        }
    });

    it('refuses invalid options', () => {
        assert.throws(() => imapkit({ oauth: { consent: 'maybe' } } as any), /oauth.consent must be/);
        assert.throws(() => imapkit({ oauth: { codeTtl: 601 } }), /at most 600/);
        assert.throws(() => imapkit({ oauth: { accessTokenTtl: -1 } }), /positive number/);
        assert.throws(() => imapkit({ oauth: { unknownScopes: 'keep' } } as any), /unknownScopes/);
        assert.throws(() => imapkit({ oauth: { refreshTokens: 'never' } } as any), /refreshTokens/);
        assert.throws(() => imapkit({ oauth: { mailScope: 'two words' } }), /mailScope/);
        assert.throws(() => imapkit({ oauth: { scopes: { 'a b': 'x' } } }), /scope tokens/);
        assert.throws(() => imapkit({ oauth: { issuer: 'ftp://x' } }), /oauth.issuer/);
        assert.throws(() => imapkit({ oauth: { clients: { app: { redirectUris: ['/relative'] } } } }), /absolute URI/);
        assert.throws(() => imapkit({ oauth: { clients: { app: { redirectUris: [] } } } }), /non-empty list/);
        assert.throws(() => imapkit({ oauth: { clients: { app: { secret: '' } } } }), /secret/);
        assert.throws(() => imapkit({ oauth: { clients: { app: { name: '' } } } }), /name/);
        assert.throws(() => imapkit({ oauth: { signingKey: 'not a key' } }));
        assert.throws(() => imapkit({ users: { a: { oauth: { consent: 'later' } } } } as any), /users\["a"\]\.oauth\.consent/);
        assert.throws(() => imapkit({ users: { a: { oauth: 'deny' } } } as any), /must be \{ consent \}/);
    });

    it('uses the issuer option and a fixed signing key', async () => {
        const crypto = await import('node:crypto');
        const signingKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
        const server = imapkit({ oauth: { issuer: 'https://idp.example.com/', signingKey } });
        await server.start(0, '127.0.0.1');
        try {
            assert.strictEqual(server.oauth!.issuer, 'https://idp.example.com');
            const port = (server.oauthServer!.address() as { port: number }).port;
            const doc = (await (await fetch('http://127.0.0.1:' + port + '/.well-known/openid-configuration')).json()) as any;
            assert.strictEqual(doc.authorization_endpoint, 'https://idp.example.com/authorize');
            const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
            assert.throws(() => imapkit({ oauth: { signingKey: ec } }), /RSA/);
        } finally {
            await server.stop();
        }
    });

    it('serves HTTPS with the bundled certificate', async () => {
        const https = await import('node:https');
        const fs = await import('node:fs');
        const server = imapkit({ oauth: { secure: true } });
        await server.start(0, '127.0.0.1');
        try {
            assert.match(server.oauth!.issuer, /^https:\/\/127\.0\.0\.1:\d+$/);
            const ca = fs.readFileSync(new URL('../cert/server.crt', import.meta.url));
            const body = await new Promise<string>((resolve, reject) => {
                https
                    .get(server.oauth!.issuer + '/.well-known/openid-configuration', { ca }, res => {
                        let data = '';
                        res.on('data', chunk => (data += chunk));
                        res.on('end', () => resolve(data));
                    })
                    .on('error', reject);
            });
            assert.strictEqual(JSON.parse(body).issuer, server.oauth!.issuer);
        } finally {
            await server.stop();
        }
    });

    it('matches loopback redirect URIs with any port (RFC 8252 section 7.3) and others exactly', () => {
        assert.ok(redirectMatches('http://127.0.0.1/cb', 'http://127.0.0.1:61234/cb'));
        assert.ok(!redirectMatches('http://127.0.0.1/cb', 'http://127.0.0.1:61234/other'));
        assert.ok(redirectMatches('http://127.0.0.1/*', 'http://127.0.0.1:61234/any/path?x=1'));
        assert.ok(!redirectMatches('http://127.0.0.1/*', 'https://127.0.0.1:61234/'));
        assert.ok(redirectMatches('http://127.0.0.1:8000/cb', 'http://127.0.0.1:8000/cb'));
        assert.ok(!redirectMatches('http://127.0.0.1:8000/cb', 'http://127.0.0.1:8001/cb'));
        assert.ok(redirectMatches('com.example.app:/oauth', 'com.example.app:/oauth'));
        assert.ok(!redirectMatches('https://app.example.com/cb', 'https://app.example.com/cb/'));
        assert.ok(redirectMatches('https://app.example.com/*', 'https://app.example.com/cb/x'));
        assert.ok(!redirectMatches('https://app.example.com/cb', 'not a url'));
    });
});
