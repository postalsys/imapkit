---
title: Event Stream
sidebar_position: 3
description: Follow server events over HTTP with GET /v1/events, a Server-Sent Events stream, to wait for client actions from tests in any language.
---

# Event stream

`GET /v1/events` streams the [server events](../control-api/events.md) as [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html). A test in any language can open the stream, let the client act, and wait for "the client is idling" or "a script rule fired" without polling.

```bash
curl -N 'http://127.0.0.1:8143/v1/events?types=session'
```

```
: connected

event: session
data: {"type":"open","session":{"session":1,"user":null,"state":"Not Authenticated","mailbox":null,"readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"}}

event: session
data: {"type":"login","session":{"session":1,"user":"testuser","state":"Authenticated","mailbox":null,"readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"}}
```

The stream starts with the comment `: connected` as soon as the server listens for events, so a test can wait for it before it lets the client act. Each event is an `event:` line with the type and a `data:` line with JSON, followed by an empty line. A `: ping` comment every 15 seconds keeps proxies from closing an idle stream. The stream stays open until the client closes it or the server stops, a shutdown (graceful or not) ends it. A graceful shutdown leaves open streams open, and they keep the `imapkit` command running until their clients close them. Events that happen while no stream is open are not kept.

## Choosing event types

`?types=` takes a comma separated list. Without it the stream has every type but `trace`, which is only sent when the list names it. The trace holds everything the clients send, including the passwords and tokens of LOGIN and AUTHENTICATE:

| Type      | When                                                                    |
| --------- | ----------------------------------------------------------------------- |
| `session` | a session opens, logs in, selects, unselects, logs out, waits or closes |
| `command` | the tagged response of a command goes out                               |
| `mailbox` | a mailbox is created, deleted, renamed, subscribed or unsubscribed      |
| `append`  | messages are added                                                      |
| `expunge` | messages are removed                                                    |
| `flags`   | the control API or the REST API changed flags                           |
| `acl`     | an ACL changed (ACL plugin)                                             |
| `script`  | a script rule fired                                                     |
| `reset`   | the server was reset                                                    |
| `trace`   | a session received or sent protocol data, only when asked for           |

An unknown type is refused before the stream starts:

```bash
curl -s 'http://127.0.0.1:8143/v1/events?types=session,foo'
# 400 {"error":{"code":"INVALID","message":"Unknown event type foo, expected session, command, mailbox, append, expunge, flags, acl, script, reset, trace"}}
```

## Payloads

The data is the JSON form of the [server event](../control-api/events.md): mailboxes are storage names, messages are UIDs and sessions are session numbers (`origin` is `null` for changes of the control and REST APIs). Below is an excerpt from a real run, with an IMAP client that logs in, selects INBOX, runs a NOOP that a script rule answers, creates a mailbox, stores a flag and logs out, followed by REST calls:

| Type      | Data                                                                                    |
| --------- | --------------------------------------------------------------------------------------- |
| `session` | `{ type, session, command? }`, see [session events](../control-api/events.md#session)   |
| `command` | `{ session, tag, command, status, user }`                                               |
| `mailbox` | `{ type, path, oldPath, origin }`                                                       |
| `append`  | `{ path, uids, origin }`                                                                |
| `expunge` | `{ path, uids, origin }`                                                                |
| `flags`   | `{ path, messages: [{ uid, flags }], origin }`                                          |
| `acl`     | `{ path }`                                                                              |
| `trace`   | `{ session, direction, data, encoding }`, `data` is base64 and `encoding` is `"base64"` |
| `script`  | `{ rule, event, session, tag, command }`                                                |
| `reset`   | `{}`                                                                                    |

```
event: acl
data: {"path":"INBOX"}

event: session
data: {"type":"open","session":{"session":2,"user":null,"state":"Not Authenticated","mailbox":null,"readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"}}

event: command
data: {"session":2,"tag":"CHEN1","command":"LOGIN","status":"OK","user":"testuser"}

event: session
data: {"type":"login","session":{"session":2,"user":"testuser","state":"Authenticated","mailbox":null,"readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"}}

event: session
data: {"type":"select","session":{"session":2,"user":"testuser","state":"Selected","mailbox":"INBOX","readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":"::ffff:127.0.0.1"}}

event: command
data: {"session":2,"tag":"CHEN3","command":"SELECT","status":"OK","user":"testuser"}

event: script
data: {"rule":{"on":"command","command":"NOOP","times":1,"send":"$TAG NO Scripted\r\n"},"event":"command","session":2,"tag":"CHEN4","command":"NOOP"}

event: mailbox
data: {"type":"create","path":"Projects","oldPath":null,"origin":2}

event: command
data: {"session":2,"tag":"CHEN6","command":"UID STORE","status":"OK","user":"testuser"}

event: session
data: {"type":"close","session":{"session":2,"user":"testuser","state":"Logout","mailbox":"INBOX","readOnly":false,"enabled":[],"secure":false,"compressed":false,"remoteAddress":null}}

event: flags
data: {"path":"INBOX","messages":[{"uid":105,"flags":["\\Seen"]}],"origin":null}

event: expunge
data: {"path":"INBOX","uids":[105],"origin":null}

event: mailbox
data: {"type":"rename","path":"Done","oldPath":"Projects","origin":null}

event: reset
data: {}
```

Some things to note in this run:

- The NOOP that the script rule answered has a `script` event and no `command` event.
- The client's `UID STORE` has a `command` event and no `flags` event. `flags` is only for flag changes of the control and REST APIs.
- `acl` events carry only the path. Read the ACL with `GET /v1/mailboxes/{path}/acl`.
- A rule that was added from JavaScript with a `RegExp` in `match` shows `{}` in its place, as JSON has no form for it. Rules added over REST keep the string they were given.

## Waiting for an event from Python

The standard library is enough. Start the server with `imapkit -p 1143 --plugin=IDLE --rest-port=8143`:

```python
import json
import urllib.request


def events(base, types):
    """Yields (type, data) for every event of the stream"""
    response = urllib.request.urlopen(base + "/v1/events?types=" + ",".join(types))
    event_type, data = None, []
    for raw in response:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line.startswith("event:"):
            event_type = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].strip())
        elif line == "" and event_type:
            yield event_type, json.loads("\n".join(data))
            event_type, data = None, []


for event_type, data in events("http://127.0.0.1:8143", ["session"]):
    print(event_type, data["type"], data["session"]["mailbox"])
    if data["type"] == "select" and data["session"]["mailbox"] == "INBOX":
        print("session", data["session"]["session"], "selected INBOX")
        break
```

Output while a client logs in and selects INBOX:

```
session open None
session login None
session select INBOX
session 1 selected INBOX
```

In a test, run the generator in a thread (or open the stream before the client starts and read it after), so that the stream is open before the client acts.

## Waiting for an event from JavaScript

Node.js 20 and newer have `fetch()`, no packages needed. This waits until a client idles and then delivers a message, which the idling client sees as `* 1 EXISTS` right away:

```javascript
async function waitForEvent(base, types, predicate) {
    const response = await fetch(`${base}/v1/events?types=${types.join(',')}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) {
            throw new Error('Event stream closed');
        }
        buffer += value;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const type = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (type && data && predicate(type, JSON.parse(data))) {
                await reader.cancel();
                return JSON.parse(data);
            }
        }
    }
}

const base = 'http://127.0.0.1:8143';
const event = await waitForEvent(base, ['session'], (type, data) => data.type === 'waiting' && data.command === 'IDLE');
console.log('session %d is idling', event.session.session);
const response = await fetch(`${base}/v1/mailboxes/INBOX/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: 'Subject: new\r\n\r\nHello\r\n' })
});
console.log(response.status, await response.json());
```

```
session 1 is idling
201 { uid: 1, uidvalidity: 1 }
```

Any Server-Sent Events client library works as well, the stream is plain SSE. A test that runs in Node.js against an in-process server can listen to the [server events](../control-api/events.md) directly instead.

With a token, send `Authorization: Bearer <token>` on the stream request like on any other.
