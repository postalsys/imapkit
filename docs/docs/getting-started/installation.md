---
sidebar_position: 1
title: Installation
description: Install ImapKit as a dev dependency for your test suite, or as a global command that runs a standalone IMAP server.
---

# Installation

ImapKit needs Node.js 20 or newer. It also runs on the latest [Bun](https://bun.sh/) and [Deno](https://deno.com/) releases, and its own test suite runs on both in CI.

## As a dev dependency

Most projects use ImapKit from their test suite:

```bash
npm install --save-dev imapkit
```

The package ships ES modules and CommonJS, each with type declarations:

```javascript
import imapkit from 'imapkit';
// or with CommonJS: const imapkit = require('imapkit');

const server = imapkit({ plugins: ['IDLE'] });
const port = await server.start();
```

Next to the `imapkit(options)` factory, the package exports `ImapKitError` (the error the [control API](../control-api/overview.md) throws), `quirks` (the [quirk presets](../faults/quirk-presets.md) as data), `validateStorage()` and `storageSchema` (the check and JSON Schema of the [storage option](../guides/storage.md)), the `IMAPServer` and `IMAPConnection` classes, and TypeScript types:

```typescript
import imapkit, { ImapKitError, type IMAPServerOptions, type Plugin } from 'imapkit';
```

With Bun, `bun add -d imapkit`. With Deno, import `npm:imapkit`.

## As a standalone server

Install the command globally, or run it from the project with `npx imapkit`:

```bash
npm install -g imapkit
imapkit -p 1143
```

Point any IMAP client to `localhost:1143` and log in with user name `testuser` and password `testpass`. Without `-p` the server listens on port 143 (993 with `--secure`), which usually needs root privileges.

The command takes plugins, a storage file, script rules, quirk presets and a REST API port. See [Command line](command-line.md) for every option, or run:

```bash
imapkit --help
```

## Optional: the SMTP listener

ImapKit can also accept mail over SMTP and append every message it receives to INBOX (`--smtpPort` for the command, the `smtp` option in code). The listener needs the [smtp-server](https://www.npmjs.com/package/smtp-server) package, an optional peer dependency that is not installed with ImapKit:

```bash
npm install --save-dev smtp-server
# or, next to a global install
npm install -g smtp-server
```

Without it, `server.start()` rejects with an error that tells you to install it, and the IMAP server works as usual when SMTP is not enabled.

## In a browser

`import imapkit from 'imapkit/browser'` loads a bundle for browsers, for interactive examples and demos. There are no sockets in a browser, so sessions connect in memory with `server.connect()`, see [Server API](../reference/server-api.md#in-a-browser). [Try it live](/live) runs it on this site.

## Default account

Every server has one account until you configure others:

| User name  | Password   | Access token (XOAUTH2, OAUTHBEARER) |
| ---------- | ---------- | ----------------------------------- |
| `testuser` | `testpass` | `testtoken`                         |

The `users` option replaces this list, and the [control API](../control-api/users-and-sessions.md) adds users at runtime. All users share the same mailbox tree; see [Authentication](../guides/authentication.md).

## Next steps

- Write your first test in the [Quick Start](quick-start.md).
- Run the server from the shell with the [command line](command-line.md) options.
