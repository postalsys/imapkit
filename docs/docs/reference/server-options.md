---
title: Server Options
sidebar_position: 1
description: Every option of imapkit(options), including the options that plugins read, with types, defaults and what they change.
---

# Server Options

`imapkit(options)` takes one options object. The server makes a shallow copy of it, and deep copies `storage` and `users`, so the same fixture object can build any number of servers and runtime changes never leak back into it.

```javascript
import imapkit from 'imapkit';

const server = imapkit({
    plugins: ['IDLE', 'MOVE', 'CONDSTORE'],
    storage: { INBOX: { messages: [{ raw: 'Subject: hi\r\n\r\nHello\r\n' }] }, '': {} },
    users: { testuser: { password: 'testpass' } }
});
const port = await server.start();
```

The core options are typed in `IMAPServerOptions` (exported by the package). Plugins read their own options from the same object, so the type also accepts any other key. Options a plugin reads have no effect when that plugin is not loaded.

The `imapkit` command passes its `--config` JSON file to the same factory, so every option on this page also works in a config file. See [Command Line](../getting-started/command-line.md) for the flags and environment variables that set some of them.

## Core

| Option             | Type                                                     | Default                                                           | What it does                                                                                                                                                                                                                                                                                   |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`          | `Record<string, StorageNamespace>`                       | `{ INBOX: {}, '': {} }`                                           | The mailbox tree, keyed by namespace prefix. Checked with `validateStorage()` when the server is built, a typo or wrong type throws with the path of the problem. See [Storage](../guides/storage.md).                                                                                         |
| `plugins`          | `(string \| Plugin)[]`, or a single `string` or `Plugin` | none                                                              | Plugins to load: built-in names (case insensitive, capability spellings like `LITERAL+` work too) or plugin functions. An unknown name throws. A single string is one name, not a comma separated list. See [Extensions](../extensions/overview.md) and [Custom Plugins](./custom-plugins.md). |
| `users`            | `Record<string, UserData>`                               | `testuser` with password `testpass` and XOAUTH2 token `testtoken` | User accounts. Each user is `{ password, xoauth2: { accessToken, sessionTimeout } }`, `sessionTimeout` is deprecated and ignored (access tokens do not expire). Setting this option replaces the default user. See [Authentication](../guides/authentication.md).                              |
| `secureConnection` | `boolean`                                                | `false`                                                           | Implicit TLS: the server accepts only TLS connections (port 993 style).                                                                                                                                                                                                                        |
| `credentials`      | `{ key: string \| Buffer, cert: string \| Buffer }`      | the bundled self-signed certificate for `localhost`               | TLS key and certificate for `secureConnection`, the STARTTLS plugin and the SMTP listener.                                                                                                                                                                                                     |
| `systemFlags`      | `string[]`                                               | `['\\Answered', '\\Flagged', '\\Draft', '\\Deleted', '\\Seen']`   | The system flags that can be stored. A STORE or APPEND with another `\`-flag is refused. Also the default `permanentFlags` of mailboxes that do not set their own.                                                                                                                             |
| `maxLiteralSize`   | `number`                                                 | `67108864` (64 MiB)                                               | Largest literal accepted after login, in octets. A larger literal is answered with `BAD`. Before login the limit is fixed at 64 KiB.                                                                                                                                                           |
| `debug`            | `boolean`                                                | `false`                                                           | Writes client input and every response (`SEND: ...`) to stdout.                                                                                                                                                                                                                                |

## Listeners started by `start()`

`server.start()` starts the IMAP listener and, when these options are set, the implicit TLS, SMTP and REST listeners next to it.

| Option | Type                                               | Default                                    | What it does                                                                                                                                                                                                                                                                                                           |
| ------ | -------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tls`  | `{ port?: number, host?: string }`                 | not started                                | Also listens for implicit TLS (IMAPS) connections, next to the plaintext listener, with the `credentials`. Its sessions share the storage with the main listener and count as encrypted. Port `0` or no port picks a free one, no host listens on the host given to `start()`. The listener is `server.tlsServer`.     |
| `smtp` | `{ port?: number, host?: string }`                 | not started                                | Starts an SMTP server that appends every received message to INBOX. Needs the optional `smtp-server` package (`npm install smtp-server`), `start()` rejects with an error that names it when it is missing. Port `0` or no port picks a free one, no host listens on all addresses. The server is `server.smtpServer`. |
| `rest` | `{ port?: number, host?: string, token?: string }` | not started, host `127.0.0.1` when started | Starts the REST API (the control API over HTTP). A host that is not a loopback address needs a `token`, which requests send as `Authorization: Bearer <token>`. The server is `server.restServer`. See [REST API](../rest-api/overview.md).                                                                            |

## Repeatable tests and faults

| Option       | Type                                       | Default          | What it does                                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script`     | `ScriptRule \| ScriptRule[]`               | none             | Rules that make the server misbehave on purpose. More can be added at runtime with `server.script.add()`. See [Scripted Faults](../faults/scripted-faults.md).                                                                                          |
| `quirks`     | `string[] \| string`                       | none             | Quirk presets that make the server behave like a known real server: `james-fetchgroup`, `james-late-fetch`, `yahoo-quoted-sections`, `m365-throttle`, `no-uidplus`, `no-move`. An unknown name throws. See [Quirk Presets](../faults/quirk-presets.md). |
| `scriptSeed` | `number`                                   | random           | Seed of the random numbers that script rules with `chance` (and the quirk presets that use them) draw, so a run can be repeated. `server.control.reset()` starts the same sequence again.                                                               |
| `now`        | `Date \| number \| (() => Date \| number)` | the current time | The time the server uses for the dates it sets itself: the INTERNALDATE of a message without one, and SAVEDATE. The dates are formatted in the time zone of the process. See [Repeatable Tests](../faults/repeatable-tests.md).                         |

## Plugin options

These options are read by one plugin each, when it is loaded.

### Limits

| Option              | Type               | Default  | Plugin                  | What it does                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------ | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `appendLimit`       | `number` or `null` | no limit | APPENDLIMIT             | Largest message APPEND and REPLACE accept for every mailbox, in octets, advertised as `APPENDLIMIT=<n>`. A non-negative integer, anything else throws. A mailbox in the storage can set its own `appendLimit` instead, then clients read it with `STATUS (APPENDLIMIT)`.                                                                                                       |
| `messageLimit`      | `number`           | `1000`   | MESSAGELIMIT, SAVELIMIT | The `n` of `MESSAGELIMIT=<n>` or `SAVELIMIT=<n>`. Any positive integer, so small test mailboxes can hit it. Anything else throws.                                                                                                                                                                                                                                              |
| `maxSearchContexts` | `number`           | `10`     | CONTEXT=SEARCH          | Updating searches (`RETURN (UPDATE)`) one session may keep. Above it the server answers `NO [NOUPDATE "tag"]`.                                                                                                                                                                                                                                                                 |
| `quota`             | `object`           | `{}`     | QUOTA                   | `{ root, STORAGE, MESSAGE, MAILBOX, soft }`. `root` is the quota root name (default `"User quota"`), `STORAGE` is in units of 1024 octets, a missing resource is not limited. With `soft: true` going over a limit only sends an untagged `NO [OVERQUOTA]` warning. `SETQUOTA` and `server.control.setQuota()` change the limits at runtime, `control.reset()` restores these. |

### Metadata

| Option               | Type                     | Default | Plugin                    | What it does                                                                                                                                                 |
| -------------------- | ------------------------ | ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `metadata`           | `Record<string, string>` | none    | METADATA, METADATA-SERVER | Initial server annotations, for example `{ "/shared/comment": "Test server" }`. Mailbox annotations come from a `metadata` object on the mailbox in storage. |
| `metadataMaxSize`    | `number`                 | `65536` | METADATA, METADATA-SERVER | Largest annotation value in octets, larger SETMETADATA values fail with `[METADATA MAXSIZE n]`.                                                              |
| `metadataMaxEntries` | `number`                 | `100`   | METADATA, METADATA-SERVER | Entries per mailbox and for the server, more fail with `[METADATA TOOMANY]`.                                                                                 |
| `metadataPrivate`    | `boolean`                | `true`  | METADATA, METADATA-SERVER | `false` refuses `/private` entries with `[METADATA NOPRIVATE]`.                                                                                              |

See [Metadata and Quota](../extensions/metadata-and-quota.md).

### Other plugins

| Option              | Type                     | Default                                                                 | Plugin             | What it does                                                                                                                                                    |
| ------------------- | ------------------------ | ----------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aclOwner`          | `string`                 | `"testuser"`                                                            | ACL                | The user that has every right on every mailbox and bypasses ACL enforcement. See [Access Control](../extensions/access-control.md).                             |
| `id`                | `Record<string, string>` | none, the server answers `* ID NIL`                                     | ID                 | The field-value pairs of the server's `* ID` response, for example `{ name: 'ImapKit', vendor: 'Example' }`.                                                    |
| `special-use`       | `string[]`               | `['\\Archive', '\\Drafts', '\\Flagged', '\\Junk', '\\Sent', '\\Trash']` | CREATE-SPECIAL-USE | The special-use attributes `CREATE ... (USE (...))` accepts, others fail with `NO [USEATTR]`. Note the hyphen, the key has to be quoted in JavaScript.          |
| `HIGHESTX-GM-MSGID` | `string` or `number`     | `"1278455344230334865"`                                                 | X-GM-EXT-1         | Starting point of the generated `X-GM-MSGID` values. Each message without an `X-GM-MSGID` in storage gets the next number. See [Gmail](../extensions/gmail.md). |

## Example

Every option in one server, as a config file or a factory argument:

```javascript
const server = imapkit({
    plugins: ['ID', 'QUOTA', 'APPENDLIMIT', 'MESSAGELIMIT', 'METADATA', 'CONTEXT=SEARCH', 'ACL', 'CREATE-SPECIAL-USE', 'X-GM-EXT-1'],
    users: { testuser: { password: 'testpass' }, other: { password: 'pw' } },
    maxLiteralSize: 1024 * 1024,
    now: new Date('2026-01-01T12:00:00Z'),
    scriptSeed: 42,
    id: { name: 'ImapKit', vendor: 'Example' },
    quota: { root: 'User quota', STORAGE: 10240, MESSAGE: 1000 },
    appendLimit: 5 * 1024 * 1024,
    messageLimit: 50,
    maxSearchContexts: 2,
    metadata: { '/shared/comment': 'Test server' },
    metadataMaxSize: 1024,
    'special-use': ['\\Archive', '\\Sent'],
    aclOwner: 'testuser',
    'HIGHESTX-GM-MSGID': '1000'
});
```

## Options that throw

The constructor fails fast on configuration mistakes, so a broken fixture never starts a server that behaves oddly:

- an unknown plugin name (`Unknown plugin "IDLE,MOVE". Available plugins: ...`), or `XTOYBIRD`, which was removed in 5.0.0 (see [Migrating from 4.x](./migrating-from-4.md))
- an unknown quirk name
- a `storage` object that does not pass `validateStorage()`
- an invalid `appendLimit`, `messageLimit` or `quota` limit
- plugins that can not be loaded together: LITERAL+ with LITERAL-, MESSAGELIMIT with SAVELIMIT

`rest` with a non-loopback `host` and no `token` throws when `start()` (or `startRest()`) starts the listener.
