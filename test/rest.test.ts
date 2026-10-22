// The REST API (src/rest.ts): the control API over HTTP, its error mapping and its access rules.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import imapkit from '../src/server.js';
import { getRoutes } from '../src/rest.js';
import { openSession } from './helpers/session.js';
import type { IMAPServer } from '../src/server.js';
import type { Session } from './helpers/session.js';
import type { AddressInfo } from 'node:net';

const message = (n: number) => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';

function storage() {
    return {
        INBOX: { uidvalidity: 100, messages: [1, 2].map(n => ({ raw: message(n), uid: n })) },
        '': { folders: { Work: { folders: { Projects: { uidvalidity: 300, messages: [] } } } } }
    };
}

interface Reply {
    status: number;
    body: any;
}

describe('REST API', () => {
    let server: IMAPServer;
    let base: string;

    // the hooks return promises, Deno does not pass a done callback to node:test hooks
    beforeEach(async () => {
        server = imapkit({ storage: storage(), plugins: ['IDLE'], rest: { port: 0 } });
        await server.start();
        base = 'http://127.0.0.1:' + (server.restServer!.address() as { port: number }).port;
    });
    afterEach(() => server.stop());

    const call = async (method: string, path: string, body?: unknown): Promise<Reply> => {
        const init: RequestInit = { method };
        if (body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }
        const res = await fetch(base + path, init);
        return { status: res.status, body: await res.json() };
    };

    it('lists and describes mailboxes, a "/" in a name is %2F', async () => {
        const list = await call('GET', '/v1/mailboxes');
        assert.strictEqual(list.status, 200);
        assert.deepStrictEqual(
            list.body.map((mailbox: { path: string }) => mailbox.path),
            ['INBOX', 'Work', 'Work/Projects']
        );
        const one = await call('GET', '/v1/mailboxes/Work%2FProjects');
        assert.strictEqual(one.body.uidvalidity, 300);
        const missing = await call('GET', '/v1/mailboxes/Nope');
        assert.deepStrictEqual(missing, { status: 404, body: { error: { code: 'NONEXISTENT', message: 'Mailbox "Nope" does not exist' } } });
    });

    it('adds a message that an idling session sees right away', async () => {
        const session = await new Promise<Session>(resolve => openSession((server.address() as AddressInfo).port, resolve));
        await new Promise(resolve => session.run('A1 LOGIN testuser testpass', resolve));
        await new Promise(resolve => session.run('A2 SELECT INBOX', resolve));
        const idling = new Promise(resolve => server.on('session', event => event.type === 'waiting' && resolve(event)));
        session.raw('A3 IDLE\r\n');
        await idling;
        const exists = new Promise<string>(resolve => session.expect(/^\* 3 EXISTS/, resolve));

        const added = await call('POST', '/v1/mailboxes/INBOX/messages', {
            raw: Buffer.from(message(3)).toString('base64'),
            encoding: 'base64',
            flags: ['\\Seen']
        });
        assert.deepStrictEqual(added, { status: 201, body: { uid: 3, uidvalidity: 100 } });
        assert.match(await exists, /^\* 3 EXISTS$/m);
        session.close();

        const fetched = await call('GET', '/v1/mailboxes/INBOX/messages/3');
        assert.strictEqual(Buffer.from(fetched.body.raw, 'base64').toString(), message(3));
        assert.strictEqual(fetched.body.encoding, 'base64');
        assert.deepStrictEqual(fetched.body.flags, ['\\Seen']);
        const text = await call('POST', '/v1/mailboxes/INBOX/messages', { raw: 'Subject: text\r\n\r\nä\r\n' });
        assert.strictEqual(text.status, 201);
        const listed = await call('GET', '/v1/mailboxes/INBOX/messages?uids=4&raw=true');
        assert.strictEqual(Buffer.from(listed.body[0].raw, 'base64').toString(), 'Subject: text\r\n\r\nä\r\n');
        assert.strictEqual((await call('GET', '/v1/mailboxes/INBOX/messages')).body.length, 4);
    });

    it('changes flags, copies, moves and expunges messages', async () => {
        assert.deepStrictEqual((await call('POST', '/v1/mailboxes/INBOX/messages/flags', { uids: [1], flags: ['\\Flagged'], mode: 'add' })).body, [
            { uid: 1, flags: ['\\Flagged'] }
        ]);
        assert.deepStrictEqual((await call('POST', '/v1/mailboxes/INBOX/messages/copy', { uids: [1], target: 'Work/Projects' })).body, {
            uidvalidity: 300,
            uids: [{ uid: 1, targetUid: 1 }]
        });
        assert.strictEqual((await call('POST', '/v1/mailboxes/INBOX/messages/move', { uids: [2], target: 'Work/Projects' })).status, 200);
        assert.deepStrictEqual((await call('POST', '/v1/mailboxes/INBOX/messages/expunge', { uids: [1] })).body, { uids: [1] });
        assert.deepStrictEqual((await call('DELETE', '/v1/mailboxes/Work%2FProjects/messages/2')).body, { uids: [2] });
        assert.strictEqual(server.control.getMailbox('INBOX').messages, 0);
        assert.strictEqual((await call('POST', '/v1/mailboxes/INBOX/messages/flags', { uids: [9], flags: [] })).status, 404);
        assert.strictEqual((await call('POST', '/v1/mailboxes/INBOX/messages/flags', { uids: [1], flags: ['\\Recent'] })).status, 404);
        assert.strictEqual((await call('GET', '/v1/mailboxes/INBOX/messages/abc')).status, 400);
    });

    it('manages mailboxes and subscriptions', async () => {
        assert.strictEqual((await call('POST', '/v1/mailboxes', { path: 'New', subscribed: true })).status, 201);
        assert.deepStrictEqual((await call('POST', '/v1/mailboxes', { path: 'New' })).body.error.code, 'ALREADYEXISTS');
        assert.strictEqual((await call('POST', '/v1/mailboxes', { path: 'New' })).status, 409);
        assert.strictEqual((await call('POST', '/v1/mailboxes/New/rename', { newPath: 'Old' })).body.path, 'Old');
        // the subscription stays with the old name (RFC 9051 section 6.3.6)
        assert.deepStrictEqual((await call('DELETE', '/v1/mailboxes/New/subscription')).body, { changed: true });
        assert.deepStrictEqual((await call('PUT', '/v1/mailboxes/Old/subscription')).body, { changed: true });
        assert.deepStrictEqual((await call('PUT', '/v1/mailboxes/Old/subscription')).body, { changed: false });
        const reset = await call('POST', '/v1/mailboxes/INBOX/uidvalidity', { uids: 'renumber', uidvalidity: 900 });
        assert.strictEqual(reset.body.uidvalidity, 900);
        assert.strictEqual((await call('POST', '/v1/mailboxes/INBOX/uidvalidity', { uidvalidity: 1 })).status, 400);
        assert.deepStrictEqual((await call('DELETE', '/v1/mailboxes/Old')).body, { deleted: true });
        // DELETE of INBOX fails with the RFC 5530 code, a conflict with the state
        assert.deepStrictEqual(await call('DELETE', '/v1/mailboxes/INBOX'), {
            status: 409,
            body: { error: { code: 'CANNOT', message: 'INBOX can not be modified' } }
        });
        const snapshot = await call('GET', '/v1/snapshot');
        assert.deepStrictEqual(Object.keys(snapshot.body.INBOX).includes('messages'), true);
        assert.deepStrictEqual((await call('POST', '/v1/reset', {})).body, { reset: true });
        assert.strictEqual((await call('GET', '/v1/mailboxes/Old')).status, 404);
    });

    it('manages users and sessions', async () => {
        assert.strictEqual((await call('POST', '/v1/users', { name: 'other', password: 'secret' })).status, 201);
        assert.strictEqual((await call('PUT', '/v1/users/other', { password: 'changed' })).status, 200);
        assert.deepStrictEqual((await call('GET', '/v1/users')).body, [
            { name: 'other', xoauth2: false },
            { name: 'testuser', xoauth2: true }
        ]);

        const session = await new Promise<Session>(resolve => openSession((server.address() as AddressInfo).port, resolve));
        await new Promise(resolve => session.run('A1 LOGIN other changed', resolve));
        const sessions = await call('GET', '/v1/sessions');
        assert.strictEqual(sessions.body[0].user, 'other');
        const number = sessions.body[0].session;
        const alert = new Promise<string>(resolve => session.expect(/^\* OK \[ALERT\]/, resolve));
        await call('POST', '/v1/sessions/' + number + '/inject', { data: Buffer.from('* OK [ALERT] hi\r\n').toString('base64'), encoding: 'base64' });
        assert.match(await alert, /^\* OK \[ALERT\] hi$/m);
        const closed = new Promise<string>(resolve => session.whenClosed(resolve));
        assert.deepStrictEqual((await call('DELETE', '/v1/sessions/' + number, { text: 'Bye now' })).body, { disconnected: true });
        assert.match(await closed, /^\* BYE Bye now$/m);
        assert.strictEqual((await call('DELETE', '/v1/sessions/' + number)).status, 404);
        assert.deepStrictEqual((await call('DELETE', '/v1/users/other')).body, { deleted: true });
        assert.strictEqual((await call('DELETE', '/v1/users/other')).status, 404);
    });

    it('adds, lists and removes script rules', async () => {
        const added = await call('POST', '/v1/script/rules', { on: 'command', command: 'NOOP', send: '$TAG NO scripted\r\n' });
        assert.strictEqual(added.status, 201);
        assert.strictEqual(added.body.id, 1);
        const session = await new Promise<Session>(resolve => openSession((server.address() as AddressInfo).port, resolve));
        assert.match(await new Promise<string>(resolve => session.run('A1 NOOP', resolve)), /^A1 NO scripted$/m);
        session.close();
        const rules = await call('GET', '/v1/script/rules');
        assert.deepStrictEqual(
            rules.body.map((rule: { id: number; hits: number }) => [rule.id, rule.hits]),
            [[1, 1]]
        );
        assert.strictEqual((await call('POST', '/v1/script/rules', { on: 'nothing' })).status, 400);
        assert.strictEqual((await call('POST', '/v1/script/rules', [{ on: 'greeting', send: 'x' }])).body[0].id, 2);
        assert.deepStrictEqual((await call('DELETE', '/v1/script/rules/1')).body, { deleted: true });
        assert.strictEqual((await call('DELETE', '/v1/script/rules/1')).status, 404);
        assert.deepStrictEqual((await call('DELETE', '/v1/script/rules')).body, { deleted: true });
        assert.deepStrictEqual((await call('GET', '/v1/script/rules')).body, []);
    });

    it('answers unknown endpoints, wrong methods and bad bodies with JSON errors', async () => {
        assert.strictEqual((await call('GET', '/v1/nothing')).body.error.code, 'NOTFOUND');
        assert.strictEqual((await call('GET', '/v1/nothing')).status, 404);
        assert.strictEqual((await call('PUT', '/v1/snapshot', {})).status, 405);
        assert.strictEqual((await call('GET', '/v1/mailboxes/%E0')).status, 400);
        const notJson = await fetch(base + '/v1/mailboxes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
        assert.strictEqual(notJson.status, 400);
        const scalar = await fetch(base + '/v1/mailboxes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '5' });
        assert.strictEqual(scalar.status, 400);
        // a form post is what a browser page could send cross-origin without a preflight
        const form = await fetch(base + '/v1/shutdown', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
        assert.strictEqual(form.status, 415);
        const bare = await fetch(base + '/v1/shutdown', { method: 'POST' });
        assert.strictEqual(bare.status, 415);
        assert.strictEqual(form.headers.get('access-control-allow-origin'), null);
        assert.strictEqual((await call('POST', '/v1/mailboxes/INBOX/messages', { raw: 'x', encoding: 'hex' })).status, 400);
    });

    it('refuses requests for a host name that is not a loopback one', async () => {
        const status = await new Promise<number>((resolve, reject) => {
            const req = http.request(base + '/v1/snapshot', { headers: { Host: 'rebound.example.com' } }, res => {
                res.resume();
                resolve(res.statusCode as number);
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(status, 401);
    });

    it('streams server events', async () => {
        const abort = new AbortController();
        const res = await fetch(base + '/v1/events?types=mailbox,expunge,flags,session,command', { signal: abort.signal });
        assert.strictEqual(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        let text = '';
        // reads until the stream holds `count` events
        const events = async (count: number) => {
            for (;;) {
                const parsed = [...text.matchAll(/^event: (\w+)\ndata: (.*)\n\n/gm)].map(match => [match[1], JSON.parse(match[2])]);
                if (parsed.length >= count) {
                    return parsed;
                }
                const { value } = await reader.read();
                text += Buffer.from(value as Uint8Array).toString();
            }
        };
        await events(0);
        // the connected comment arrived, the listeners are in place
        while (!text.includes(': connected')) {
            text += Buffer.from((await reader.read()).value as Uint8Array).toString();
        }
        server.control.createMailbox('Events');
        server.control.setFlags('INBOX', [1], ['\\Seen']);
        server.control.expungeMessages('INBOX', [2]);
        const session = await new Promise<Session>(resolve => openSession((server.address() as AddressInfo).port, resolve));
        await new Promise(resolve => session.run('A1 LOGIN testuser testpass', resolve));
        const received = await events(6);
        session.close();
        abort.abort();
        assert.deepStrictEqual(received.slice(0, 3), [
            ['mailbox', { type: 'create', path: 'Events', oldPath: null, origin: null }],
            ['flags', { path: 'INBOX', messages: [{ uid: 1, flags: ['\\Seen'] }], origin: null }],
            ['expunge', { path: 'INBOX', uids: [2], origin: null }]
        ]);
        assert.deepStrictEqual(
            received.slice(3).map(([type, data]) => type + ' ' + (data.type || data.command)),
            ['session open', 'command LOGIN', 'session login']
        );
        assert.strictEqual((await call('GET', '/v1/events?types=nope')).status, 400);
    });

    it('streams append events, and trace events only when asked for', async () => {
        const abort = new AbortController();
        const res = await fetch(base + '/v1/events?types=append,trace', { signal: abort.signal });
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        let text = '';
        while (!text.includes(': connected')) {
            text += Buffer.from((await reader.read()).value as Uint8Array).toString();
        }
        server.control.addMessage('INBOX', { raw: message(3) });
        const session = await new Promise<Session>(resolve => openSession((server.address() as AddressInfo).port, resolve));
        await new Promise(resolve => session.run('A1 LOGIN testuser testpass', resolve));
        const parse = () => [...text.matchAll(/^event: (\w+)\ndata: (.*)\n\n/gm)].map(match => [match[1], JSON.parse(match[2])]);
        while (!parse().some(([type, data]) => type === 'trace' && Buffer.from(data.data, 'base64').toString().startsWith('A1 OK'))) {
            text += Buffer.from((await reader.read()).value as Uint8Array).toString();
        }
        session.close();
        abort.abort();
        const received = parse();
        assert.deepStrictEqual(received[0], ['append', { path: 'INBOX', uids: [3], origin: null }]);
        const traced = received.slice(1).map(([type, data]) => [type, data.direction, data.encoding, Buffer.from(data.data, 'base64').toString().slice(0, 5)]);
        assert.deepStrictEqual(traced, [
            ['trace', 'out', 'base64', '* OK '],
            ['trace', 'in', 'base64', 'A1 LO'],
            ['trace', 'out', 'base64', 'A1 OK']
        ]);
        assert.match((await call('GET', '/v1/events?types=nope')).body.error.message, /expected session, command, mailbox, append, .*, reset, trace$/);
    });

    it('ends open event streams on a graceful shutdown', async () => {
        const res = await fetch(base + '/v1/events?types=session');
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const rest = server.restServer!;
        const closed = new Promise(resolve => rest.once('close', resolve));
        await server.control.shutdown();
        // the stream ends instead of keeping the shutdown waiting
        for (;;) {
            const { done } = await reader.read();
            if (done) {
                break;
            }
        }
        await closed;
        assert.strictEqual(server.server.listening, false);
    });

    it('describes itself as OpenAPI', async () => {
        const doc = (await call('GET', '/v1/openapi.json')).body;
        assert.strictEqual(doc.openapi, '3.1.0');
        // every route of the table is in the document
        for (const route of getRoutes(server)) {
            assert.ok(doc.paths[route.path] && doc.paths[route.path][route.method.toLowerCase()], route.method + ' ' + route.path);
        }
    });

    it('shuts the server down', async () => {
        assert.deepStrictEqual(await call('POST', '/v1/shutdown', { graceful: false }), { status: 202, body: { shutdown: true } });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.strictEqual(server.server.listening, false);
        assert.strictEqual(server.restServer, null);
    });
});

describe('REST API access', () => {
    it('needs the token when one is set', async () => {
        const server = imapkit({ rest: { port: 0, token: 'sekret' } });
        await server.start();
        const base = 'http://127.0.0.1:' + (server.restServer!.address() as { port: number }).port;
        const missing = await fetch(base + '/v1/users');
        assert.strictEqual(missing.status, 401);
        assert.strictEqual(missing.headers.get('www-authenticate'), 'Bearer');
        assert.strictEqual((await fetch(base + '/v1/users', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
        assert.strictEqual((await fetch(base + '/v1/users', { headers: { Authorization: 'Bearer sekret' } })).status, 200);
        await server.stop();
    });

    it('refuses to listen on other addresses without a token', async () => {
        const server = imapkit({ rest: { port: 0, host: '0.0.0.0' } });
        await assert.rejects(server.start(), /needs a token/);
        await server.stop();
        const empty = imapkit({ rest: { port: 0, token: '' } });
        await assert.rejects(empty.start(), /token must be a non-empty string/);
        await empty.stop();
    });

    it('listens on another address with a token', async () => {
        const server = imapkit({ rest: { port: 0, host: '0.0.0.0', token: 'sekret' } });
        await server.start();
        const port = (server.restServer!.address() as AddressInfo).port;
        assert.strictEqual((await fetch('http://127.0.0.1:' + port + '/v1/users', { headers: { Authorization: 'Bearer sekret' } })).status, 200);
        await server.stop();
    });
});
