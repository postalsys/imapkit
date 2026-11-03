---
title: Authentication
sidebar_position: 3
description: Users and credentials, LOGIN, AUTHENTICATE PLAIN, XOAUTH2 and OAUTHBEARER, LOGINDISABLED, STARTTLS and implicit TLS with the bundled certificate, UNAUTHENTICATE, and users at runtime.
---

# Authentication

ImapKit is a single mailbox tree server: every user who logs in sees the same mailboxes. Users exist so that clients can test their login code, and so that the ACL plugin can tell the owner apart from other users (see [Access control](../extensions/access-control.md)).

## Users

Without a `users` option there is one account:

| User name  | Password   | Access token (XOAUTH2, OAUTHBEARER) |
| ---------- | ---------- | ----------------------------------- |
| `testuser` | `testpass` | `testtoken`                         |

The `users` option replaces this list. Each key is a user name, each value takes a `password` and an optional `xoauth2` object with the `accessToken` for XOAUTH2 and OAUTHBEARER:

```javascript title="users.js"
import imapkit from 'imapkit';

const server = imapkit({
    plugins: ['AUTH-PLAIN', 'SASL-IR', 'XOAUTH2', 'OAUTHBEARER', 'UNAUTHENTICATE'],
    users: {
        alice: { password: 'wonderland', xoauth2: { accessToken: 'alice-token' } },
        bob: { password: 'builder' }
    }
});
```

`testuser` is not added when `users` is set, so here only `alice` and `bob` can log in, and only `alice` has an access token. User names are Unicode strings, in `users`, in SASL exchanges and in ACL identifiers.

For a client that runs the whole OAuth sign-in, with a browser, real expiry, refresh and revocation, turn on the [OAuth provider](./oauth.md): its tokens log in through the same mechanisms, and the static token keeps working next to them.

The `xoauth2` object also takes a `sessionTimeout` (milliseconds, default one hour). It is deprecated: ImapKit keeps it from hoodiecrow, stores and lists it, but never uses it, access tokens do not expire. To test how a client handles an expired token, replace the token with [`control.updateUser()`](#users-at-runtime): a login with the old token then fails like an expired one.

## LOGIN

LOGIN is always available, unless the LOGINDISABLED plugin turns it off on plain connections. A wrong user name or password is answered with `NO [AUTHENTICATIONFAILED]` ([RFC 5530 section 3](https://www.rfc-editor.org/rfc/rfc5530#section-3)):

```text
C: A2 LOGIN testuser testpass
S: A2 NO [AUTHENTICATIONFAILED] Login failed: authentication failure
C: A3 LOGIN bob builder
S: A3 OK User logged in
```

LOGIN takes exactly two strings (atoms, quoted strings or literals). 8-bit user names or passwords are answered with BAD, because a client MUST use AUTHENTICATE for UTF-8 credentials ([RFC 9755 section 5](https://www.rfc-editor.org/rfc/rfc9755#section-5)).

## Mechanisms

AUTHENTICATE mechanisms come from plugins. AUTHENTICATE with a mechanism that no loaded plugin provides is answered with NO ([RFC 3501 section 6.2.2](https://www.rfc-editor.org/rfc/rfc3501#section-6.2.2)). After login every AUTHENTICATE is BAD, whatever the mechanism, as the command is only valid in the Not Authenticated state ([RFC 3501 section 6.2](https://www.rfc-editor.org/rfc/rfc3501#section-6.2)). With AUTH-PLAIN loaded:

```text
C: A1 AUTHENTICATE FOO
S: A1 NO Unsupported authentication mechanism
C: A2 LOGIN testuser testpass
S: A2 OK User logged in
C: A3 AUTHENTICATE FOO
S: A3 BAD AUTHENTICATE FOO is not allowed in the Authenticated state
C: A4 AUTHENTICATE PLAIN
S: A4 BAD AUTHENTICATE PLAIN is not allowed in the Authenticated state
```

The mechanism plugins:

| Plugin      | Capability         | Notes                                                                                                                                   |
| ----------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-PLAIN  | `AUTH=PLAIN`       | [RFC 4616](https://www.rfc-editor.org/rfc/rfc4616). The initial response needs SASL-IR.                                                 |
| SASL-IR     | `SASL-IR`          | [RFC 4959](https://www.rfc-editor.org/rfc/rfc4959), lets a client send the first response with the AUTHENTICATE command.                |
| XOAUTH2     | `AUTH=XOAUTH2`     | [Gmail's XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol). Needs SASL-IR loaded and used (Gmail does not). |
| OAUTHBEARER | `AUTH=OAUTHBEARER` | [RFC 7628](https://www.rfc-editor.org/rfc/rfc7628), with or without SASL-IR.                                                            |

The `AUTH=` capabilities are only advertised before login. Invalid base64 in a client response is answered with BAD. In PLAIN and OAUTHBEARER, `*` instead of a response cancels the exchange, also with BAD ([RFC 3501 section 6.2.2](https://www.rfc-editor.org/rfc/rfc3501#section-6.2.2)).

### AUTHENTICATE PLAIN

The message is `authzid NUL authcid NUL password`, base64 encoded. With SASL-IR it can go on the command line, otherwise the client waits for the empty continuation request:

```text
C: A5 AUTHENTICATE PLAIN AGFsaWNlAHdvbmRlcmxhbmQ=
S: A5 OK User logged in
```

```text
C: A1 AUTHENTICATE PLAIN
S: +
C: AGJvYgBidWlsZGVy
S: A1 OK User logged in
```

An initial response without SASL-IR is answered with BAD, as RFC 4959 only allows it when the server advertises SASL-IR. The message must be valid UTF-8 ([RFC 4616 section 2](https://www.rfc-editor.org/rfc/rfc4616#section-2)). The authzid must be empty or the same as the user name, acting as another user is answered with `NO [AUTHORIZATIONFAILED]`.

### XOAUTH2

XOAUTH2 takes `user=<name>^Aauth=Bearer <token>^A^A` (`^A` is the octet `0x01`), base64 encoded, as the initial response:

```text
C: A1 AUTHENTICATE XOAUTH2 dXNlcj1hbGljZQFhdXRoPUJlYXJlciBhbGljZS10b2tlbgEB
S: A1 OK User logged in
```

A wrong token gets Gmail's JSON error as a continuation request. The client answers it (usually with an empty line) and the server fails the login:

```text
C: A1 AUTHENTICATE XOAUTH2 dXNlcj1hbGljZQFhdXRoPUJlYXJlciB3cm9uZwEB
S: + eyJzdGF0dXMiOiI0MDAiLCJzY2hlbWVzIjoiQmVhcmVyIiwic2NvcGUiOiJodHRwczovL21haWwuZ29vZ2xlLmNvbS8ifQ==
C:
S: A1 NO [AUTHENTICATIONFAILED] SASL authentication failed
```

The continuation decodes to `{"status":"400","schemes":"Bearer","scope":"https://mail.google.com/"}`. An unknown user is answered with `NO [AUTHENTICATIONFAILED]` right away. Without SASL-IR loaded, AUTHENTICATE XOAUTH2 is answered with BAD.

### OAUTHBEARER

OAUTHBEARER takes a GS2 header and key/value pairs ([RFC 7628 section 3.1](https://www.rfc-editor.org/rfc/rfc7628#section-3.1)). The authzid in the header (`n,a=alice,`) is optional, without it the user is found by the token:

```text
C: A1 AUTHENTICATE OAUTHBEARER bixhPWFsaWNlLAFhdXRoPUJlYXJlciBhbGljZS10b2tlbgEB
S: A1 OK SASL authentication succeeded
```

A failed login gets the JSON error result as a continuation request (`invalid_token` or `invalid_request`). The client MUST answer it with a single `0x01` octet, `AQ==` in base64 ([RFC 7628 section 3.2.3](https://www.rfc-editor.org/rfc/rfc7628#section-3.2.3)):

```text
C: A1 AUTHENTICATE OAUTHBEARER biwsAWF1dGg9QmVhcmVyIGV4cGlyZWQBAQ==
S: + eyJzdGF0dXMiOiJpbnZhbGlkX3Rva2VuIn0=
C: AQ==
S: A1 NO [AUTHENTICATIONFAILED] SASL authentication failed
```

The continuation decodes to `{"status":"invalid_token"}`. Anything other than `AQ==` after the error result is answered with BAD, and so is a client response that breaks the RFC 7628 or GS2 ([RFC 5801](https://www.rfc-editor.org/rfc/rfc5801)) grammar. Channel binding (`p=...`) is not supported and fails with `invalid_request`.

## TLS

### STARTTLS and LOGINDISABLED

The STARTTLS plugin adds the STARTTLS command to plain connections. The LOGINDISABLED plugin advertises `LOGINDISABLED` and answers LOGIN on a plain connection with `NO [PRIVACYREQUIRED]` ([RFC 3501 section 6.2.3](https://www.rfc-editor.org/rfc/rfc3501#section-6.2.3), [RFC 5530 section 3](https://www.rfc-editor.org/rfc/rfc5530#section-3)). Together they force a client to upgrade before it logs in:

```text
S: * OK ImapKit ready for rumble
C: A1 CAPABILITY
S: * CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED
S: A1 OK Completed
C: A2 LOGIN testuser testpass
S: A2 NO [PRIVACYREQUIRED] Run STARTTLS first
C: A3 STARTTLS
S: A3 OK Server ready to start TLS negotiation
<TLS handshake>
C: A4 CAPABILITY
S: * CAPABILITY IMAP4rev1
S: A4 OK Completed
C: A5 LOGIN testuser testpass
S: A5 OK User logged in
```

LOGINDISABLED only affects LOGIN, AUTHENTICATE mechanisms keep working on plain connections. STARTTLS with more commands pipelined after it is answered with BAD, and the pipelined commands are refused without running ([RFC 9051 section 6.2.1](https://www.rfc-editor.org/rfc/rfc9051#section-6.2.1)). The IMAP4rev2 plugin does not load STARTTLS or LOGINDISABLED, load them yourself when you need them.

### Implicit TLS

`secureConnection: true` makes the server accept TLS connections only (port 993 style). On the command line, `--secure` does the same and makes 993 the default port.

```javascript title="secure.js"
import fs from 'node:fs';
import imapkit from 'imapkit';
import { ImapFlow } from 'imapflow';

// the bundled self-signed certificate is in the cert/ directory of the package
const ca = fs.readFileSync(new URL('cert/server.crt', import.meta.resolve('imapkit/package.json')));

const server = imapkit({ secureConnection: true });
const port = await server.start();

const client = new ImapFlow({
    host: 'localhost',
    port,
    secure: true,
    tls: { ca },
    auth: { user: 'testuser', pass: 'testpass' },
    logger: false
});
await client.connect();
console.log(client.secureConnection); // true
await client.logout();
await server.stop();
```

### Certificates

Both STARTTLS and `secureConnection` use the `credentials` option, `{ key, cert }` in PEM (strings or Buffers), for example `credentials: { key: fs.readFileSync('server.key'), cert: fs.readFileSync('server.crt') }`.

Without it, ImapKit uses a bundled self-signed certificate. It is issued to `localhost` and valid for the names `localhost`, `127.0.0.1` and `::1`. The package ships it as `cert/server.crt` (with `cert/server.key`), so a client can trust it with a `ca` option as above, or skip verification in tests (`rejectUnauthorized: false` in Node.js).

## UNAUTHENTICATE

The UNAUTHENTICATE plugin ([RFC 8437](https://www.rfc-editor.org/rfc/rfc8437)) returns a session to the Not Authenticated state, so a client can log in as another user on the same connection:

```text
C: A3 LOGIN bob builder
S: A3 OK User logged in
C: A4 UNAUTHENTICATE
S: A4 OK Completed, now in not authenticated state
C: A5 AUTHENTICATE PLAIN AGFsaWNlAHdvbmRlcmxhbmQ=
S: A5 OK User logged in
```

The selected mailbox is closed without expunging, ENABLEd extensions and CONDSTORE are turned off, and COMPRESS ends after the tagged OK ([RFC 8437 section 4.1](https://www.rfc-editor.org/rfc/rfc8437#section-4.1)). TLS stays. UNAUTHENTICATE takes no arguments and is BAD before login.

## Users at runtime

The control API changes the user list while the server runs, see [Users and sessions](../control-api/users-and-sessions.md):

```javascript title="runtime-users.js"
server.control.addUser('carol', { password: 'secret', xoauth2: { accessToken: 'carol-token' } });
server.control.updateUser('testuser', { password: 'changed' });
console.log(server.control.listUsers());
// [ { name: 'carol', xoauth2: true }, { name: 'testuser', xoauth2: true } ]

server.control.deleteUser('carol');
```

`addUser` throws an `ImapKitError` with code `ALREADYEXISTS` for an existing user. `deleteUser` disconnects the sessions of that user with an untagged BYE, unless you pass `{ disconnect: false }`:

```text
C: A1 LOGIN carol secret
S: A1 OK User logged in
S: * BYE User was deleted
```

The REST API has the same operations, see [REST API endpoints](../rest-api/endpoints.md).
