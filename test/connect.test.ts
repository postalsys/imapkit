// server.connect(): connections in memory, without a socket, the way the server runs in a browser

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import imapkit from '../src/index.js';
import { validateResponses } from './helpers/validate-responses.js';
import type { MemorySocket } from '../src/memory-socket.js';

/**
 * Sends commands one by one, each after the tagged response of the one before, and resolves with the transcript once
 * the connection closes
 */
function converse(client: MemorySocket, commands: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        let transcript = '';
        let next = 0;
        let tag = '';
        const sendNext = () => {
            if (next < commands.length) {
                tag = 'A' + (next + 1);
                client.write(tag + ' ' + commands[next++] + '\r\n');
            }
        };
        client.setEncoding('binary');
        client.on('data', (chunk: string) => {
            transcript += chunk;
            if (transcript.startsWith('* OK') && !tag) {
                sendNext();
            } else if (new RegExp('^' + tag + ' ', 'm').test(chunk)) {
                sendNext();
            }
        });
        client.on('error', reject);
        client.on('close', () => resolve(transcript));
    });
}

const storage = {
    INBOX: { messages: [{ raw: 'Subject: hello\r\n\r\nWorld\r\n', flags: ['\\Seen'] }] },
    '': {}
};

describe('server.connect()', () => {
    it('runs a session without listening, as an encrypted connection by default', async () => {
        const server = imapkit({ plugins: ['STARTTLS', 'LOGINDISABLED'], storage });
        const sessions: any[] = [];
        server.on('session', event => sessions.push(event));
        const client = server.connect();
        assert.equal(client.encrypted, true);
        const transcript = await converse(client, ['CAPABILITY', 'LOGIN testuser testpass', 'SELECT INBOX', 'FETCH 1 (FLAGS BODY[])', 'LOGOUT']);
        await validateResponses(transcript);
        assert.match(transcript, /^\* OK ImapKit ready/);
        assert.match(transcript, /^\* CAPABILITY IMAP4rev1\r$/m);
        assert.match(transcript, /^A2 OK/m);
        assert.match(transcript, /^\* 1 FETCH \(FLAGS \(\\Seen\) BODY\[\] \{25\}\r\nSubject: hello\r\n\r\nWorld\r\n\)/m);
        assert.match(transcript, /^A5 OK/m);
        assert.equal(sessions[0].type, 'open');
        assert.equal(sessions[0].session.secure, true);
        assert.equal(sessions.at(-1).type, 'close');
        assert.equal(server.connections.size, 0);
    });

    it('starts as plaintext with secure: false, STARTTLS makes the session count as encrypted', async () => {
        const server = imapkit({ plugins: ['STARTTLS', 'LOGINDISABLED'], storage });
        const client = server.connect({ secure: false });
        assert.equal(client.encrypted, false);
        const transcript = await converse(client, [
            'CAPABILITY',
            'LOGIN testuser testpass',
            'STARTTLS',
            'CAPABILITY',
            'STARTTLS',
            'LOGIN testuser testpass',
            'LOGOUT'
        ]);
        await validateResponses(transcript);
        assert.match(transcript, /^\* CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED\r$/m);
        assert.match(transcript, /^A2 NO/m);
        assert.match(transcript, /^A3 OK/m);
        assert.match(transcript, /^\* CAPABILITY IMAP4rev1\r$/m);
        assert.match(transcript, /^A5 BAD/m);
        assert.match(transcript, /^A6 OK/m);
        assert.equal(client.encrypted, true);
    });

    it('reports changes of one in-memory session to another', async () => {
        const server = imapkit({ plugins: ['IDLE'], storage });
        const idler = server.connect();
        idler.setEncoding('binary');
        let output = '';
        const waitFor = (pattern: RegExp) =>
            new Promise<void>(resolve => {
                const check = () => {
                    if (pattern.test(output)) {
                        idler.removeListener('data', check);
                        resolve();
                    }
                };
                idler.on('data', check);
                check();
            });
        idler.on('data', (chunk: string) => (output += chunk));

        await waitFor(/^\* OK/m);
        idler.write('I1 LOGIN testuser testpass\r\nI2 SELECT INBOX\r\n');
        await waitFor(/^I2 OK/m);
        idler.write('I3 IDLE\r\n');
        await waitFor(/^\+ /m);

        const transcript = await converse(server.connect(), ['LOGIN testuser testpass', 'SELECT INBOX', 'STORE 1 +FLAGS (\\Flagged)', 'LOGOUT']);
        assert.match(transcript, /^A3 OK/m);
        await waitFor(/^\* 1 FETCH \(UID 1 FLAGS \(\\Seen \\Flagged\)\)/m);

        idler.write('DONE\r\n');
        await waitFor(/^I3 OK/m);
        const closed = new Promise(resolve => idler.once('close', resolve));
        idler.end();
        await closed;
        await validateResponses(output);
        assert.equal(server.connections.size, 0);
    });

    it('closes the session when the client ends the connection', async () => {
        const server = imapkit({ storage });
        const client = server.connect();
        const events: string[] = [];
        server.on('session', event => events.push(event.type));
        client.on('end', () => events.push('client end'));
        const closed = new Promise(resolve => client.once('close', resolve));
        client.once('data', () => client.end());
        await closed;
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(events, ['close']);
        assert.equal(server.connections.size, 0);
    });

    it('gives the client an ECONNRESET error for close: reset of a script rule', async () => {
        const server = imapkit({ storage, script: { on: 'command', command: 'NOOP', send: '* BYE\r\n', close: 'reset' } });
        const client = server.connect();
        let transcript = '';
        client.setEncoding('binary');
        client.on('data', (chunk: string) => (transcript += chunk));
        const error = new Promise<Error & { code?: string }>(resolve => client.once('error', resolve));
        client.once('data', () => client.write('A1 NOOP\r\n'));
        assert.equal((await error).code, 'ECONNRESET');
        assert.match(transcript, /^\* BYE\r$/m);
    });

    it('closes in-memory connections with server.close()', async () => {
        const server = imapkit({ storage });
        const client = server.connect();
        await new Promise(resolve => client.once('data', resolve));
        const closed = new Promise(resolve => client.once('close', resolve));
        server.close(() => false);
        await closed;
        assert.equal(client.destroyed, true);
        assert.equal(server.connections.size, 0);
    });

    it('delivers every write as its own chunk, in order, and holds data while paused', async () => {
        const server = imapkit({ storage, script: { on: 'response', command: 'NOOP', untagged: false, chunk: 4, chunkDelay: 'tick' } });
        const client = server.connect();
        const chunks: string[] = [];
        client.setEncoding('binary');
        client.on('data', (chunk: string) => chunks.push(chunk));
        await new Promise(resolve => client.once('data', resolve));
        client.pause();
        client.write('A1 NOOP\r\n');
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(chunks.length, 1);
        client.resume();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(chunks.slice(1).join(''), 'A1 OK Completed\r\n');
        assert.deepEqual(
            chunks.slice(1).map(chunk => chunk.length),
            [4, 4, 4, 4, 1]
        );
        client.destroy();
    });
});
