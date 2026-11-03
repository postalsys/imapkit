---
title: Endpoints
sidebar_position: 2
description: Every REST API endpoint with its method, path, request body, response and a curl example, including the routes of the ACL, QUOTA, METADATA and SPECIAL-USE plugins.
---

# Endpoints

Every endpoint is under `/v1`. The examples use a server started with

```bash
imapkit -p 1143 --rest-port=8143 --plugin=IDLE,ACL,QUOTA,METADATA,SPECIAL-USE,CONDSTORE
```

and show real responses. `{path}` is a mailbox [storage name, URL encoded](./overview.md#mailbox-names-in-urls) with `/` as `%2F`. Bodies are JSON and need `Content-Type: application/json`. Errors are described in the [overview](./overview.md#errors), and each endpoint answers with the errors of the [control API](../control-api/overview.md) method it calls.

| Method   | Path                                    | Control API                                   | Success |
| -------- | --------------------------------------- | --------------------------------------------- | ------- |
| `GET`    | `/v1/snapshot`                          | `snapshot()`                                  | 200     |
| `POST`   | `/v1/reset`                             | `reset()`                                     | 200     |
| `POST`   | `/v1/shutdown`                          | `shutdown()`                                  | 202     |
| `GET`    | `/v1/sessions`                          | `sessions()`                                  | 200     |
| `DELETE` | `/v1/sessions/{session}`                | `disconnect()`                                | 200     |
| `POST`   | `/v1/sessions/{session}/inject`         | `inject()`                                    | 200     |
| `GET`    | `/v1/events`                            | [event stream](./event-stream.md)             | 200     |
| `GET`    | `/v1/users`                             | `listUsers()`                                 | 200     |
| `POST`   | `/v1/users`                             | `addUser()`                                   | 201     |
| `PUT`    | `/v1/users/{name}`                      | `updateUser()`                                | 200     |
| `DELETE` | `/v1/users/{name}`                      | `deleteUser()`                                | 200     |
| `GET`    | `/v1/mailboxes`                         | `listMailboxes()`                             | 200     |
| `POST`   | `/v1/mailboxes`                         | `createMailbox()`                             | 201     |
| `GET`    | `/v1/mailboxes/{path}`                  | `getMailbox()`                                | 200     |
| `DELETE` | `/v1/mailboxes/{path}`                  | `deleteMailbox()`                             | 200     |
| `POST`   | `/v1/mailboxes/{path}/rename`           | `renameMailbox()`                             | 200     |
| `PUT`    | `/v1/mailboxes/{path}/subscription`     | `subscribe()`                                 | 200     |
| `DELETE` | `/v1/mailboxes/{path}/subscription`     | `unsubscribe()`                               | 200     |
| `POST`   | `/v1/mailboxes/{path}/uidvalidity`      | `resetUidValidity()`                          | 200     |
| `GET`    | `/v1/mailboxes/{path}/messages`         | `listMessages()`                              | 200     |
| `POST`   | `/v1/mailboxes/{path}/messages`         | `addMessage()`                                | 201     |
| `POST`   | `/v1/mailboxes/{path}/messages/flags`   | `setFlags()`                                  | 200     |
| `POST`   | `/v1/mailboxes/{path}/messages/expunge` | `expungeMessages()`                           | 200     |
| `POST`   | `/v1/mailboxes/{path}/messages/copy`    | `copyMessages()`                              | 200     |
| `POST`   | `/v1/mailboxes/{path}/messages/move`    | `moveMessages()`                              | 200     |
| `GET`    | `/v1/mailboxes/{path}/messages/{uid}`   | `getMessage()`                                | 200     |
| `DELETE` | `/v1/mailboxes/{path}/messages/{uid}`   | `expungeMessages()`                           | 200     |
| `GET`    | `/v1/script/rules`                      | `server.script.rules`                         | 200     |
| `POST`   | `/v1/script/rules`                      | `server.script.add()`                         | 201     |
| `DELETE` | `/v1/script/rules`                      | `server.script.clear()`                       | 200     |
| `DELETE` | `/v1/script/rules/{id}`                 | `handle.remove()`                             | 200     |
| `GET`    | `/v1/mailboxes/{path}/acl`              | `getAcl()` (ACL)                              | 200     |
| `PUT`    | `/v1/mailboxes/{path}/acl/{identifier}` | `setAcl()` (ACL)                              | 200     |
| `DELETE` | `/v1/mailboxes/{path}/acl/{identifier}` | `deleteAcl()` (ACL)                           | 200     |
| `GET`    | `/v1/quota`                             | `getQuota()` (QUOTA)                          | 200     |
| `PUT`    | `/v1/quota`                             | `setQuota()` (QUOTA)                          | 200     |
| `GET`    | `/v1/metadata`                          | `getMetadata('')` (METADATA, METADATA-SERVER) | 200     |
| `PUT`    | `/v1/metadata`                          | `setMetadata('')` (METADATA, METADATA-SERVER) | 200     |
| `GET`    | `/v1/mailboxes/{path}/metadata`         | `getMetadata()` (METADATA)                    | 200     |
| `PUT`    | `/v1/mailboxes/{path}/metadata`         | `setMetadata()` (METADATA)                    | 200     |
| `PUT`    | `/v1/mailboxes/{path}/special-use`      | `setSpecialUse()` (SPECIAL-USE)               | 200     |
| `GET`    | `/v1/oauth`                             | `getOAuthInfo()` (oauth)                      | 200     |
| `GET`    | `/v1/oauth/clients`                     | `listOAuthClients()` (oauth)                  | 200     |
| `PUT`    | `/v1/oauth/clients/{id}`                | `setOAuthClient()` (oauth)                    | 200     |
| `DELETE` | `/v1/oauth/clients/{id}`                | `deleteOAuthClient()` (oauth)                 | 200     |
| `PUT`    | `/v1/oauth/consent`                     | `setOAuthConsent()` (oauth)                   | 200     |
| `GET`    | `/v1/oauth/decisions`                   | `listOAuthDecisions()` (oauth)                | 200     |
| `POST`   | `/v1/oauth/decisions`                   | `queueOAuthDecision()` (oauth)                | 201     |
| `DELETE` | `/v1/oauth/decisions`                   | `clearOAuthDecisions()` (oauth)               | 200     |
| `POST`   | `/v1/oauth/token-faults`                | `queueOAuthTokenFault()` (oauth)              | 201     |
| `DELETE` | `/v1/oauth/token-faults`                | `clearOAuthTokenFaults()` (oauth)             | 200     |
| `GET`    | `/v1/oauth/tokens`                      | `listOAuthTokens()` (oauth)                   | 200     |
| `POST`   | `/v1/oauth/tokens/expire`               | `expireOAuthTokens()` (oauth)                 | 200     |
| `POST`   | `/v1/oauth/tokens/revoke`               | `revokeOAuthTokens()` (oauth)                 | 200     |
| `GET`    | `/v1/openapi.json`                      | the OpenAPI document                          | 200     |

The plugin routes exist only while their plugin is loaded, and the OAuth routes only with the `oauth` option, without them they answer `404 NOTFOUND`.

## Server

### GET /v1/snapshot

The whole store in the shape of the `storage` option, see [`snapshot()`](../control-api/mailboxes-and-messages.md#snapshot). Message sources are binary strings here, not base64. Save it to start a new server from the same state with `--storage`.

```bash
curl -s http://127.0.0.1:8143/v1/snapshot > state.json
imapkit -p 1144 --storage=state.json
```

### POST /v1/reset

Restores the mailboxes and users of the server options and disconnects every session with `* BYE Server reset`. Script rules stay. See [`reset()`](../control-api/users-and-sessions.md#reset).

```bash
curl -X POST http://127.0.0.1:8143/v1/reset -H 'Content-Type: application/json'
# {"reset":true}
```

### POST /v1/shutdown

Body: `{ "graceful": false }` (optional). Answers `202` first, then stops the server. A graceful shutdown (the default) stops accepting connections and waits until the last client is gone, `graceful: false` closes the sessions right away. The `imapkit` command exits when the server is closed. Open [event streams](./event-stream.md) end with the shutdown.

```bash
curl -X POST http://127.0.0.1:8143/v1/shutdown -H 'Content-Type: application/json' -d '{"graceful": false}'
# {"shutdown":true}
```

## Sessions

### GET /v1/sessions

The connected sessions, see [`sessions()`](../control-api/users-and-sessions.md#sessions).

```bash
curl http://127.0.0.1:8143/v1/sessions
# [{"session":1,"user":"testuser","state":"Selected","mailbox":"INBOX","readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"}]
```

### DELETE /v1/sessions/\{session\}

Body: `{ "text": "...", "reset": true }` (both optional). Disconnects one session with an untagged BYE (`text`, default `Disconnected by the server`), or with a TCP reset when `reset` is true. Answers `404 NONEXISTENT` for a session that is not connected.

```bash
curl -X DELETE http://127.0.0.1:8143/v1/sessions/1 -H 'Content-Type: application/json' -d '{"text": "Bye from the test"}'
# {"disconnected":true}
# the client receives: * BYE Bye from the test
```

### POST /v1/sessions/\{session\}/inject

Body: `{ "data": "...", "encoding": "base64" }`. Writes `data` to the session as it is, as UTF-8 text or decoded from base64 with `"encoding": "base64"`. See [`inject()`](../control-api/users-and-sessions.md#injectsession-data).

```bash
curl -X POST http://127.0.0.1:8143/v1/sessions/1/inject \
     -H 'Content-Type: application/json' \
     -d '{"data": "* OK [ALERT] Maintenance in 5 minutes\r\n"}'
# {"injected":true}
```

### GET /v1/events

Server events as Server-Sent Events, see [Event stream](./event-stream.md).

## Users

### GET /v1/users

The users without credentials.

```bash
curl http://127.0.0.1:8143/v1/users
# [{"name":"testuser","xoauth2":true}]
```

### POST /v1/users

Body: `{ "name": "...", "password": "...", "xoauth2": { "accessToken": "...", "sessionTimeout": 3600000 } }`. Adds a user, answers `201` with `{ name }`, or `409 ALREADYEXISTS`.

```bash
curl -X POST http://127.0.0.1:8143/v1/users -H 'Content-Type: application/json' -d '{"name": "alice", "password": "secret"}'
# {"name":"alice"}
```

### PUT /v1/users/\{name\}

Body: `{ "password": "...", "xoauth2": {...} }`. Changes the password or the access token, `"xoauth2": null` removes the token.

```bash
curl -X PUT http://127.0.0.1:8143/v1/users/alice -H 'Content-Type: application/json' -d '{"xoauth2": {"accessToken": "alice-token"}}'
# {"name":"alice"}
```

### DELETE /v1/users/\{name\}

Body: `{ "disconnect": false }` (optional). Deletes a user and disconnects its sessions, unless `disconnect` is false.

```bash
curl -X DELETE http://127.0.0.1:8143/v1/users/alice -H 'Content-Type: application/json' -d '{"disconnect": false}'
# {"deleted":true}
curl -X DELETE http://127.0.0.1:8143/v1/users/alice
# {"error":{"code":"NONEXISTENT","message":"User \"alice\" does not exist"}}
```

## Mailboxes

### GET /v1/mailboxes

Every mailbox as a [`MailboxInfo`](../control-api/mailboxes-and-messages.md#getmailboxpath), ordered by name.

```bash
curl http://127.0.0.1:8143/v1/mailboxes
# [{"path":"INBOX","delimiter":"/","flags":["\\HasNoChildren"],"selectable":true,"subscribed":true,"messages":0,"unseen":0,"uidnext":1,"uidvalidity":1,"permanentFlags":["\\Answered","\\Flagged","\\Draft","\\Deleted","\\Seen"],"specialUse":[]}]
```

### POST /v1/mailboxes

Body: `{ "path": "...", "subscribed": true }`. Creates a mailbox with any missing superior levels and answers `201` with its `MailboxInfo`.

```bash
curl -X POST http://127.0.0.1:8143/v1/mailboxes -H 'Content-Type: application/json' -d '{"path": "Work/Projects", "subscribed": true}'
# {"path":"Work/Projects","delimiter":"/","flags":["\\HasNoChildren"],"selectable":true,"subscribed":true,"messages":0,"unseen":0,"uidnext":1,"uidvalidity":3,"permanentFlags":["\\Answered","\\Flagged","\\Draft","\\Deleted","\\Seen"],"specialUse":[]}
```

### GET /v1/mailboxes/\{path\}

One mailbox.

```bash
curl http://127.0.0.1:8143/v1/mailboxes/Work%2FProjects
# {"path":"Work/Projects","delimiter":"/","flags":["\\HasNoChildren"],"selectable":true,"subscribed":true,"messages":0,"unseen":0,"uidnext":1,"uidvalidity":3,"permanentFlags":["\\Answered","\\Flagged","\\Draft","\\Deleted","\\Seen"],"specialUse":[]}
curl -i http://127.0.0.1:8143/v1/mailboxes/Nope
# HTTP/1.1 404 Not Found
# {"error":{"code":"NONEXISTENT","message":"Mailbox \"Nope\" does not exist"}}
```

### DELETE /v1/mailboxes/\{path\}

Deletes a mailbox. Sessions that have it selected get `BYE`.

```bash
curl -X DELETE http://127.0.0.1:8143/v1/mailboxes/Archive%2FProjects
# {"deleted":true}
curl -X DELETE http://127.0.0.1:8143/v1/mailboxes/INBOX
# 409 {"error":{"code":"CANNOT","message":"INBOX can not be modified"}}
```

### POST /v1/mailboxes/\{path\}/rename

Body: `{ "newPath": "..." }`. Renames a mailbox with its children and answers with the renamed `MailboxInfo`. Renaming INBOX moves its messages.

```bash
curl -X POST http://127.0.0.1:8143/v1/mailboxes/Work/rename -H 'Content-Type: application/json' -d '{"newPath": "Archive"}'
# {"path":"Archive","delimiter":"/","flags":["\\HasChildren"],"selectable":true,"subscribed":false,"messages":0,"unseen":0,"uidnext":1,"uidvalidity":2,"permanentFlags":["\\Answered","\\Flagged","\\Draft","\\Deleted","\\Seen"],"specialUse":[]}
```

### PUT and DELETE /v1/mailboxes/\{path\}/subscription

`PUT` subscribes a mailbox, `DELETE` unsubscribes a name (it does not have to be a mailbox). Both answer `{ "changed": true }` if the subscription changed. Subscriptions stay with the old name when a mailbox is renamed, so `Archive/Projects` above is not subscribed:

```bash
curl -X DELETE http://127.0.0.1:8143/v1/mailboxes/Archive%2FProjects/subscription
# {"changed":false}
curl -X PUT http://127.0.0.1:8143/v1/mailboxes/Archive%2FProjects/subscription
# {"changed":true}
```

### Reset UIDVALIDITY

`POST /v1/mailboxes/{path}/uidvalidity` with the body `{ "uidvalidity": 5000, "uids": "offset", "offset": 100, "seed": 42 }` (all optional). Gives the mailbox a new UIDVALIDITY and optionally new UIDs, sessions that have it selected get `BYE`. See [UIDVALIDITY resets](../control-api/uidvalidity.md).

```bash
curl -X POST http://127.0.0.1:8143/v1/mailboxes/INBOX/uidvalidity -H 'Content-Type: application/json' -d '{"uids": "offset", "offset": 100}'
# {"uidvalidity":4,"uidnext":105,"uids":[{"uid":1,"newUid":103}]}
```

## Messages

### GET /v1/mailboxes/\{path\}/messages

Query: `uids=1,2` (only these UIDs), `raw=true` (include the source in base64). The messages as [`MessageInfo`](../control-api/mailboxes-and-messages.md#getmessagepath-uid-options) objects, ordered by UID.

```bash
curl http://127.0.0.1:8143/v1/mailboxes/INBOX/messages
# [{"uid":1,"flags":["\\Seen"],"internaldate":"08-Oct-2026 18:22:33 +0300","size":23,"modseq":2},{"uid":2,"flags":[],"internaldate":"17-Jul-1996 02:44:25 -0700","size":25,"modseq":3}]
curl 'http://127.0.0.1:8143/v1/mailboxes/INBOX/messages?uids=2&raw=true'
# [{"uid":2,"flags":[],"internaldate":"17-Jul-1996 02:44:25 -0700","size":25,"modseq":3,"raw":"U3ViamVjdDogYmFzZTY0DQoNCkJvZHkNCg==","encoding":"base64"}]
```

### POST /v1/mailboxes/\{path\}/messages

Body: `{ "raw": "...", "encoding": "base64", "flags": [...], "internaldate": "...", "checks": true }`. Adds a message like a delivery and answers `201` with `{ uid, uidvalidity }`. `raw` is text (UTF-8) or base64 with `"encoding": "base64"`, `internaldate` an RFC 3501 date-time string. `"checks": true` refuses the message like APPEND would, for example `409 OVERQUOTA` with QUOTA or `413 TOOBIG` with APPENDLIMIT.

```bash
curl -X POST http://127.0.0.1:8143/v1/mailboxes/INBOX/messages \
     -H 'Content-Type: application/json' \
     -d '{"raw": "Subject: hello\r\n\r\nHi!\r\n", "flags": ["\\Seen"]}'
# {"uid":1,"uidvalidity":1}
curl -X POST http://127.0.0.1:8143/v1/mailboxes/INBOX/messages \
     -H 'Content-Type: application/json' \
     -d '{"raw": "U3ViamVjdDogYmFzZTY0DQoNCkJvZHkNCg==", "encoding": "base64", "internaldate": "17-Jul-1996 02:44:25 -0700"}'
# {"uid":2,"uidvalidity":1}
```

### POST /v1/mailboxes/\{path\}/messages/flags

Body: `{ "uids": [...], "flags": [...], "mode": "add" }`. Changes flags, `mode` is `set` (default), `add` or `remove`. Answers with the new flags of every message.

```bash
curl -X POST http://127.0.0.1:8143/v1/mailboxes/INBOX/messages/flags \
     -H 'Content-Type: application/json' \
     -d '{"uids": [1, 2], "flags": ["\\Flagged"], "mode": "add"}'
# [{"uid":1,"flags":["\\Seen","\\Flagged"]},{"uid":2,"flags":["\\Flagged"]}]
```

### POST /v1/mailboxes/\{path\}/messages/expunge

Body: `{ "uids": [...] }`. Removes messages, answers with the removed UIDs.

```bash
curl -X POST http://127.0.0.1:8143/v1/mailboxes/Work%2FProjects/messages/expunge -H 'Content-Type: application/json' -d '{"uids": [1]}'
# {"uids":[1]}
```

### POST /v1/mailboxes/\{path\}/messages/copy and .../move

Body: `{ "uids": [...], "target": "..." }`. Copies or moves messages to `target` (a plain storage name, not URL encoded). Answers with the UIDVALIDITY of the target and the new UIDs.

```bash
curl -X POST http://127.0.0.1:8143/v1/mailboxes/INBOX/messages/copy -H 'Content-Type: application/json' -d '{"uids": [1, 2], "target": "Work/Projects"}'
# {"uidvalidity":3,"uids":[{"uid":1,"targetUid":1},{"uid":2,"targetUid":2}]}
curl -X POST http://127.0.0.1:8143/v1/mailboxes/INBOX/messages/move -H 'Content-Type: application/json' -d '{"uids": [2], "target": "Work/Projects"}'
# {"uidvalidity":3,"uids":[{"uid":2,"targetUid":3}]}
```

### GET /v1/mailboxes/\{path\}/messages/\{uid\}

One message, always with its source in base64.

```bash
curl http://127.0.0.1:8143/v1/mailboxes/INBOX/messages/1
# {"uid":1,"flags":["\\Seen"],"internaldate":"08-Oct-2026 18:22:33 +0300","size":23,"modseq":2,"raw":"U3ViamVjdDogaGVsbG8NCg0KSGkhDQo=","encoding":"base64"}
```

### DELETE /v1/mailboxes/\{path\}/messages/\{uid\}

Removes one message.

```bash
curl -X DELETE http://127.0.0.1:8143/v1/mailboxes/Work%2FProjects/messages/2
# {"uids":[2]}
```

## Script rules

Script rules in the JSON form of the `--script` file, see [Scripted faults](../faults/scripted-faults.md). They change the server's behavior at runtime, without a restart.

### GET /v1/script/rules

The rules with their counters: `id`, the `rule`, `matched` (how often the rule matched an event) and `hits` (how often it acted).

```bash
curl http://127.0.0.1:8143/v1/script/rules
# [{"id":1,"rule":{"on":"command","command":"SELECT","times":1,"send":"$TAG NO [UNAVAILABLE] Try again later\r\n"},"matched":0,"hits":0}]
```

### POST /v1/script/rules

Body: a rule, or an array of rules. Answers `201` with the added rule, or an array of them. If one rule of an array is invalid, none is added and the answer is `400 INVALID`.

```bash
curl -X POST http://127.0.0.1:8143/v1/script/rules \
     -H 'Content-Type: application/json' \
     -d '{"on": "command", "command": "SELECT", "times": 1, "send": "$TAG NO [UNAVAILABLE] Try again later\r\n"}'
# {"id":1,"rule":{"on":"command","command":"SELECT","times":1,"send":"$TAG NO [UNAVAILABLE] Try again later\r\n"},"matched":0,"hits":0}
```

### DELETE /v1/script/rules and /v1/script/rules/\{id\}

Removes every rule, or one rule by its `id`.

```bash
curl -X DELETE http://127.0.0.1:8143/v1/script/rules/1
# {"deleted":true}
curl -X DELETE http://127.0.0.1:8143/v1/script/rules/1
# {"error":{"code":"NONEXISTENT","message":"Script rule 1 does not exist"}}
curl -X DELETE http://127.0.0.1:8143/v1/script/rules
# {"deleted":true}
```

## Plugin routes

These answer only while their plugin is loaded. See [Plugin operations](../control-api/plugin-operations.md) for the rules.

### ACL

`GET /v1/mailboxes/{path}/acl` returns the ACL. `PUT /v1/mailboxes/{path}/acl/{identifier}` with `{ "rights": "lrs" }` sets the rights of an identifier, `+` or `-` in front adds or removes rights. `DELETE /v1/mailboxes/{path}/acl/{identifier}` removes the identifier. All three answer with the new ACL.

```bash
curl http://127.0.0.1:8143/v1/mailboxes/INBOX/acl
# {}
curl -X PUT http://127.0.0.1:8143/v1/mailboxes/INBOX/acl/alice -H 'Content-Type: application/json' -d '{"rights": "lrs"}'
# {"alice":"lrs"}
curl -X PUT http://127.0.0.1:8143/v1/mailboxes/INBOX/acl/alice -H 'Content-Type: application/json' -d '{"rights": "+w"}'
# {"alice":"lrsw"}
curl -X DELETE http://127.0.0.1:8143/v1/mailboxes/INBOX/acl/alice
# {}
```

### QUOTA

`GET /v1/quota` returns the quota root, limits and usage. `PUT /v1/quota` with `{ "STORAGE": 1024, "MESSAGE": 100, "MAILBOX": 10 }` replaces all limits.

```bash
curl http://127.0.0.1:8143/v1/quota
# {"root":"User quota","limits":{},"usage":{"STORAGE":1,"MESSAGE":1,"MAILBOX":2}}
curl -X PUT http://127.0.0.1:8143/v1/quota -H 'Content-Type: application/json' -d '{"STORAGE": 1024, "MESSAGE": 100}'
# {"root":"User quota","limits":{"STORAGE":1024,"MESSAGE":100},"usage":{"STORAGE":1,"MESSAGE":1,"MAILBOX":2}}
```

### METADATA

`GET` and `PUT /v1/metadata` read and set the server annotations, `GET` and `PUT /v1/mailboxes/{path}/metadata` those of a mailbox (METADATA only, with METADATA-SERVER they answer `400 INVALID`). A `PUT` body is an object of entry names and values, `null` removes an entry. Both answer with all annotations afterwards.

```bash
curl -X PUT http://127.0.0.1:8143/v1/metadata -H 'Content-Type: application/json' -d '{"/shared/comment": "Test server"}'
# {"/shared/comment":"Test server"}
curl -X PUT http://127.0.0.1:8143/v1/mailboxes/INBOX/metadata -H 'Content-Type: application/json' -d '{"/private/comment": "My inbox"}'
# {"/private/comment":"My inbox"}
curl http://127.0.0.1:8143/v1/mailboxes/INBOX/metadata
# {"/private/comment":"My inbox"}
```

### SPECIAL-USE

`PUT /v1/mailboxes/{path}/special-use` with `{ "specialUse": ["\\Sent"] }` replaces the special-use attributes and answers with the `MailboxInfo`.

```bash
curl -X PUT http://127.0.0.1:8143/v1/mailboxes/Sent/special-use -H 'Content-Type: application/json' -d '{"specialUse": ["\\Sent"]}'
# {"path":"Sent","delimiter":"/","flags":["\\HasNoChildren"],"selectable":true,"subscribed":false,"messages":0,"unseen":0,"uidnext":1,"uidvalidity":5,"permanentFlags":["\\Answered","\\Flagged","\\Draft","\\Deleted","\\Seen"],"specialUse":["\\Sent"]}
```

## OAuth

The routes of the [OAuth provider](../guides/oauth.md), with the `oauth` option or `--oauth-port`. The examples use a server started with `--oauth-port=8085` as well.

`GET /v1/oauth` describes the provider: issuer, discovery URL, default consent policy, scopes, clients (without secrets) and the queued decisions and token faults.

```bash
curl http://127.0.0.1:8143/v1/oauth
# {"issuer":"http://127.0.0.1:8085","discovery":"http://127.0.0.1:8085/.well-known/openid-configuration","consent":"prompt","mailScope":"mail","scopes":["openid","email","profile","offline_access","mail"],"clients":[{"id":"imapkit","name":"ImapKit test client","confidential":false,"redirectUris":["http://127.0.0.1/*","http://localhost/*","http://[::1]/*"],"consent":null},...],"decisions":[],"tokenFaults":[]}
```

`PUT /v1/oauth/clients/{id}` registers or replaces a client (`{ name, secret, redirectUris, consent }`), `DELETE` removes one. `PUT /v1/oauth/consent` sets the default policy (`{ consent }`).

```bash
curl -X PUT http://127.0.0.1:8143/v1/oauth/clients/my-mail-app -H 'Content-Type: application/json' -d '{"name":"My Mail App","consent":"approve"}'
# {"id":"my-mail-app","name":"My Mail App","confidential":false,"redirectUris":["http://127.0.0.1/*","http://localhost/*","http://[::1]/*"],"consent":"approve"}
curl -X PUT http://127.0.0.1:8143/v1/oauth/consent -H 'Content-Type: application/json' -d '{"consent":"deny"}'
# {"consent":"deny"}
```

`POST /v1/oauth/decisions` queues the decision of the next sign-ins (`{ decision, client, user, count }`), `GET` lists and `DELETE` removes them. `POST /v1/oauth/token-faults` queues a fault of the token endpoint (`{ grant, error, description, status, html, delay, claims, count }`), `DELETE` removes them.

```bash
curl -X POST http://127.0.0.1:8143/v1/oauth/decisions -H 'Content-Type: application/json' -d '{"decision":{"error":"temporarily_unavailable"},"client":"my-mail-app"}'
# {"id":1}
curl http://127.0.0.1:8143/v1/oauth/decisions
# [{"id":1,"decision":{"error":"temporarily_unavailable"},"client":"my-mail-app","remaining":1}]
curl -X POST http://127.0.0.1:8143/v1/oauth/token-faults -H 'Content-Type: application/json' -d '{"grant":"refresh_token","error":"invalid_grant"}'
# {"id":2}
```

`GET /v1/oauth/tokens` lists the issued tokens (`?user=`, `?client=`, `?type=access` or `refresh`). `POST /v1/oauth/tokens/expire` lets access tokens expire now and `POST /v1/oauth/tokens/revoke` revokes tokens, both with `{ user, client, token }` (and `type` for revoke), and answer with the count.

```bash
curl -X POST http://127.0.0.1:8143/v1/oauth/tokens/expire -H 'Content-Type: application/json' -d '{"user":"alice@example.com"}'
# {"expired":1}
curl -X POST http://127.0.0.1:8143/v1/oauth/tokens/revoke -H 'Content-Type: application/json' -d '{}'
# {"revoked":2}
```

### Routes of custom plugins

A plugin of your own adds routes with [`control.register()`](../control-api/plugin-operations.md#controlregistername-fn-routes). They are served after the built-in ones and listed in the OpenAPI document.

## GET /v1/openapi.json

The OpenAPI 3.1 document of the running server, with every route above that the server has.

```bash
curl -s http://127.0.0.1:8143/v1/openapi.json | jq '.paths["/v1/quota"]'
```
