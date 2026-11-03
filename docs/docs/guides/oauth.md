---
title: OAuth 2.0 and OpenID Connect
sidebar_position: 4
description: A built-in OAuth 2.0 / OpenID Connect provider for testing the sign-in of a mail client end to end, with a consent page that needs no password, automatic approve and deny policies, real token expiry, refresh, revocation, and faults.
---

# OAuth 2.0 and OpenID Connect

The `oauth` option starts a test identity provider next to the IMAP server. A mail client can run its whole OAuth sign-in against it, get real tokens, log in to IMAP and SMTP with them, and see them expire, be refreshed and be revoked. There are no passwords. A consent policy decides every sign-in: show a consent page where you pick an account and click Allow or Deny, or redirect right away with a code or an error, so unattended tests never stop at a page.

```javascript title="oauth.js"
import imapkit from 'imapkit';

const server = imapkit({
    plugins: ['SASL-IR', 'XOAUTH2', 'OAUTHBEARER'],
    users: {
        'alice@example.com': { password: 'pw', displayName: 'Alice Example' },
        'denied@example.com': { password: 'pw', oauth: { consent: 'deny' } }
    },
    smtp: { port: 2525 },
    oauth: { port: 8085 }
});
await server.start(1143);
console.log(server.oauth.issuer); // http://127.0.0.1:8085
```

On the command line:

```bash
imapkit -p 1143 --plugin=SASL-IR,XOAUTH2,OAUTHBEARER --smtpPort=2525 --oauth-port=8085
```

```text
OAuth provider listening on http://127.0.0.1:8085 (clients: imapkit, imapkit-approve, imapkit-deny; default consent: prompt)
```

Point the client at the discovery document, `http://127.0.0.1:8085/.well-known/openid-configuration`, and use one of the [clients](#clients). Load SASL-IR with XOAUTH2 or OAUTHBEARER, otherwise the IMAP server has no way to take the tokens. The SMTP listener offers `AUTH XOAUTH2` as soon as the provider is on.

## The flow

The provider implements the authorization code flow with PKCE, the flow native apps use ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)):

1. The client starts a listener on a loopback port and opens the system browser at `/authorize?response_type=code&client_id=...&redirect_uri=http://127.0.0.1:53817/&scope=...&state=...&code_challenge=...&code_challenge_method=S256`.
2. ImapKit looks up the `client_id`, checks the request, and decides what to do (see [Choosing the outcome](#choosing-the-outcome)).
3. With the `prompt` policy the browser shows the consent page, otherwise there is no page at all.
4. The browser is redirected to the client's listener with `?code=...&state=...&iss=...`, or with `?error=access_denied&state=...&iss=...`. `iss` is always there ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)).
5. The client sends the code and its PKCE verifier to `/token` and gets an access token, an ID token (with `openid`), and a refresh token (with `offline_access`).
6. The client logs in to IMAP (`AUTHENTICATE XOAUTH2` or `OAUTHBEARER`) or SMTP (`AUTH XOAUTH2`) with the access token.

An automatic decision is a plain HTTP 302 redirect, so a test does not need a browser: it can GET the authorize URL itself and follow the `Location` header to the client's listener.

```javascript title="headless-sign-in.js"
import crypto from 'node:crypto';

const issuer = server.oauth.issuer;
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const redirectUri = 'http://127.0.0.1:5000/callback';

const authorize = await fetch(
    issuer +
        '/authorize?' +
        new URLSearchParams({
            response_type: 'code',
            client_id: 'imapkit-approve',
            redirect_uri: redirectUri,
            scope: 'openid email offline_access mail',
            state: 'xyz',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            login_hint: 'alice@example.com'
        }),
    { redirect: 'manual' }
);
const code = new URL(authorize.headers.get('location')).searchParams.get('code');

const tokens = await (
    await fetch(issuer + '/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: 'imapkit-approve', code_verifier: verifier })
    })
).json();
// { access_token, token_type: 'Bearer', expires_in: 3600, scope, refresh_token, id_token }
```

## Users and the ID token

Users are the `users` of the server, so there is nothing to set up for the provider. The ID token names the user in `sub` and `email`, and both are the user name: clients take the email claim as the IMAP and SMTP user name, so use address-style user names such as `alice@example.com` for OAuth tests. The consent page notes a user name without `@`. A user's `displayName` gives the `name` claim (with the `profile` scope), and `oauth.consent` its [consent policy](#choosing-the-outcome).

| Claim                     | Value                                              |
| ------------------------- | -------------------------------------------------- |
| `iss`                     | the issuer                                         |
| `sub`                     | the user name                                      |
| `aud`, `azp`              | the client ID                                      |
| `iat`, `exp`, `auth_time` | issue time, expiry (`accessTokenTtl`), sign-in     |
| `nonce`                   | the `nonce` of the request, if it had one          |
| `email`, `email_verified` | the user name and `true`, with the `email` scope   |
| `name`                    | the user's `displayName`, with the `profile` scope |

ID tokens are signed with RS256. `/jwks` serves the key, a new 2048 bit key on every start unless `signingKey` gives one. `/userinfo` answers the same claims for an access token with the `openid` scope.

## Clients

A client is registered with the provider ahead of time, and the authorize request only carries its `client_id`: the same way real providers work, where an app is registered in a console and gets its ID there. The consent page shows the client's `name`. Without the `clients` option there are three public clients:

| Client ID         | Name                                | Consent        |
| ----------------- | ----------------------------------- | -------------- |
| `imapkit`         | ImapKit test client                 | server default |
| `imapkit-approve` | ImapKit test client (always allows) | `approve`      |
| `imapkit-deny`    | ImapKit test client (always denies) | `deny`         |

Their redirect URIs are `http://127.0.0.1/*`, `http://localhost/*` and `http://[::1]/*`: any port, any path. The `clients` option replaces them:

```javascript
oauth: {
    clients: {
        'my-mail-app': {
            name: 'My Mail App',
            redirectUris: ['http://127.0.0.1/callback'],
            consent: 'prompt'
        },
        'web-app': {
            name: 'Web App',
            secret: 's3cret',
            redirectUris: ['https://app.example.com/oauth/callback']
        }
    }
}
```

| Option         | Description                                                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | shown on the consent page, the client ID if not set                                                                                                                                                                                                       |
| `secret`       | makes the client confidential: it must authenticate at `/token` and `/revoke` with `client_secret_basic` or `client_secret_post`. A client without a secret is public, must use PKCE, and must not send a secret                                          |
| `redirectUris` | registered redirect URIs, the three loopback patterns above if not set. A loopback `http` URI without a port matches any port ([RFC 8252 section 7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3)), a trailing `*` any rest, others match exactly |
| `consent`      | the client's [consent policy](#choosing-the-outcome), the server default if not set                                                                                                                                                                       |

`control.setOAuthClient(id, options)` registers or replaces a client at runtime, `deleteOAuthClient(id)` removes one.

## Choosing the outcome

Every sign-in takes its decision from the first of these that has one:

1. **A queued decision**, `control.queueOAuthDecision({ decision, client?, user?, count? })`. The next matching sign-in (by client, by the user of `login_hint`) uses it, `count` times (default 1). Best for a test that wants one specific outcome now.
2. **The user** named by `login_hint`, `users[name].oauth.consent`. A client that sends the typed address as `login_hint` then gets the outcome of that account without any client change: type `denied@example.com` to test a denial.
3. **The client**, `clients[id].consent`. "One app always accepts, another always rejects".
4. **The server default**, `oauth.consent` (`--oauth-consent`), `prompt` if not set. `control.setOAuthConsent()` changes it.

A policy is one of:

| Policy                    | What the authorization endpoint does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `'prompt'`                | shows the consent page                                                                                     |
| `'approve'`               | redirects with a code at once                                                                              |
| `'deny'`                  | redirects with `error=access_denied` at once                                                               |
| `{ error, description? }` | redirects with that error, e.g. `{ error: 'temporarily_unavailable' }`, or a provider-specific description |

A queued decision can also break the redirect on purpose: `'wrong-state'` approves but sends another `state`, `'wrong-iss'` another `iss` (a client MUST reject both), and `'no-redirect'` answers with a page and never redirects, to test the client's sign-in timeout.

`approve` signs in the user of `login_hint`, or without one the first user (`testuser` when it exists). A `login_hint` that is not a user is answered with `access_denied`. A server policy wins over the client's `prompt` parameter: `approve` and `deny` redirect at once also for `prompt=consent`, so unattended tests never stop at a page. With the `prompt` policy, `prompt=none` is answered with `consent_required` ([OpenID Connect Core 1.0 section 3.1.2.1](https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest)).

Every decision emits an `oauth` event that says which rung made it (`source`), so a forgotten policy does not look like a broken flow.

## The consent page

The consent page is a test tool's page and says so: a striped "ImapKit test server, not a real sign-in" ribbon, ImapKit's mark, and no password field. It shows the client name, an account picker (the `login_hint` user is chosen, users with a policy of their own are marked), what the scopes allow, and where the browser goes back to. **Allow** is the default button, so the happy path is one click.

- **Remember my choice for this app** sets the client's policy to `approve` or `deny` until the server restarts or [resets](../control-api/users-and-sessions.md#reset).
- **Request details** lists what the request got right and what to look at: PKCE, `state`, `nonce`, the `login_hint` user, scopes, `prompt`, ignored parameters (like Google's `access_type`). It opens by itself when something is worth a look.
- **Other outcomes** answers the sign-in with an error (`access_denied`, `invalid_scope`, `server_error`, `temporarily_unavailable`, `consent_required`, `login_required`, with an optional description) or a broken redirect (`wrong-state`, `wrong-iss`, no redirect).

The page runs no script, can not be framed, follows the system's light or dark theme, and stays open for 10 minutes. The form answers with `303 See Other` ([RFC 9700 section 4.12](https://www.rfc-editor.org/rfc/rfc9700#section-4.12)). The index page at `/` lists the issuer, the clients, the users and the endpoints.

## Scopes

| Scope            | Meaning                                                 |
| ---------------- | ------------------------------------------------------- |
| `mail`           | IMAP and SMTP accept the token (`mailScope` renames it) |
| `openid`         | an ID token                                             |
| `email`          | the `email` and `email_verified` claims                 |
| `profile`        | the `name` claim                                        |
| `offline_access` | a refresh token                                         |

`scopes: { name: 'description' }` adds more, the consent page shows the description. A request without a `scope` is answered with `invalid_scope` (there is no default scope, [RFC 6749 section 3.3](https://www.rfc-editor.org/rfc/rfc6749#section-3.3)), and so is a request for an unknown scope, with the scope named in `error_description`, unless `unknownScopes: 'drop'` grants the known ones. A token without the mail scope logs in to nothing: IMAP and SMTP answer it with `insufficient_scope`.

Refresh tokens are issued only for `offline_access` ([OpenID Connect Core 1.0 section 11](https://openid.net/specs/openid-connect-core-1_0.html#OfflineAccess)). `refreshTokens: 'always'` issues one for every code exchange, like Google's `access_type=offline`. ImapKit's consent policy counts as consent for offline access, so `prompt=consent` is not required for it.

## Tokens

Access tokens expire after `accessTokenTtl` seconds (default 3600) on the server clock, the [`now` option](../faults/repeatable-tests.md), so a test with a fixed clock moves time forward instead of waiting. Codes expire after `codeTtl` seconds (default 60, at most 600). Refresh tokens do not expire, they end when they are revoked.

A refresh keeps the refresh token. With `rotateRefreshTokens: true` every refresh returns a new one, and using a replaced one again revokes the whole grant ([RFC 9700 section 4.14.2](https://www.rfc-editor.org/rfc/rfc9700#section-4.14.2)). `/revoke` ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)) revokes a token of the calling client; a refresh token takes the access tokens of its grant along.

The static `xoauth2.accessToken` of a user (`testtoken` of the default user) keeps working next to the issued tokens and never expires.

| Control API                                        | What it does                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `listOAuthTokens({ user, client, type })`          | issued tokens with `type`, `token`, `user`, `client`, `scope`, `expiresAt`, `expired`, `revoked`, `rotated` |
| `expireOAuthTokens({ user, client, token })`       | lets access tokens expire now, the next login fails like an expired token                                   |
| `revokeOAuthTokens({ user, client, token, type })` | revokes access and refresh tokens                                                                           |

## Logging in with the tokens

IMAP takes the access token with XOAUTH2 and OAUTHBEARER (see [Authentication](./authentication.md#mechanisms)). The token must belong to the user the client logs in as and have the mail scope. Without an authzid, OAUTHBEARER finds the user by the token. A failed OAUTHBEARER login gets the error result of [RFC 7628 section 3.2.2](https://www.rfc-editor.org/rfc/rfc7628#section-3.2.2) with the scope and the discovery URL:

```text
C: A1 AUTHENTICATE OAUTHBEARER biwsAWF1dGg9QmVhcmVyIGV4cGlyZWQBAQ==
S: + eyJzdGF0dXMiOiJpbnZhbGlkX3Rva2VuIiwic2NvcGUiOiJtYWlsIiwib3BlbmlkLWNvbmZpZ3VyYXRpb24iOiJodHRwOi8vMTI3LjAuMC4xOjgwODUvLndlbGwta25vd24vb3BlbmlkLWNvbmZpZ3VyYXRpb24ifQ==
C: AQ==
S: A1 NO [AUTHENTICATIONFAILED] SASL authentication failed
```

The continuation decodes to `{"status":"invalid_token","scope":"mail","openid-configuration":"http://127.0.0.1:8085/.well-known/openid-configuration"}`. XOAUTH2 sends its Gmail style error with the mail scope.

The SMTP listener offers `AUTH XOAUTH2` with the provider on, after STARTTLS like its other mechanisms, and checks the token the same way. A refused token gets the `334` JSON error, and `535` after the client answers it. Passwords are still accepted as before.

Every check emits an `oauth` event of type `access` with `via` (`imap` or `smtp`), `result` and the `reason` of a refusal ("the access token is expired", "the access token is for bob@example.com, not alice@example.com", ...).

## Faults at the token endpoint

`control.queueOAuthTokenFault(fault)` changes the next token request (or `count` of them, for one grant type with `grant`):

| Field                            | Effect                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `error`, `description`, `status` | answers with that OAuth error (status 400 by default), the code stays valid                        |
| `html: true`                     | answers with an HTML error page (status 500 by default), like a provider behind a broken proxy     |
| `delay`                          | waits that many milliseconds first                                                                 |
| `claims`                         | changes claims of the ID token, `null` removes one: `{ aud: 'another-client' }`, `{ email: null }` |

```javascript
server.control.queueOAuthTokenFault({ grant: 'refresh_token', error: 'invalid_grant', description: 'Token has been revoked.' });
```

## Strict by design

The provider is strict where the RFCs say MUST, and every refusal names the rule in `error_description` or on the error page:

| Rule                                                                                                          | Answer                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| unknown `client_id`, unregistered `redirect_uri`, a fragment in it, a missing one when the client has several | error page, no redirect ([RFC 6749 section 4.1.2.1](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.2.1))                                  |
| a parameter sent twice                                                                                        | `invalid_request` ([RFC 6749 section 3.1](https://www.rfc-editor.org/rfc/rfc6749#section-3.1))                                                |
| no `code_challenge` from a public client                                                                      | `invalid_request` ([RFC 9700 section 2.1.1](https://www.rfc-editor.org/rfc/rfc9700#section-2.1.1))                                            |
| `code_challenge_method=plain`, or none (which means plain)                                                    | `invalid_request` ([RFC 7636 sections 4.2 and 4.3](https://www.rfc-editor.org/rfc/rfc7636#section-4.2)), unless `allowPlainPkce`              |
| `response_type` other than `code`, `response_mode` other than `query`                                         | `unsupported_response_type`, `invalid_request`                                                                                                |
| `request` or `request_uri`                                                                                    | `request_not_supported`, `request_uri_not_supported`                                                                                          |
| `prompt=none` with other values, an unknown `prompt` value                                                    | `invalid_request`                                                                                                                             |
| a wrong or missing `code_verifier`, or one without a challenge (PKCE downgrade)                               | `invalid_grant` ([RFC 7636 section 4.6](https://www.rfc-editor.org/rfc/rfc7636#section-4.6))                                                  |
| a code used twice                                                                                             | `invalid_grant`, and the tokens of the first use are revoked ([RFC 6749 section 4.1.2](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.2)) |
| `redirect_uri` at `/token` that differs from the authorization request                                        | `invalid_grant` ([RFC 6749 section 4.1.3](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.3))                                              |
| a token request that is not `application/x-www-form-urlencoded`                                               | `invalid_request` (HTTP 415)                                                                                                                  |
| two client authentication methods, a secret from a public client, a wrong secret                              | `invalid_request`, `invalid_client` ([RFC 6749 section 2.3](https://www.rfc-editor.org/rfc/rfc6749#section-2.3))                              |
| a refresh with a scope beyond the grant                                                                       | `invalid_scope` ([RFC 6749 section 6](https://www.rfc-editor.org/rfc/rfc6749#section-6))                                                      |

## Endpoints

| Endpoint                                                                           | Spec                                                        |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /.well-known/openid-configuration`, `/.well-known/oauth-authorization-server` | OpenID Connect Discovery 1.0, RFC 8414                      |
| `GET`, `POST /authorize`                                                           | RFC 6749 section 4.1, OpenID Connect Core 1.0 section 3.1.2 |
| `POST /authorize/decision`                                                         | the consent page form                                       |
| `POST /token`                                                                      | RFC 6749 sections 4.1.3 and 6, RFC 7636                     |
| `POST /revoke`                                                                     | RFC 7009                                                    |
| `GET`, `POST /userinfo`                                                            | OpenID Connect Core 1.0 section 5.3                         |
| `GET /jwks`                                                                        | RFC 7517                                                    |
| `GET /`                                                                            | index page                                                  |

Not supported: the implicit and hybrid flows (RFC 9700 section 2.1.2), the client credentials and password grants, dynamic client registration, the device authorization grant and logout.

The JSON endpoints allow cross-origin requests, like real providers do for browser-based clients. The pages run no script and can not be framed.

## Access and HTTPS

The provider listens on `127.0.0.1` unless `host` (`--oauth-host`) says otherwise, and bound to a loopback address it only answers requests for a loopback host name or the host of the `issuer` option, so a web page can not rebind its DNS name to it. It hands out tokens for every user without a password, so only listen on another address in a test network.

The issuer is `http://<host>:<port>`. OpenID Connect Discovery requires an `https` issuer, so ImapKit deviates here by default, as a loopback address needs none. `secure: true` (`--oauth-secure`) serves HTTPS with the `credentials` of the server, or the bundled self-signed certificate for `localhost` and `127.0.0.1` ([Certificates](./authentication.md#certificates)). `issuer` (`--oauth-issuer`) sets the public base URL when clients reach the provider through another address, such as a tunnel.

## Options

| Option                | Default                   | Description                                         |
| --------------------- | ------------------------- | --------------------------------------------------- |
| `port`                | a free port               | HTTP port                                           |
| `host`                | `127.0.0.1`               | address to listen on                                |
| `secure`              | `false`                   | HTTPS                                               |
| `issuer`              | `http(s)://host:port`     | public base URL, without a query or fragment        |
| `consent`             | `'prompt'`                | the default [consent policy](#choosing-the-outcome) |
| `clients`             | the three default clients | [registered clients](#clients)                      |
| `scopes`              |                           | more scopes, name to description                    |
| `mailScope`           | `'mail'`                  | the scope IMAP and SMTP logins need                 |
| `unknownScopes`       | `'refuse'`                | `'drop'` grants the known scopes of a request       |
| `refreshTokens`       | `'offline_access'`        | `'always'` issues one for every code exchange       |
| `rotateRefreshTokens` | `false`                   | a new refresh token on every refresh                |
| `accessTokenTtl`      | `3600`                    | access token lifetime in seconds                    |
| `codeTtl`             | `60`                      | code lifetime in seconds, at most 600               |
| `allowPlainPkce`      | `false`                   | accepts `code_challenge_method=plain`               |
| `signingKey`          | a new key                 | RSA private key in PEM for the ID tokens            |

The provider is `server.oauth` (`server.oauth.issuer` once it listens), its HTTP server `server.oauthServer`. The control API operations and their REST routes exist only with the option: `getOAuthInfo()`, `listOAuthClients()`, `setOAuthClient()`, `deleteOAuthClient()`, `setOAuthConsent()`, `queueOAuthDecision()`, `listOAuthDecisions()`, `clearOAuthDecisions()`, `queueOAuthTokenFault()`, `clearOAuthTokenFaults()`, `listOAuthTokens()`, `expireOAuthTokens()` and `revokeOAuthTokens()`, see [REST API endpoints](../rest-api/endpoints.md#oauth). `control.reset()` restores the clients and the default policy of the options and forgets every token, request and queued item. The provider needs Node.js, it is not part of the browser bundle.
