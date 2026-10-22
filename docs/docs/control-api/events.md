---
title: Events
sidebar_position: 5
description: Server events for sessions, commands, mailbox changes, new messages, expunges, flag changes, ACL changes, script rules and resets, and how to wait for them in tests instead of polling.
---

# Events

The server is a Node.js `EventEmitter`. Its events tell a test what the client is doing, so the test can wait for "the client is idling" or "the client selected INBOX" and then act, instead of sleeping or polling. Tests in other languages get the same events from the [REST event stream](../rest-api/event-stream.md).

| Event     | Arguments                                            | When                                                                    |
| --------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `session` | `{ type, session, command? }`                        | a session opens, logs in, selects, unselects, logs out, waits or closes |
| `command` | `{ session, tag, command, status, user }`            | the tagged response of a command goes out                               |
| `mailbox` | `{ type, path, oldPath, mailbox, origin, created? }` | a mailbox is created, deleted, renamed, subscribed or unsubscribed      |
| `append`  | `(mailbox, messages, origin)`                        | messages are added                                                      |
| `expunge` | `(mailbox, messages, origin)`                        | messages are removed                                                    |
| `flags`   | `(mailbox, messages, origin)`                        | the control API changed flags                                           |
| `acl`     | `(mailbox, previousAcl)`                             | an ACL changed (ACL plugin)                                             |
| `script`  | `{ rule, event, session, tag, command }`             | a [script rule](../faults/scripted-faults.md) fired                     |
| `reset`   | none                                                 | `control.reset()` restored the server                                   |
| `trace`   | `{ session, direction, data }`                       | a session received or sent protocol data                                |

Listeners run synchronously, while the server is in the middle of the change. Calling the control API from a listener is fine, its changes have no session as their origin like any other control API call.

## session

`{ type, session }`, where `session` is the session as [`sessions()`](./users-and-sessions.md#sessions) describes it, at the moment of the event. `type` is one of:

| `type`     | When                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `open`     | a client connected                                                                                                                    |
| `login`    | a command authenticated the session (LOGIN, AUTHENTICATE), right after the `command` event of that command                            |
| `select`   | SELECT or EXAMINE opened a mailbox, also when the same mailbox is selected again                                                      |
| `unselect` | the selected mailbox was closed: CLOSE, UNSELECT, a failed SELECT, or a BYE from the server                                           |
| `logout`   | the session went back to Not Authenticated (UNAUTHENTICATE)                                                                           |
| `waiting`  | a command waits for client input after its continuation, the event has `command` too, e.g. `IDLE` after `+ idling`, or `AUTHENTICATE` |
| `close`    | the connection closed                                                                                                                 |

A real sequence, from a client that logs in as `alice`, selects INBOX and starts IDLE:

```json
{"type":"open","session":{"session":1,"user":null,"state":"Not Authenticated","mailbox":null,"readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"}}
{"type":"login","session":{"session":1,"user":"alice","state":"Authenticated","mailbox":null,"readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"}}
{"type":"select","session":{"session":1,"user":"alice","state":"Selected","mailbox":"INBOX","readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"}}
{"type":"waiting","session":{"session":1,"user":"alice","state":"Selected","mailbox":"INBOX","readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"},"command":"IDLE"}
```

In the `close` event `remoteAddress` is `null`, as the socket is gone. After LOGOUT or a BYE, `state` is `Logout`.

## command

`{ session, tag, command, status, user }` when the tagged response of a command is about to be written:

| Field     | Description                                                  |
| --------- | ------------------------------------------------------------ |
| `session` | session number                                               |
| `tag`     | the command tag                                              |
| `command` | the command name in upper case, `UID FETCH` for UID commands |
| `status`  | `OK`, `NO` or `BAD`                                          |
| `user`    | the logged in user after the command, null before login      |

```json
{"session":1,"tag":"A1","command":"LOGIN","status":"OK","user":"alice"}
{"session":1,"tag":"A2","command":"SELECT","status":"OK","user":"alice"}
```

The event fires when the server sends the response, the client may not have read it yet. A command that a script rule answered instead of the command handler has no `command` event, the `script` event reports it instead.

## mailbox

`{ type, path, oldPath, mailbox, origin }` for a mailbox change, from a command or the control API:

| Field     | Description                                                                             |
| --------- | --------------------------------------------------------------------------------------- |
| `type`    | `create`, `delete`, `rename`, `subscribe` or `unsubscribe`                              |
| `path`    | storage name of the mailbox, the new name for `rename`                                  |
| `oldPath` | the old name for `rename`, otherwise null                                               |
| `mailbox` | the removed mailbox object for `delete`, otherwise null                                 |
| `origin`  | the `IMAPConnection` whose command made the change, null for the control API (and SMTP) |
| `created` | `create` only: every mailbox the create made, superior levels first                     |

`subscribe` and `unsubscribe` fire only when the subscription changed. Renaming INBOX is a `rename` from `INBOX` to the new name.

```javascript
server.on('mailbox', event => console.log(event.type, event.path, event.created));
server.control.createMailbox('Archive/2024');
// create Archive/2024 [ 'Archive', 'Archive/2024' ]
```

## append

`(mailbox, messages, origin)`: the mailbox object, the added message objects and the session that added them (null for the control API and SMTP). It fires for every added message, from APPEND (once per message of a MULTIAPPEND), COPY, MOVE, REPLACE, the SMTP listener and the control API, after the message has its UID and before the sessions get their EXISTS responses.

```javascript
server.on('append', (mailbox, messages, origin) => {
    console.log(
        mailbox.path,
        messages.map(message => message.uid),
        origin && origin.sessionNumber
    );
});
```

## expunge

`(mailbox, messages, origin)`: the mailbox object, the removed message objects and the session that caused it (null for the control API). It fires for every removal, from EXPUNGE, CLOSE, MOVE, UID EXPUNGE and the control API, before the sessions get their EXPUNGE or VANISHED responses.

```javascript
server.on('expunge', (mailbox, messages, origin) => {
    console.log(
        mailbox.path,
        messages.map(message => message.uid),
        origin && origin.sessionNumber
    );
});
```

## flags

`(mailbox, messages, origin)` for flag changes of `control.setFlags()`, with only the messages whose flags changed. STORE commands of the sessions do not emit it, watch the `command` event for them.

## acl

`(mailbox, previousAcl)` when an ACL changes, from SETACL, DELETEACL or the control API, with the ACL plugin loaded. `previousAcl` is a `Map` of identifier to a `Set` of rights. Read the new ACL with `control.getAcl(mailbox.path)`.

## trace

`{ session, direction, data }` for the protocol traffic of a session: the session number, `in` for what the client sent or `out` for what the server sent, and the octets as a Buffer. The trace is the IMAP layer, above TLS and COMPRESS=DEFLATE, so a session on the implicit TLS listener, after STARTTLS or after COMPRESS shows the same plaintext commands and responses as a plaintext one. A chunk is what one read or one write held: a command can arrive in several chunks, and one chunk can hold several commands or responses.

Nothing is traced while no listener is registered, so the event costs nothing otherwise. The trace holds everything the client sends, including the passwords and tokens of LOGIN and AUTHENTICATE.

```javascript
server.on('trace', ({ session, direction, data }) => {
    process.stdout.write(session + (direction === 'in' ? ' C: ' : ' S: ') + data.toString('binary'));
});
```

## script

`{ rule, event, session, tag, command }` when a script rule fires: the rule as it was added, the event it watched (`greeting`, `command`, `input`, `response` ...), the session number, and the tag and command name of the command it belongs to. See [Scripted faults](../faults/scripted-faults.md).

## reset

No arguments. Emitted by `control.reset()` after the storage and users are restored. Plugins listen to it to restore their own state, and a long running test harness can use it to clear what it tracks.

## Recipes

### Wait for one event

`events.once()` from Node.js resolves with the arguments of the next event. Add a filter for a particular event:

```javascript
import { once } from 'node:events';

function waitFor(server, name, predicate = () => true) {
    return new Promise(resolve => {
        const listener = (...args) => {
            if (predicate(...args)) {
                server.removeListener(name, listener);
                resolve(args[0]);
            }
        };
        server.on(name, listener);
    });
}

const [opened] = await once(server, 'session'); // the next session event, whatever it is
```

Create the promise **before** you let the client act, so the event can not fire before the listener is in place.

### Deliver a message while the client idles

```javascript
const server = imapkit({ plugins: ['IDLE'] });
const port = await server.start();

const idling = waitFor(server, 'session', event => event.type === 'waiting' && event.command === 'IDLE');
// ... start the client, let it select INBOX and IDLE
await idling;
server.control.addMessage('INBOX', { raw: 'Subject: hello\r\n\r\nHi!\r\n' });
// the idling client gets * 1 EXISTS right away
```

### Wait for the client to select a mailbox

```javascript
const selected = waitFor(server, 'session', event => event.type === 'select' && event.session.mailbox === 'INBOX');
// ... let the client open INBOX
const { session } = await selected;
server.control.expungeMessages('INBOX', [1]); // or anything the client must cope with while INBOX is open
```

### Wait for a command to finish

```javascript
const stored = waitFor(server, 'command', event => event.command === 'UID STORE' && event.status === 'OK');
// ... let the client mark a message as read
await stored;
assert.deepStrictEqual(server.control.getMessage('INBOX', 1, { raw: false }).flags, ['\\Seen']);
```

### Wait for a session to go away

```javascript
const closed = waitFor(server, 'session', event => event.type === 'close' && event.session.session === 1);
server.control.disconnect(1, { reset: true });
await closed;
```
