---
sidebar_position: 3
title: Command Line
description: Run ImapKit as a standalone IMAP server with the imapkit command, its options, environment variables and configuration file.
---

# Command Line

The `imapkit` command starts a standalone server: for trying a client by hand, for a test suite that is not written in JavaScript, or for a long running server shared by a CI job. It runs the same server as `imapkit(options)` in code, and every option of the command maps to a [server option](../reference/server-options.md).

```bash
imapkit -p 1143 --plugin=IDLE,MOVE,UIDPLUS --storage=storage.json
```

```text
Starting ImapKit ...
ImapKit successfully listening on port 1143
```

Log in as `testuser` / `testpass`. The server runs until you stop it (Ctrl+C), and every change it makes stays in memory, so the next start begins from the same state again.

Install the command with `npm install -g imapkit`, or run it from a project that has ImapKit as a dependency with `npx imapkit`. See [Installation](installation.md).

## Options

| Option                                    | Environment variable  | Description                                                                                                                                                                                   |
| ----------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p <port>`, `--port=<port>`              | `IMAPKIT_PORT`        | IMAP port. Defaults to the `port` of the config file, then to 143, or 993 with `--secure`.                                                                                                    |
| `-s`, `--secure`                          | `IMAPKIT_SECURE=true` | Implicit TLS on the IMAP port, with the bundled self-signed certificate for `localhost`.                                                                                                      |
| `-d`, `--debug`                           | `IMAPKIT_DEBUG=true`  | Writes the IMAP traffic to the console.                                                                                                                                                       |
| `--storage=<path>`                        | `IMAPKIT_STORAGE`     | JSON file with the mailbox tree, the `storage` option. See [Storage](../guides/storage.md).                                                                                                   |
| `--config=<path>`                         | `IMAPKIT_CONFIG`      | JSON file with [server options](../reference/server-options.md), see [Configuration file](#configuration-file).                                                                               |
| `--script=<path>`                         | `IMAPKIT_SCRIPT`      | JSON file with [script rules](../faults/scripted-faults.md), a rule or a list of rules.                                                                                                       |
| `--plugin=<names>`                        | `IMAPKIT_PLUGINS`     | Plugins to load. Comma separated (`--plugin=IDLE,MOVE`) or repeated (`--plugin=IDLE --plugin=MOVE`). Names are case-insensitive and capability spellings like `LITERAL+` work too.            |
| `--quirk=<names>`                         | `IMAPKIT_QUIRKS`      | [Quirk presets](../faults/quirk-presets.md): `james-fetchgroup`, `james-late-fetch`, `yahoo-quoted-sections`, `m365-throttle`, `no-uidplus`, `no-move`. Comma separated or repeated.          |
| `--script-seed=<number>`                  | `IMAPKIT_SCRIPT_SEED` | Seed of the random numbers of script rules with `chance` and of the quirk presets that use them, so a run can be [repeated](../faults/repeatable-tests.md).                                   |
| `--rest-port=<port>`                      | `IMAPKIT_REST_PORT`   | Starts the [REST API](../rest-api/overview.md) on this port. `0` picks a free port, the startup output shows which.                                                                           |
| `--rest-host=<address>`                   | `IMAPKIT_REST_HOST`   | Address of the REST API, `127.0.0.1` by default. Any address that is not a loopback address needs `--rest-token`. Only used together with `--rest-port`.                                      |
| `--rest-token=<token>`                    | `IMAPKIT_REST_TOKEN`  | Bearer token that every REST request must send as `Authorization: Bearer <token>`. Only used together with `--rest-port`.                                                                     |
| `--tls-port=<port>`                       | `IMAPKIT_TLS_PORT`    | Also listens for implicit TLS (IMAPS) connections on this port, next to the plaintext port of `-p`. Both serve the same mailboxes.                                                            |
| `--smtpPort=<port>`, `--smtp-port=<port>` | `IMAPKIT_SMTPPORT`    | Starts an SMTP server on this port that appends every message it receives to INBOX. Needs the optional `smtp-server` package, see [Installation](installation.md#optional-the-smtp-listener). |
| `-h`, `--help`                            |                       | Prints the options, every plugin with a short description, and sample config and storage files.                                                                                               |

A command line option wins over its environment variable, and both win over the config file. `--plugin` replaces the `plugins` list of the config file, `--storage` its `storage`, and `--script` its `script`.

Ports below 1024 (143 and 993 included) usually need administrator rights. Pick a port such as 1143 for local use.

## Configuration file

`--config` takes a JSON object with any [server options](../reference/server-options.md) that JSON can express, plus `port`:

```json title="imapkit.json"
{
    "plugins": ["IDLE", "MOVE", "UIDPLUS"],
    "port": 1143,
    "users": {
        "testuser": { "password": "testpass" },
        "alice": { "password": "secret" }
    },
    "storage": {
        "INBOX": {
            "messages": [{ "raw": "Subject: Welcome\r\n\r\nHello!\r\n", "flags": ["\\Seen"] }]
        },
        "": { "separator": "/", "folders": { "Archive": {} } }
    },
    "rest": { "port": 8143 }
}
```

```bash
imapkit --config=imapkit.json
```

```text
Starting ImapKit ...
ImapKit successfully listening on port 1143
REST API listening on 127.0.0.1:8143
```

Some useful keys besides the ones above: `debug`, `secureConnection`, `maxLiteralSize` (octets, 64 MiB by default), `appendLimit` and `messageLimit` (for the APPENDLIMIT and MESSAGELIMIT plugins), `id` (the ID plugin's answer), `quirks`, `scriptSeed`, `script`, `tls` (`{ "port": 1993 }`), `smtp` (`{ "port": 1025 }`) and `rest` (`{ "port", "host", "token" }`). `--rest-port` (with `--rest-host` and `--rest-token`) replaces the `rest` object of the file, `--tls-port` its `tls` object and `--smtpPort` its `smtp` object.

:::note
`secureConnection` in the config file turns on TLS but does not change the default port, which stays 143. Set `port` in the file, or use `--secure`, which defaults the port to 993.
:::

Options that take JavaScript functions, such as plugin functions, `now` as a function, or the `when` and `mutate` functions of script rules, only work from code.

## Storage file

`--storage` loads the mailbox tree from a JSON file. The keys are namespaces: `INBOX`, the personal namespace `""` with its `separator` and `folders`, and optionally other namespaces:

```json title="storage.json"
{
    "INBOX": {
        "messages": [{ "raw": "Subject: Test\r\n\r\nHello world!\r\n", "flags": ["\\Seen"] }]
    },
    "": {
        "separator": "/",
        "folders": {
            "Archive": {},
            "Sent": { "special-use": "\\Sent" }
        }
    }
}
```

```bash
imapkit -p 1143 --plugin=SPECIAL-USE --storage=storage.json
```

Without a storage file the server has an empty INBOX. The file is read once at startup and never written. See [Storage](../guides/storage.md) for every key (UIDs, UIDVALIDITY, internal dates, special-use attributes, ACLs and more).

## Script file

`--script` loads [script rules](../faults/scripted-faults.md) that make the server misbehave on purpose. JSON rules use strings for `match` and `send`:

```json title="faults.json"
[
    { "on": "command", "command": "SELECT", "times": 1, "send": "$TAG NO [UNAVAILABLE] Try again later\r\n" },
    { "on": "response", "command": "FETCH", "untagged": true, "literals": true }
]
```

```bash
imapkit -p 1143 --script=faults.json
```

The first SELECT gets `NO [UNAVAILABLE]`, the next ones work. Every FETCH response sends its strings as literals. With the [REST API](../rest-api/overview.md) on, rules can also be added and removed at runtime, without a restart.

## Examples

A server with the extensions most clients use:

```bash
imapkit -p 1143 --plugin=ID,IDLE,NAMESPACE,UNSELECT,UIDPLUS,MOVE,SPECIAL-USE,ENABLE,CONDSTORE,LITERALPLUS
```

An IMAP4rev2 server (loads the extensions that RFC 9051 folds in):

```bash
imapkit -p 1143 --plugin=IMAP4rev2
```

Watch the traffic of a client you are debugging:

```bash
imapkit -p 1143 --plugin=IDLE --debug
```

```text
A1 LOGIN testuser testpass
SEND: A1 OK User logged in
A2 SELECT INBOX
SEND: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
...
SEND: A2 OK [READ-WRITE] Completed
```

A server for a test suite in another language, with the REST API ([Testing from other languages](../guides/testing-from-other-languages.md)):

```bash
imapkit -p 1143 --plugin=IDLE,UIDPLUS,MOVE --rest-port=8143
```

A REST API that other machines can reach, which needs a token:

```bash
imapkit -p 1143 --rest-port=8143 --rest-host=0.0.0.0 --rest-token=s3cret
curl -H 'Authorization: Bearer s3cret' http://127.0.0.1:8143/v1/sessions
```

Behave like Microsoft 365 under load, the same way in every run:

```bash
imapkit -p 1143 --plugin=IDLE,MOVE --quirk=m365-throttle --script-seed=42
```

Accept mail over SMTP on port 1025 and show it in INBOX:

```bash
npm install -g smtp-server
imapkit -p 1143 --smtpPort=1025
```

```text
Starting ImapKit ...
ImapKit successfully listening on port 1143
Incoming SMTP server up and running on port 1025
```

The same settings through environment variables, for example in a CI service definition:

```bash
IMAPKIT_PORT=1143 IMAPKIT_PLUGINS=IDLE,MOVE IMAPKIT_REST_PORT=8143 imapkit
```

Implicit TLS on port 993, which needs administrator rights, or on a port of your choice:

```bash
imapkit --secure -p 1993
```

The bundled certificate is self-signed for `localhost`, so the client has to accept it (for example `tls: { rejectUnauthorized: false }` in Node.js).

## Errors

The command exits with status 1 and prints the reason when the server can not start, for example when the port is in use or the REST API would listen on a public address without a token:

```text
Starting ImapKit ...
Failed to start ImapKit: The REST API controls the whole server, it needs a token (rest.token, --rest-token) to listen on 0.0.0.0
```

An unknown plugin or quirk name stops the command with an error that lists the valid names.
