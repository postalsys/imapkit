---
title: Server API
sidebar_position: 2
description: The package exports, the CommonJS shape, deep imports, and the IMAPServer methods, properties and events a test author uses.
---

# Server API

## Package exports

```javascript
import imapkit, { IMAPServer, IMAPConnection, ImapKitError, TAG_REGEX, quirks, storageSchema, validateStorage } from 'imapkit';
```

| Export            | What it is                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| default `imapkit` | The factory, `imapkit(options)` returns a new `IMAPServer`. See [Server Options](./server-options.md). It also carries `TAG_REGEX`, `IMAPServer`, `IMAPConnection`, `ImapKitError` and `quirks` as properties. |
| `IMAPServer`      | The server class, `new IMAPServer(options)` is the same as `imapkit(options)`.                                                                                                                                 |
| `IMAPConnection`  | The class of one client session, for `instanceof` checks and plugin typing.                                                                                                                                    |
| `ImapKitError`    | The error the control API throws: an `Error` with `name` `'ImapKitError'` and a `code` (`NONEXISTENT`, `ALREADYEXISTS`, `INVALID`, or an RFC 5530 code such as `CANNOT`). `new ImapKitError(message, code)`.   |
| `TAG_REGEX`       | A regular expression that matches a valid IMAP command tag (RFC 3501 section 9).                                                                                                                               |
| `quirks`          | The quirk presets as data, keyed by name: `{ description, rules, removePlugins }`. Copy one and adjust its rules when it does not fit. See [Quirk Presets](../faults/quirk-presets.md).                        |
| `storageSchema`   | A JSON Schema of the `storage` option, for editors and fixture tooling.                                                                                                                                        |
| `validateStorage` | `validateStorage(storage)` throws an error with the path of the problem for an invalid storage object, the same check the constructor runs. See [Storage](../guides/storage.md).                               |

### Types

The package ships type declarations for both module formats. These types are exported:

- server and plugins: `IMAPServerOptions`, `Plugin`, `CommandHandler`, `CommandOptions`, `Callback`, `ParsedCommand`, `IMAPResponse`, `Notification`, `IMAPError`, `Attribute`
- storage: `Message`, `Mailbox`, `StorageNamespace`, `UserData`
- control API: `Control`, `MailboxInfo`, `MessageInfo`, `SessionInfo`, `NewMessage`, `UserOptions`, `SessionFilter`, `ControlRoute`, `RouteRequest`, `FlagMode`, `UidMode`, `UidValidityOptions`
- scripted faults: `ScriptRule`, `ScriptContext`, `ScriptEvent`, `ScriptBytes`, `ScriptHandle`, `Quirk`

```typescript
import imapkit, { type IMAPServerOptions, type Plugin } from 'imapkit';

const xhello: Plugin = server => server.registerCapability('XHELLO');
const options: IMAPServerOptions = { plugins: ['IDLE', xhello] };
const server = imapkit(options);
```

### CommonJS

`require('imapkit')` returns the factory itself, with the named exports as its properties, so code written for older versions keeps working:

```javascript
const imapkit = require('imapkit');

const server = imapkit({ plugins: ['IDLE'] });
console.log(server instanceof imapkit.IMAPServer); // true
const { storageSchema, validateStorage, ImapKitError } = imapkit;
```

`imapkit.default` is the factory too, which is what TypeScript and Babel compiled `import imapkit from 'imapkit'` code reads.

### Deep imports

The `exports` map of the package keeps the old `imapkit/lib/...` paths working in both module formats:

| Path                   | Resolves to                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `imapkit/lib/server`   | the package root, the same as `imapkit`                                                        |
| `imapkit/lib/<module>` | a compiled module from `src/`, such as `imapkit/lib/plugins/idle` or `imapkit/lib/mock-client` |

In CommonJS a module with a default export loads as that export with its named exports as properties (`require('imapkit/lib/plugins/idle')` is the plugin function). A module with only named exports loads as the exports object.

`imapkit/lib/mock-client` is handy in tests: `mockClient(port, host, commands, debug, callback)` replays IMAP command strings like a well behaved client (it waits for each tagged response and for `+` continuations) and calls `callback` with everything the server sent, as a Buffer. [Custom Plugins](./custom-plugins.md#test-the-plugin) uses it.

Modules under `lib/` other than the root are internals: they follow the source layout and can change between minor versions.

### In a browser

`imapkit/browser` is the whole package as a single ES module for browsers, with the same exports. Browsers have no sockets, so sessions connect with `server.connect()` (below) instead of `listen()`. `listen()`, `start()`, the SMTP listener and the REST API fail there, and so does loading the COMPRESS plugin (it needs `node:zlib`). [Try it live](/live) is built on it.

```javascript
import imapkit from 'imapkit/browser';

const server = imapkit({ plugins: ['IDLE'] });
const client = server.connect();
client.setEncoding('utf8');
client.on('data', text => console.log(text));
client.write('A1 LOGIN testuser testpass\r\n');
```

## IMAPServer

### Starting and stopping

| Member                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(port?, host?)`      | Starts accepting connections, resolves with the IMAP port. No port picks a free one, no host listens on all addresses. Also starts the TLS, SMTP and REST listeners of the `tls`, `smtp` and `rest` options.                                                                                                                                                                                                                                                                                            |
| `stop()`                   | Closes the server, every session and the SMTP and REST listeners. Resolves when the server is closed.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `listen(...args)`          | Takes the arguments of `net.Server#listen()`. Starts only the IMAP listener.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `close(callback?)`         | Closes the IMAP listener and destroys every connection, calls `callback` when done.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `address()`                | `net.Server#address()` of the IMAP listener, `server.address().port` after `listen(0)`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `startRest()`              | Starts only the REST API of the `rest` option, resolves with its port.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `startSmtp()`              | Starts only the SMTP listener of the `smtp` option, resolves with its port.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `connect({ secure }?)`     | Opens a session in memory, without a socket or `listen()`, and returns the client end: `write()` commands to it and read the responses from its `data` events (Buffers, or strings after `setEncoding()`). It also has `end()`, `destroy()`, `pause()`, `resume()` and the `end`, `close` and `error` events. The session counts as encrypted, as over TLS; with `secure: false` it starts as plaintext and STARTTLS only marks it as encrypted (`client.encrypted`). Works in Node.js and in browsers. |
| `smtpServer`, `restServer` | The SMTP server and the HTTP server that `start()` started, or `null`. `tlsServer` is the implicit TLS listener of the `tls` option. `server.restServer.address().port` gives the REST port when `rest.port` was `0`.                                                                                                                                                                                                                                                                                   |

```javascript
const server = imapkit({ rest: { port: 0 } });
const imapPort = await server.start(0, '127.0.0.1');
const restPort = server.restServer.address().port;
// ...
await server.stop();
```

### Changing and inspecting state

| Member                                                                             | What it does                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control`                                                                          | The control API: add, flag, move and expunge messages, manage mailboxes, users and sessions, `snapshot()` and `reset()`. Every change reaches the connected sessions. See [Control API](../control-api/overview.md).               |
| `script`                                                                           | The scripted faults: `script.add(rule or rules)` returns handles with `id`, `hits`, `matched` and `remove()`, `script.clear()` removes every rule, `script.rules` lists them. See [Scripted Faults](../faults/scripted-faults.md). |
| `connections`                                                                      | A `Set` of the open `IMAPConnection` objects. `server.control.sessions()` describes them as plain data.                                                                                                                            |
| `storage`                                                                          | The live namespaces and mailboxes, built from a deep copy of the `storage` option. Prefer `control.snapshot()` for a JSON copy.                                                                                                    |
| `users`                                                                            | The live user accounts, `{ name: { password, xoauth2 } }`. Prefer `control.addUser()` and `control.updateUser()` to change them.                                                                                                   |
| `getMailbox(path)`                                                                 | The live mailbox object for a storage name (INBOX is case insensitive), or `undefined`. `control.getMailbox(path)` returns a plain description instead.                                                                            |
| `appendMessage(mailbox, flags, internaldate, raw, ignoreConnection?, properties?)` | Low level append: adds a message to a mailbox (a path or a mailbox object) and sends `EXISTS` to the sessions, returns `{ mailbox, message }`. No argument checks, `control.addMessage()` is the checked way to do this.           |
| `now()`                                                                            | The current time as the server sees it, from the `now` option.                                                                                                                                                                     |
| `options`                                                                          | The shallow copy of the options the server was built with.                                                                                                                                                                         |

The live objects (`storage`, `users`, mailboxes, messages) are what the server works with. Changing them directly skips the notifications sessions should get, so a test changes state through `server.control` and only reads the live objects.

## Events

`IMAPServer` is an event emitter. Tests wait for events instead of polling:

| Event           | Arguments                                  | When                                                                                                                                                                                  |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`       | `{ type, session, ... }`                   | `type` is `open`, `login`, `select`, `unselect`, `logout`, `waiting` (a command waits for client input, with `command`) or `close`. `session` is described like `control.sessions()`. |
| `command`       | `{ session, tag, command, status, user }`  | the tagged response of a command goes out, `status` is `OK`, `NO` or `BAD`                                                                                                            |
| `mailbox`       | `{ type, path, oldPath, mailbox, origin }` | CREATE, DELETE, RENAME, SUBSCRIBE and UNSUBSCRIBE, from a session or the control API (`origin` null)                                                                                  |
| `append`        | `(mailbox, messages, origin)`              | a message is added (APPEND, COPY, MOVE, REPLACE, SMTP, control API), before the sessions are told                                                                                     |
| `expunge`       | `(mailbox, messages, origin)`              | messages are removed, before the sessions are told                                                                                                                                    |
| `flags`         | `(mailbox, messages, origin)`              | the control API changed flags                                                                                                                                                         |
| `script`        | `{ rule, event, session, tag, command }`   | a script rule matched                                                                                                                                                                 |
| `reset`         | none                                       | `control.reset()` restored the storage and users                                                                                                                                      |
| `trace`         | `{ session, direction, data }`             | protocol traffic of a session, `in` or `out`, as a Buffer, above TLS and COMPRESS                                                                                                     |
| `acl`           | `(mailbox, previousAcl)`                   | SETACL, DELETEACL or the control API changed an ACL (ACL plugin)                                                                                                                      |
| `pluginsLoaded` | none                                       | every plugin is loaded, emitted once by the constructor, for [plugins](./custom-plugins.md#run-after-every-plugin-is-loaded)                                                          |

```javascript
const idling = new Promise(resolve => {
    server.on('session', event => event.type === 'waiting' && event.command === 'IDLE' && resolve(event));
});
// ... let the client start IDLE ...
await idling;
server.control.addMessage('INBOX', { raw: 'Subject: new\r\n\r\nHi\r\n' }); // the client gets * n EXISTS right away
```

See [Control API events](../control-api/events.md) for the event payloads in detail. The REST API streams the same events, see [Event Stream](../rest-api/event-stream.md).

## IMAPConnection

One `IMAPConnection` exists per client socket. Test code rarely touches it (use `control.sessions()`, `control.disconnect()` and `control.inject()`), plugins use it all the time. The members plugins use are listed in [Custom Plugins](./custom-plugins.md#the-connection-object).
