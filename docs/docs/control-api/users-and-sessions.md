---
title: Users and Sessions
sidebar_position: 4
description: Manage user accounts at runtime, list connected sessions, disconnect them, write raw bytes to them, reset the server between tests and shut it down.
---

# Users and sessions

These methods of `server.control` manage accounts and connected sessions, and control the server's lifecycle. All users share the same mailbox tree, see [Authentication](../guides/authentication.md) for how users log in.

## Users

### listUsers()

```typescript
listUsers(): { name: string; xoauth2: boolean }[]
```

Lists the users ordered by name, without credentials. `xoauth2` is true for a user with an access token for XOAUTH2 and OAUTHBEARER.

```javascript
server.control.listUsers();
// [ { name: 'testuser', xoauth2: true } ]
```

### addUser(name, options)

```typescript
addUser(name: string, options: { password?: string; xoauth2?: { accessToken: string; sessionTimeout?: number } }): void
```

| Parameter                        | Description                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                           | user name, a non-empty string                                                                                                                                              |
| `options.password`               | password for the LOGIN command and AUTHENTICATE PLAIN                                                                                                                      |
| `options.xoauth2.accessToken`    | access token for XOAUTH2 and OAUTHBEARER                                                                                                                                   |
| `options.xoauth2.sessionTimeout` | deprecated and ignored, stored with the token in milliseconds, default 3600000. ImapKit does not expire tokens, replace the token with `updateUser` to test an expired one |
| `options.displayName`            | display name, the `name` claim of the [OAuth provider](../guides/oauth.md)                                                                                                 |
| `options.oauth.consent`          | consent policy of sign-ins that name the user in `login_hint`, see [Choosing the outcome](../guides/oauth.md#choosing-the-outcome)                                         |

**Errors:** `INVALID` for an empty name, a password that is not a string, an `xoauth2` without an `accessToken` string, a `displayName` that is not a string or an unknown consent policy, `ALREADYEXISTS` for an existing user.

```javascript
server.control.addUser('alice', { password: 'secret' });
server.control.addUser('bob', { password: 'pw', xoauth2: { accessToken: 'tok' } });
server.control.listUsers();
// [ { name: 'alice', xoauth2: false }, { name: 'bob', xoauth2: true }, { name: 'testuser', xoauth2: true } ]
```

### updateUser(name, options)

```typescript
updateUser(name: string, options: { password?: string; xoauth2?: { accessToken: string; sessionTimeout?: number } | null }): void
```

Changes the password, the access token, the display name or the OAuth consent policy of a user. Options that are not given stay as they are, `xoauth2: null`, `displayName: null` and `oauth: null` remove them. Sessions that are logged in already stay logged in. Use it to test how a client handles a password change or an expired token on its next login.

**Errors:** `NONEXISTENT` for an unknown user, `INVALID` as for `addUser()`.

### deleteUser(name, options)

```typescript
deleteUser(name: string, options?: { disconnect?: boolean }): void
```

Deletes a user. Its sessions are disconnected with `* BYE User was deleted`, unless `disconnect` is `false`. The mailboxes stay, as they are shared by all users.

**Errors:** `NONEXISTENT` for an unknown user.

## Sessions

### sessions()

```typescript
sessions(): SessionInfo[]
```

Describes the connected sessions, ordered by session number. Every connection gets a number when it is accepted, counting from 1 for the life of the server. A `SessionInfo` has these fields:

| Field           | Type             | Description                                                      |
| --------------- | ---------------- | ---------------------------------------------------------------- |
| `session`       | `number`         | session number                                                   |
| `user`          | `string \| null` | the logged in user, null before login                            |
| `state`         | `string`         | `Not Authenticated`, `Authenticated`, `Selected` or `Logout`     |
| `mailbox`       | `string \| null` | storage name of the selected mailbox                             |
| `readOnly`      | `boolean`        | true if the mailbox was opened with EXAMINE                      |
| `enabled`       | `string[]`       | extensions enabled with ENABLE, e.g. `CONDSTORE`                 |
| `secure`        | `boolean`        | true for a TLS connection (`secureConnection` or after STARTTLS) |
| `compressed`    | `boolean`        | true after COMPRESS DEFLATE                                      |
| `remoteAddress` | `string \| null` | the client's address                                             |

```javascript
server.control.sessions();
```

```javascript
[
    {
        session: 1,
        user: 'testuser',
        state: 'Selected',
        mailbox: 'INBOX',
        readOnly: false,
        enabled: ['CONDSTORE'],
        secure: false,
        compressed: false,
        remoteAddress: '::ffff:127.0.0.1'
    }
];
```

The same objects are in the `session` field of the [session events](./events.md#session).

### disconnect(filter, options)

```typescript
disconnect(filter: number | { session?: number; user?: string }, options?: { text?: string; reset?: boolean }): number
```

Disconnects the sessions a filter selects: a session number, or `{ session, user }` (both must match when both are given). Returns how many sessions were disconnected, 0 if none matched. Sessions that are closing already are not counted.

| Option  | Description                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------- |
| `text`  | text of the untagged BYE, default `Disconnected by the server`                                                  |
| `reset` | true closes the TCP connection with a reset (RST) and sends nothing, like a crashed server or a dropped network |

```javascript
server.control.disconnect(2, { text: 'Go away' });
// session 2 receives: * BYE Go away
server.control.disconnect({ user: 'testuser' }, { reset: true });
// the client sees ECONNRESET
```

**Errors:** `INVALID` for a filter with neither `session` nor `user`.

### inject(session, data)

```typescript
inject(session: number, data: string | Uint8Array): void
```

Writes bytes to a session as they are. A string is encoded as UTF-8. Nothing checks that the bytes are valid IMAP, so you can send anything: an `ALERT`, an unexpected `EXISTS`, a `BYE` without closing the connection, or broken syntax.

```javascript
server.control.inject(1, '* OK [ALERT] Maintenance in 5 minutes\r\n');
```

An idling client receives the line right away. Since the bytes are not tied to any command, prefer [scripted faults](../faults/scripted-faults.md) to change the response of a particular command.

**Errors:** `NONEXISTENT` for a session that is not connected, `INVALID` for data that is neither a string nor bytes.

## Server lifecycle

### reset()

```typescript
reset(): void
```

Restores the mailboxes and users of the server options and disconnects every session with `* BYE Server reset`. Plugins restore their own state on the `reset` [event](./events.md#reset): QUOTA its limits, METADATA its server annotations. Script rules stay, `server.script.clear()` removes them.

Use it to reuse one long running server between tests, for example a server started with the `imapkit` command and reset with `POST /v1/reset` before every test.

### shutdown(options)

```typescript
shutdown(options?: { graceful?: boolean }): Promise<void>
```

Stops the server. A graceful shutdown (the default) stops accepting connections, closes the SMTP and REST listeners, and resolves once the last client has disconnected on its own. `graceful: false` closes every session right away.

```javascript
const done = server.control.shutdown();
// new connections are refused, the connected client logs out
await done;
```

### server.start(port, host) and server.stop()

These are methods of the server itself, not of `server.control`:

```typescript
server.start(port?: number, host?: string): Promise<number>
server.stop(): Promise<void>
```

`start()` listens on `port` (a free port when it is not set) and `host` (all addresses when it is not set), starts the SMTP listener of the `smtp` option and the REST API of the `rest` option, and resolves with the IMAP port. It rejects if the port is taken. `stop()` is `shutdown({ graceful: false })`: it closes every session and resolves when the server is closed.

```javascript
const server = imapkit({ rest: { port: 0 } });
const port = await server.start();
const restPort = server.restServer.address().port;
// ...
await server.stop();
```

`server.listen()` and `server.close()` from earlier versions still work, but only `start()` starts the SMTP and REST listeners. See [Server API](../reference/server-api.md).
