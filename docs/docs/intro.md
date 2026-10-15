---
slug: /
sidebar_position: 1
title: Introduction
description: ImapKit is a scriptable, in-memory IMAP server for testing IMAP clients, strict about the RFCs and controllable from your tests.
---

# ImapKit

ImapKit is a scriptable, in-memory IMAP server for testing IMAP clients. It implements IMAP4rev1 ([RFC 3501](https://www.rfc-editor.org/rfc/rfc3501)) and, as an optional plugin, IMAP4rev2 ([RFC 9051](https://www.rfc-editor.org/rfc/rfc9051)), with more than 50 extensions that you turn on and off per server instance.

Nothing is ever written to disk. The mailbox tree comes from a JSON object, so every new server starts from the same known state, and a test suite can start a fresh server for every test in a few milliseconds.

To see it before installing anything, [try it live](/live): ImapKit runs in your browser tab, and you type IMAP commands and read what it answers.

## Who it is for

- **Authors of IMAP client libraries** who want every code path (MOVE or COPY with EXPUNGE, LITERAL+ or synchronizing literals, QRESYNC or plain flags) covered against one predictable server.
- **Application developers** whose product reads or syncs mail and who need integration tests that do not depend on a real mail account, a network, or a Docker container.
- **Teams in any language.** ImapKit runs as a standalone command with an HTTP API, so Python, Go, Java or Ruby test suites can use it as well as Node.js ones.

## A taste

```javascript title="test/new-mail.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import imapkit from 'imapkit';

test('a delivered message is in INBOX', async () => {
    const server = imapkit({ plugins: ['IDLE', 'UIDPLUS', 'MOVE'] });
    const port = await server.start(); // a free port

    // ... connect your IMAP client to 127.0.0.1:port as testuser / testpass

    // change the server while the client is connected, like a new delivery would
    const { uid } = server.control.addMessage('INBOX', {
        raw: 'Subject: hello\r\n\r\nHi!\r\n',
        flags: ['\\Seen']
    });
    assert.equal(uid, 1);
    assert.equal(server.control.getMailbox('INBOX').messages, 1);

    await server.stop();
});
```

The [Quick Start](getting-started/quick-start.md) turns this into a complete test with a real IMAP client.

## What you get

| Feature              | What it does                                                                                                                                                                                                                       | Read more                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Fresh state per test | The `storage` option describes namespaces, mailboxes, messages, flags, UIDs and UIDVALIDITY values. Changes live only in memory.                                                                                                   | [Storage](guides/storage.md)                                                                             |
| Strict by design     | Client input that breaks the RFCs is answered with `BAD` or `NO`, so client bugs show up in your test suite instead of in production.                                                                                              | [Strict by design](guides/strict-by-design.md)                                                           |
| Control API          | `server.control` adds and removes messages, changes flags, renames mailboxes, resets UIDVALIDITY and disconnects sessions while clients are connected. Every change reaches the sessions the way a change by another client would. | [Control API](control-api/overview.md)                                                                   |
| Events               | `session`, `command`, `mailbox`, `expunge` and other events tell a test that the client logged in, selected a mailbox or started IDLE, so tests wait for events instead of sleeping.                                               | [Events](control-api/events.md)                                                                          |
| REST API             | The control API over HTTP, with the events as Server-Sent Events, for test suites in any language.                                                                                                                                 | [REST API](rest-api/overview.md), [Testing from other languages](guides/testing-from-other-languages.md) |
| Scripted faults      | Script rules make the server misbehave on purpose: canned responses, literals everywhere, late or split output, truncated literals, dropped connections, autologout.                                                               | [Scripted faults](faults/scripted-faults.md)                                                             |
| Quirk presets        | Named presets reproduce the known behavior of real servers (Apache James, Yahoo, Microsoft 365 throttling, servers without UIDPLUS or MOVE).                                                                                       | [Quirk presets](faults/quirk-presets.md), [Repeatable tests](faults/repeatable-tests.md)                 |
| Extensions           | IDLE, CONDSTORE, QRESYNC, MOVE, UIDPLUS, ESEARCH, SORT, THREAD, NOTIFY, ACL, QUOTA, METADATA, COMPRESS, BINARY, UTF8=ACCEPT, OAUTHBEARER, the Gmail extensions and many more, each one a plugin.                                   | [Extensions](extensions/overview.md), [IMAP4rev2](extensions/imap4rev2.md)                               |
| Several sessions     | Any number of clients share one mailbox tree. Expunges and flag changes by other sessions follow one consistent set of the RFC 2180 strategies.                                                                                    | [Multiple sessions](guides/multiple-sessions.md)                                                         |
| Users and logins     | `LOGIN`, `AUTHENTICATE PLAIN`, XOAUTH2 and OAUTHBEARER, STARTTLS and implicit TLS with a bundled certificate.                                                                                                                      | [Authentication](guides/authentication.md), [Users and sessions](control-api/users-and-sessions.md)      |
| Command line         | `imapkit -p 1143 --plugin=IDLE,MOVE` runs a server without writing any code, with options for storage, faults, quirks, SMTP and the REST API.                                                                                      | [Command line](getting-started/command-line.md)                                                          |
| Extensible           | Any command can be overridden and your own plugins can add commands, capabilities and control operations.                                                                                                                          | [Custom plugins](reference/custom-plugins.md), [Server API](reference/server-api.md)                     |

## Where to start

1. [Install](getting-started/installation.md) ImapKit as a dev dependency or as a global command.
2. Write your [first test](getting-started/quick-start.md) with a real client.
3. Read [Writing client tests](guides/writing-client-tests.md) for the patterns that keep a large suite fast and free of flaky sleeps.
4. Look up [server options](reference/server-options.md) and the [server API](reference/server-api.md) as you need them.

Upgrading from ImapKit 4.x or from `hoodiecrow-imap`? See [Migrating from 4.x](reference/migrating-from-4.md). Known gaps are listed under [Known issues](reference/known-issues.md), and [Contributing](contributing/running-tests.md) explains how to run ImapKit's own test suite and [compare it with Dovecot](contributing/comparing-with-dovecot.md).

ImapKit is maintained by the team behind [EmailEngine](https://emailengine.app/?utm_source=imapkit.com&utm_medium=docs&utm_campaign=oss-docs) and [ImapFlow](https://imapflow.com/).
