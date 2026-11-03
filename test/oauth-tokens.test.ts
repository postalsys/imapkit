// The tokens of the OAuth provider (src/oauth/): the token endpoint and its rules, refresh and rotation,
// revocation, userinfo, expiry on the server clock, logins over IMAP (XOAUTH2, OAUTHBEARER) and SMTP (AUTH
// XOAUTH2), and the control and REST APIs of the provider

import { describe, it } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import tls from 'node:tls';
import { REDIRECT, authorize, imap, pkce, postForm, redirectParams, request, setupOAuth, signIn, token, users, verifyJwt, xoauth2 } from './helpers/oauth.js';
import type { OAuthContext } from './helpers/oauth.js';

/** An approved authorization code with its verifier */
async function approvedCode(ctx: OAuthContext, client = 'imapkit-approve', extra: Record<string, string> = {}) {
    const { verifier, challenge } = pkce();
    const code = redirectParams(await authorize(ctx.issuer, request(client, challenge, Object.assign({ login_hint: 'alice@example.com' }, extra)))).get(
        'code'
    )!;
    return { code, verifier };
}

const exchange = (code: string, verifier: string, client = 'imapkit-approve') => ({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: client,
    code_verifier: verifier
});

describe('OAuth token endpoint', () => {
    const ctx = setupOAuth(() => ({
        users: users(),
        oauth: {
            clients: {
                'imapkit-approve': { consent: 'approve' },
                other: { consent: 'approve' },
                confidential: { secret: 'p@ss word', consent: 'approve' }
            }
        }
    }));

    it('refuses bodies that are not form encoded, repeated parameters and unknown grants', async () => {
        const json = await fetch(ctx.issuer + '/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.strictEqual(json.status, 415);
        assert.strictEqual(((await json.json()) as any).error, 'invalid_request');
        const repeated = await postForm(ctx.issuer + '/token', new URLSearchParams('grant_type=x&grant_type=y'));
        assert.match(((await repeated.json()) as any).error_description, /grant_type sent more than once/);
        assert.strictEqual((await token(ctx.issuer, { client_id: 'other' })).body.error, 'invalid_request');
        assert.strictEqual((await token(ctx.issuer, { client_id: 'other', grant_type: 'password' })).body.error, 'unsupported_grant_type');
    });

    it('authenticates clients (RFC 6749 section 2.3)', async () => {
        const unknown = await token(ctx.issuer, { grant_type: 'refresh_token', client_id: 'nobody' });
        assert.deepStrictEqual([unknown.status, unknown.body.error], [401, 'invalid_client']);
        assert.strictEqual((await token(ctx.issuer, { grant_type: 'refresh_token' })).body.error, 'invalid_client');
        const publicSecret = await token(ctx.issuer, { grant_type: 'refresh_token', client_id: 'other', client_secret: 'x' });
        assert.match(publicSecret.body.error_description, /public client/);
        assert.match((await token(ctx.issuer, { grant_type: 'refresh_token', client_id: 'confidential' })).body.error_description, /must send its secret/);
        assert.match(
            (await token(ctx.issuer, { grant_type: 'refresh_token', client_id: 'confidential', client_secret: 'nope' })).body.error_description,
            /Wrong client secret/
        );

        // client_secret_basic: form encoded, then base64 (RFC 6749 section 2.3.1)
        const basic = 'Basic ' + Buffer.from('confidential:p%40ss+word').toString('base64');
        const viaBasic = await token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: 'x' }, { Authorization: basic });
        assert.strictEqual(viaBasic.body.error, 'invalid_grant');
        const wrongBasic = await token(
            ctx.issuer,
            { grant_type: 'refresh_token' },
            { Authorization: 'Basic ' + Buffer.from('confidential:wrong').toString('base64') }
        );
        assert.strictEqual(wrongBasic.status, 401);
        assert.strictEqual(wrongBasic.headers.get('www-authenticate'), 'Basic realm="imapkit"');
        const both = await token(ctx.issuer, { grant_type: 'refresh_token', client_secret: 'p@ss word' }, { Authorization: basic });
        assert.match(both.body.error_description, /only one method/);
        assert.strictEqual(
            (await token(ctx.issuer, { grant_type: 'refresh_token', client_id: 'other' }, { Authorization: basic })).body.error,
            'invalid_request'
        );
        assert.strictEqual((await token(ctx.issuer, { grant_type: 'refresh_token' }, { Authorization: 'Bearer x' })).body.error, 'invalid_request');
        assert.strictEqual(
            (await token(ctx.issuer, { grant_type: 'refresh_token' }, { Authorization: 'Basic ' + Buffer.from('nocolon').toString('base64') })).status,
            401
        );
        const viaPost = await token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'confidential', client_secret: 'p@ss word' });
        assert.strictEqual(viaPost.body.error, 'invalid_grant');
    });

    it('lets a confidential client sign in without PKCE, with a warning on the consent page', async () => {
        const query = redirectParams(
            await authorize(ctx.issuer, { response_type: 'code', client_id: 'confidential', redirect_uri: REDIRECT, scope: 'mail', state: 's' })
        );
        const answer = await token(ctx.issuer, {
            grant_type: 'authorization_code',
            code: query.get('code')!,
            redirect_uri: REDIRECT,
            client_id: 'confidential',
            client_secret: 'p@ss word'
        });
        assert.strictEqual(answer.status, 200);
    });

    it('checks the code: client, redirect_uri, PKCE, a second use revokes the first tokens (RFC 6749 sections 4.1.2 and 4.1.3)', async () => {
        const { code, verifier } = await approvedCode(ctx);
        assert.strictEqual((await token(ctx.issuer, exchange(code, verifier, 'other'))).body.error, 'invalid_grant');
        const missingRedirect = await token(ctx.issuer, Object.assign(exchange(code, verifier), { redirect_uri: '' }));
        assert.match(missingRedirect.body.error_description, /redirect_uri is missing/);
        const otherRedirect = await token(ctx.issuer, Object.assign(exchange(code, verifier), { redirect_uri: 'http://127.0.0.1:5001/cb' }));
        assert.match(otherRedirect.body.error_description, /differs/);
        assert.match(
            (await token(ctx.issuer, Object.assign(exchange(code, verifier), { code_verifier: '' }))).body.error_description,
            /code_verifier is missing/
        );
        assert.match((await token(ctx.issuer, Object.assign(exchange(code, verifier), { code_verifier: 'short' }))).body.error_description, /43 to 128/);
        assert.match((await token(ctx.issuer, exchange(code, pkce().verifier))).body.error_description, /does not match/);
        assert.strictEqual((await token(ctx.issuer, Object.assign(exchange(code, verifier), { code: '' }))).body.error, 'invalid_request');
        assert.match((await token(ctx.issuer, exchange('unknown', verifier))).body.error_description, /Unknown authorization code/);

        const first = await token(ctx.issuer, exchange(code, verifier));
        assert.strictEqual(first.status, 200);
        const second = await token(ctx.issuer, exchange(code, verifier));
        assert.match(second.body.error_description, /used already/);
        const tokens = ctx.server.control.listOAuthTokens({ user: 'alice@example.com' });
        assert.ok(tokens.length >= 2 && tokens.every((item: any) => item.revoked));
        assert.ok(ctx.events.some(event => event.type === 'revoke' && event.reason === 'authorization code reused'));
    });

    it('refuses a code_verifier when the request had no code_challenge (RFC 9700 section 2.1.1)', async () => {
        const query = redirectParams(
            await authorize(ctx.issuer, { response_type: 'code', client_id: 'confidential', redirect_uri: REDIRECT, scope: 'mail', state: 's' })
        );
        const answer = await token(ctx.issuer, {
            grant_type: 'authorization_code',
            code: query.get('code')!,
            redirect_uri: REDIRECT,
            client_id: 'confidential',
            client_secret: 'p@ss word',
            code_verifier: pkce().verifier
        });
        assert.match(answer.body.error_description, /downgrade|without a code_challenge/);
    });

    it('refreshes, keeps the refresh token without rotation and refuses a wider scope (RFC 6749 section 6)', async () => {
        const body = await signIn(ctx);
        const refreshed = await token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: 'imapkit-approve' });
        assert.strictEqual(refreshed.status, 200);
        assert.notStrictEqual(refreshed.body.access_token, body.access_token);
        assert.strictEqual(refreshed.body.refresh_token, undefined);
        assert.strictEqual(refreshed.body.id_token, undefined);
        const narrower = await token(ctx.issuer, {
            grant_type: 'refresh_token',
            refresh_token: body.refresh_token,
            client_id: 'imapkit-approve',
            scope: 'mail'
        });
        assert.strictEqual(narrower.body.scope, 'mail');
        const wider = await token(ctx.issuer, {
            grant_type: 'refresh_token',
            refresh_token: body.refresh_token,
            client_id: 'imapkit-approve',
            scope: 'mail other'
        });
        assert.strictEqual(wider.body.error, 'invalid_scope');
        assert.strictEqual(
            (await token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: 'other' })).body.error,
            'invalid_grant'
        );
        assert.strictEqual((await token(ctx.issuer, { grant_type: 'refresh_token', client_id: 'other' })).body.error, 'invalid_request');
        assert.match(
            (await token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: body.access_token, client_id: 'imapkit-approve' })).body.error_description,
            /Unknown/
        );
        ctx.server.control.deleteUser('alice@example.com');
        assert.match(
            (await token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: 'imapkit-approve' })).body.error_description,
            /does not exist/
        );
    });

    it('revokes (RFC 7009): a refresh token takes its access tokens along, unknown tokens are fine', async () => {
        const body = await signIn(ctx);
        const revoke = (form: Record<string, string>) => postForm(ctx.issuer + '/revoke', form);
        assert.strictEqual((await revoke({ client_id: 'imapkit-approve', token: 'unknown' })).status, 200);
        assert.strictEqual((await revoke({ client_id: 'imapkit-approve' })).status, 400);
        assert.strictEqual((await revoke({ client_id: 'other', token: body.refresh_token })).status, 400);
        assert.strictEqual((await revoke({ client_id: 'imapkit-approve', token: body.refresh_token, token_type_hint: 'refresh_token' })).status, 200);
        const userinfo = await fetch(ctx.issuer + '/userinfo', { headers: { Authorization: 'Bearer ' + body.access_token } });
        assert.strictEqual(userinfo.status, 401);
        assert.match(userinfo.headers.get('www-authenticate') || '', /error="invalid_token", error_description="The access token is revoked"/);
        const refresh = await token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: 'imapkit-approve' });
        assert.match(refresh.body.error_description, /revoked/);
        const second = await signIn(ctx);
        assert.strictEqual((await revoke({ client_id: 'imapkit-approve', token: second.access_token })).status, 200);
        assert.strictEqual(
            (await token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: 'imapkit-approve' })).status,
            200,
            'revoking an access token leaves the refresh token'
        );
    });

    it('answers userinfo (OpenID Connect Core 1.0 section 5.3)', async () => {
        const body = await signIn(ctx);
        for (const method of ['GET', 'POST']) {
            const res = await fetch(ctx.issuer + '/userinfo', { method, headers: { Authorization: 'Bearer ' + body.access_token } });
            assert.deepStrictEqual(await res.json(), { sub: 'alice@example.com', email: 'alice@example.com', email_verified: true, name: 'Alice Example' });
        }
        const mailOnly = await signIn(ctx, { scope: 'mail' });
        const forbidden = await fetch(ctx.issuer + '/userinfo', { headers: { Authorization: 'Bearer ' + mailOnly.access_token } });
        assert.strictEqual(forbidden.status, 403);
        assert.strictEqual((await fetch(ctx.issuer + '/userinfo')).status, 401);
        const refreshAsAccess = await fetch(ctx.issuer + '/userinfo', { headers: { Authorization: 'Bearer ' + body.refresh_token } });
        assert.strictEqual(refreshAsAccess.status, 401);
    });
});

describe('OAuth token lifetimes', () => {
    let clock = Date.parse('2026-11-03T10:00:00Z');
    const ctx = setupOAuth(() => ({
        users: users(),
        plugins: ['SASL-IR', 'XOAUTH2'],
        now: () => clock,
        oauth: { consent: 'approve', accessTokenTtl: 600, codeTtl: 30, rotateRefreshTokens: true, refreshTokens: 'always' }
    }));

    it('lets access tokens and codes expire on the server clock', async () => {
        const body = await signIn(ctx, { scope: 'mail' }, 'imapkit');
        assert.strictEqual(body.expires_in, 600);
        assert.ok(body.refresh_token, 'refreshTokens: always');
        const login = (answer: string[]) => imap(ctx, ['A1 AUTHENTICATE XOAUTH2 ' + xoauth2('alice@example.com', body.access_token), ...answer, 'A2 LOGOUT']);
        assert.match(await login([]), /^A1 OK/m);
        clock += 600 * 1000;
        // the client answers the JSON error result with an empty line
        assert.match(await login(['']), /^A1 NO \[AUTHENTICATIONFAILED\]/m);
        assert.ok(ctx.events.some(event => event.type === 'access' && event.reason === 'the access token is expired'));

        const { code, verifier } = await approvedCode(ctx, 'imapkit');
        clock += 31 * 1000;
        assert.match((await token(ctx.issuer, exchange(code, verifier, 'imapkit'))).body.error_description, /expired/);
    });

    it('forgets tokens a day after they expired or were revoked', async () => {
        const body = await signIn(ctx, { scope: 'mail' }, 'imapkit');
        ctx.server.control.revokeOAuthTokens({ token: body.refresh_token });
        assert.strictEqual(ctx.server.control.listOAuthTokens().length, 2);
        // a day after the access token expired
        clock += (24 * 3600 + 600) * 1000;
        // the next request prunes
        await token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: 'imapkit' });
        assert.deepStrictEqual(ctx.server.control.listOAuthTokens(), []);
    });

    it('rotates refresh tokens, and reuse of a rotated one revokes the grant (RFC 9700 section 4.14.2)', async () => {
        const body = await signIn(ctx, { scope: 'mail' }, 'imapkit');
        const refresh = (refreshToken: string) => token(ctx.issuer, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'imapkit' });
        const first = await refresh(body.refresh_token);
        assert.ok(first.body.refresh_token);
        assert.notStrictEqual(first.body.refresh_token, body.refresh_token);
        const reused = await refresh(body.refresh_token);
        assert.match(reused.body.error_description, /rotation/);
        assert.strictEqual((await refresh(first.body.refresh_token)).body.error, 'invalid_grant');
    });
});

describe('OAuth tokens for IMAP and SMTP', () => {
    const ctx = setupOAuth(() => ({ users: users(), plugins: ['SASL-IR', 'XOAUTH2', 'OAUTHBEARER'], smtp: { port: 0 }, oauth: { consent: 'approve' } }));

    it('logs in with XOAUTH2 for the token owner only, and needs the mail scope', async () => {
        const body = await signIn(ctx);
        const ok = await imap(ctx, ['A1 AUTHENTICATE XOAUTH2 ' + xoauth2('alice@example.com', body.access_token), 'A2 LOGOUT']);
        assert.match(ok, /^A1 OK/m);
        const otherUser = await imap(ctx, ['A1 AUTHENTICATE XOAUTH2 ' + xoauth2('testuser', body.access_token), '', 'A2 LOGOUT']);
        assert.match(otherUser, /^A1 NO \[AUTHENTICATIONFAILED\]/m);
        // the error result names the scope of the provider
        const json = JSON.parse(Buffer.from(/^\+ (\S+)/m.exec(otherUser)![1], 'base64').toString());
        assert.deepStrictEqual(json, { status: '400', schemes: 'Bearer', scope: 'mail' });

        const noMail = await signIn(ctx, { scope: 'openid email' });
        assert.match(await imap(ctx, ['A1 AUTHENTICATE XOAUTH2 ' + xoauth2('alice@example.com', noMail.access_token), '', 'A2 LOGOUT']), /^A1 NO/m);
        assert.ok(ctx.events.some(event => event.type === 'access' && event.result === 'insufficient_scope'));
        // the static token of the users option still works
        assert.match(await imap(ctx, ['A1 AUTHENTICATE XOAUTH2 ' + xoauth2('testuser', 'testtoken'), 'A2 LOGOUT']), /^A1 OK/m);
    });

    it('logs in with OAUTHBEARER, finds the user by the token and points to discovery on failure (RFC 7628 section 3.2.2)', async () => {
        const body = await signIn(ctx);
        const response = (authzid: string, accessToken: string) =>
            Buffer.from('n,' + authzid + ',\x01auth=Bearer ' + accessToken + '\x01\x01').toString('base64');
        const ok = await imap(ctx, ['A1 AUTHENTICATE OAUTHBEARER ' + response('', body.access_token), 'A2 LOGOUT']);
        assert.match(ok, /^A1 OK/m);
        assert.match(await imap(ctx, ['A1 AUTHENTICATE OAUTHBEARER ' + response('a=alice@example.com', body.access_token), 'A2 LOGOUT']), /^A1 OK/m);
        ctx.server.control.revokeOAuthTokens({ user: 'alice@example.com' });
        const failed = await imap(ctx, ['A1 AUTHENTICATE OAUTHBEARER ' + response('', body.access_token), 'AQ==', 'A2 LOGOUT']);
        assert.match(failed, /^A1 NO \[AUTHENTICATIONFAILED\]/m);
        const json = JSON.parse(Buffer.from(/^\+ (\S+)/m.exec(failed)![1], 'base64').toString());
        assert.deepStrictEqual(json, { status: 'invalid_token', scope: 'mail', 'openid-configuration': ctx.issuer + '/.well-known/openid-configuration' });
    });

    it('offers AUTH XOAUTH2 over SMTP and checks the token', async () => {
        const body = await signIn(ctx);
        const port = (ctx.server.smtpServer!.server.address() as net.AddressInfo).port;
        const transcript = await smtpSession(port, [
            'EHLO client',
            'STARTTLS',
            'EHLO client',
            'AUTH XOAUTH2 ' + xoauth2('alice@example.com', 'wrong'),
            '',
            'AUTH XOAUTH2 ' + xoauth2('alice@example.com', body.access_token),
            'QUIT'
        ]);
        assert.match(transcript, /^250[- ]AUTH PLAIN LOGIN XOAUTH2/m);
        assert.match(transcript, /^334 /m);
        assert.match(transcript, /^535 /m);
        assert.match(transcript, /^235 /m);
        assert.ok(ctx.events.some(event => event.type === 'access' && event.via === 'smtp' && event.result === 'ok'));
    });
});

/** Sends SMTP commands one by one, each after the reply to the previous one. STARTTLS upgrades the connection */
function smtpSession(port: number, commands: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        let socket: net.Socket = net.connect(port, '127.0.0.1');
        let transcript = '';
        let buffer = '';
        let last = '';
        const queue = commands.slice();
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString();
            transcript += chunk.toString();
            // a complete reply ends with a line "ddd text"
            if (!/(^|\r\n)\d{3} [^\r\n]*\r\n$/.test(buffer)) {
                return;
            }
            buffer = '';
            if (last === 'STARTTLS') {
                socket.removeListener('data', onData);
                socket = tls.connect({ socket, rejectUnauthorized: false }, () => send());
                socket.on('data', onData);
                socket.on('error', reject);
                return;
            }
            send();
        };
        const send = () => {
            const next = queue.shift();
            if (next === undefined) {
                socket.end();
                resolve(transcript);
                return;
            }
            last = next;
            socket.write(next + '\r\n');
        };
        socket.on('data', onData);
        socket.on('error', reject);
    });
}

describe('OAuth control and REST API', () => {
    const ctx = setupOAuth(() => ({ users: users(), rest: { port: 0 }, oauth: { consent: 'approve' } }));
    const rest = async (method: string, path: string, body?: unknown) => {
        const base = 'http://127.0.0.1:' + (ctx.server.restServer!.address() as net.AddressInfo).port;
        const init: RequestInit = { method };
        if (body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }
        const res = await fetch(base + path, init);
        return { status: res.status, body: (await res.json()) as any };
    };

    it('manages clients, the default consent and queued decisions', async () => {
        const info = await rest('GET', '/v1/oauth');
        assert.strictEqual(info.body.issuer, ctx.issuer);
        assert.strictEqual(info.body.discovery, ctx.issuer + '/.well-known/openid-configuration');
        assert.deepStrictEqual(
            info.body.clients.map((client: any) => client.id),
            ['imapkit', 'imapkit-approve', 'imapkit-deny']
        );
        const created = await rest('PUT', '/v1/oauth/clients/inbox-classic', { name: 'Inbox Classic', consent: 'deny', secret: 's' });
        assert.deepStrictEqual(created.body, {
            id: 'inbox-classic',
            name: 'Inbox Classic',
            confidential: true,
            redirectUris: ['http://127.0.0.1/*', 'http://localhost/*', 'http://[::1]/*'],
            consent: 'deny'
        });
        assert.strictEqual((await rest('PUT', '/v1/oauth/clients/bad', { redirectUris: 'x' })).status, 400);
        assert.strictEqual((await rest('GET', '/v1/oauth/clients')).body.length, 4);
        assert.deepStrictEqual((await rest('DELETE', '/v1/oauth/clients/inbox-classic')).body, { deleted: true });
        assert.strictEqual((await rest('DELETE', '/v1/oauth/clients/inbox-classic')).status, 404);

        assert.deepStrictEqual((await rest('PUT', '/v1/oauth/consent', { consent: { error: 'server_error' } })).body, { consent: { error: 'server_error' } });
        assert.strictEqual((await rest('PUT', '/v1/oauth/consent', { consent: 'sometimes' })).status, 400);
        assert.strictEqual(redirectParams(await authorize(ctx.issuer, request('imapkit', pkce().challenge))).get('error'), 'server_error');
        await rest('PUT', '/v1/oauth/consent', { consent: 'approve' });

        const queued = await rest('POST', '/v1/oauth/decisions', { decision: 'deny', count: 2 });
        assert.strictEqual(queued.status, 201);
        assert.strictEqual((await rest('GET', '/v1/oauth/decisions')).body[0].remaining, 2);
        assert.strictEqual((await rest('POST', '/v1/oauth/decisions', { decision: 'deny', count: 0 })).status, 400);
        assert.strictEqual((await rest('POST', '/v1/oauth/decisions', { decision: 'deny', user: 1 })).status, 400);
        assert.deepStrictEqual((await rest('DELETE', '/v1/oauth/decisions')).body, { deleted: true });
        assert.deepStrictEqual((await rest('GET', '/v1/oauth/decisions')).body, []);
    });

    it('lists, expires and revokes tokens', async () => {
        const body = await signIn(ctx);
        const listed = await rest('GET', '/v1/oauth/tokens?user=alice@example.com&type=access');
        assert.strictEqual(listed.body.length, 1);
        assert.strictEqual(listed.body[0].token, body.access_token);
        assert.strictEqual(listed.body[0].expired, false);
        assert.deepStrictEqual((await rest('POST', '/v1/oauth/tokens/expire', { user: 'alice@example.com' })).body, { expired: 1 });
        assert.strictEqual((await rest('GET', '/v1/oauth/tokens?type=access')).body[0].expired, true);
        assert.deepStrictEqual((await rest('POST', '/v1/oauth/tokens/revoke', { client: 'imapkit-approve' })).body, { revoked: 2 });
        assert.strictEqual((await rest('GET', '/v1/oauth/tokens?type=other')).status, 400);
        assert.strictEqual((await rest('POST', '/v1/oauth/tokens/revoke', { user: 5 })).status, 400);
    });

    it('queues token endpoint faults: errors, an HTML error page, a delay and changed ID token claims', async () => {
        assert.strictEqual((await rest('POST', '/v1/oauth/token-faults', {})).status, 400);
        assert.strictEqual((await rest('POST', '/v1/oauth/token-faults', { grant: 'password', error: 'x' })).status, 400);
        assert.strictEqual((await rest('POST', '/v1/oauth/token-faults', { status: 200 })).status, 400);
        assert.strictEqual((await rest('POST', '/v1/oauth/token-faults', { delay: -1 })).status, 400);
        assert.strictEqual((await rest('POST', '/v1/oauth/token-faults', { claims: [] })).status, 400);
        assert.strictEqual((await rest('POST', '/v1/oauth/token-faults', { error: 'a"b' })).status, 400);
        assert.strictEqual((await rest('POST', '/v1/oauth/token-faults', { error: 'x', description: 5 })).status, 400);

        const { code, verifier } = await approvedCode(ctx);
        await rest('POST', '/v1/oauth/token-faults', { grant: 'authorization_code', error: 'invalid_grant', description: 'Token has been revoked.' });
        const refused = await token(ctx.issuer, exchange(code, verifier));
        assert.deepStrictEqual(refused.body, { error: 'invalid_grant', error_description: 'Token has been revoked.' });

        await rest('POST', '/v1/oauth/token-faults', { html: true });
        const html = await postForm(ctx.issuer + '/token', exchange(code, verifier));
        assert.strictEqual(html.status, 500);
        assert.match(html.headers.get('content-type') || '', /text\/html/);

        await rest('POST', '/v1/oauth/token-faults', { delay: 50, claims: { aud: 'someone-else', email: null } });
        const started = Date.now();
        const delayed = await token(ctx.issuer, exchange(code, verifier));
        assert.ok(Date.now() - started >= 45);
        const claims = await verifyJwt(ctx.issuer, delayed.body.id_token);
        assert.strictEqual(claims.aud, 'someone-else');
        assert.strictEqual(claims.email, undefined);

        await rest('POST', '/v1/oauth/token-faults', { status: 503, count: 2 });
        assert.strictEqual((await rest('GET', '/v1/oauth')).body.tokenFaults.length, 1);
        await rest('DELETE', '/v1/oauth/token-faults');
        assert.deepStrictEqual((await rest('GET', '/v1/oauth')).body.tokenFaults, []);
    });

    it('takes the display name and consent policy of users, and reset restores clients and forgets tokens', async () => {
        assert.strictEqual(
            (await rest('POST', '/v1/users', { name: 'carol@example.com', password: 'x', displayName: 'Carol', oauth: { consent: 'deny' } })).status,
            201
        );
        assert.strictEqual(
            redirectParams(await authorize(ctx.issuer, request('imapkit', pkce().challenge, { login_hint: 'carol@example.com' }))).get('error'),
            'access_denied'
        );
        await rest('PUT', '/v1/users/carol@example.com', { oauth: null });
        const body = await signIn(ctx, { login_hint: 'carol@example.com' }, 'imapkit');
        assert.strictEqual((await verifyJwt(ctx.issuer, body.id_token)).name, 'Carol');
        await rest('PUT', '/v1/users/carol@example.com', { displayName: null });
        assert.strictEqual(ctx.server.users['carol@example.com'].displayName, undefined);
        assert.strictEqual((await rest('PUT', '/v1/users/carol@example.com', { oauth: { consent: 'x' } })).status, 400);
        assert.strictEqual((await rest('PUT', '/v1/users/carol@example.com', { displayName: 5 })).status, 400);

        ctx.server.control.setOAuthClient('temp', {});
        ctx.server.control.queueOAuthDecision({ decision: 'deny' });
        await rest('POST', '/v1/reset', {});
        const info = ctx.server.control.getOAuthInfo();
        assert.strictEqual(info.clients.length, 3);
        assert.deepStrictEqual(info.decisions, []);
        assert.deepStrictEqual(ctx.server.control.listOAuthTokens(), []);
    });

    it('streams oauth events', async () => {
        const base = 'http://127.0.0.1:' + (ctx.server.restServer!.address() as net.AddressInfo).port;
        const controller = new AbortController();
        const res = await fetch(base + '/v1/events?types=oauth', { signal: controller.signal });
        const reader = res.body!.getReader();
        await reader.read();
        await authorize(ctx.issuer, request('imapkit', pkce().challenge));
        let text = '';
        while (!/event: oauth/.test(text)) {
            text += Buffer.from((await reader.read()).value!).toString();
        }
        controller.abort();
        assert.match(text, /"type":"authorize"/);
    });
});
