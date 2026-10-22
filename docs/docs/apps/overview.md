---
title: Apps
sidebar_label: Overview
description: Ways to run ImapKit besides the npm package in your tests, the imapkit command, the browser playground and the ImapKit Desktop app for Windows.
---

# Apps

ImapKit is first of all a library that your test suite starts and controls. The same server is also packaged in ways that need no code at all:

| App                                                     | What it is                                                                                                                                                                                 | Runs on                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| [ImapKit Desktop](desktop-windows.md)                   | A mock mail server with a window: IMAP and SMTP servers for your email client or app under test, a live protocol log of every session, and an Outlook Express style view of the mailboxes. | Windows 10 and 11 (64-bit) |
| [`imapkit` command](../getting-started/command-line.md) | The server as a standalone command, configured with options, environment variables or a config file. Comes with the npm package.                                                           | Node.js 20 or newer        |
| [Try it live](/live)                                    | ImapKit running in a browser tab, where you type IMAP commands and read the answers. Good for learning IMAP and trying extensions.                                                         | Any modern browser         |

All of them run the same ImapKit server, with the same [extensions](../extensions/overview.md) and the same [strict RFC checks](../guides/strict-by-design.md), so what a client does against one of them it does against the others.

## Which one to use

- **Testing an email client or an app by hand**, for example pointing Thunderbird, Outlook or the app you are building at a server and watching what it sends: [ImapKit Desktop](desktop-windows.md).
- **A test suite in a language other than JavaScript**, or a server shared by a CI job: the [`imapkit` command](../getting-started/command-line.md) with the [REST API](../rest-api/overview.md).
- **Automated tests in Node.js**: the library itself, see the [Quick Start](../getting-started/quick-start.md).
- **Learning what a command does** before writing code for it: [Try it live](/live).
