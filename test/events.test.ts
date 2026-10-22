// The append and trace server events, and the implicit TLS listener of the tls option, which a GUI or a test harness
// uses to follow what clients do

import { describe, it } from 'node:test';
import assert from 'node:assert';
import tls from 'node:tls';
import imapkit from '../src/server.js';
import { setupServer } from './helpers/index.js';
import { useSessions } from './helpers/session.js';
import type { Mailbox, Message } from '../src/types.js';

const message = (n: number) => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';

function storage() {
    return {
        INBOX: { uidvalidity: 100, messages: [1, 2].map(n => ({ raw: message(n), uid: n })) },
        '': { folders: { Archive: { uidvalidity: 200, messages: [] } } }
    };
}

describe('append event', () => {
    const ctx = setupServer(() => ({ storage: storage(), plugins: ['MOVE'] }));
    const open = useSessions(ctx);

    it('fires for every added message with the session that added it', async () => {
        const events: string[] = [];
        ctx.server.on('append', (mailbox: Mailbox, messages: Message[], origin: { sessionNumber: number } | null) =>
            events.push(mailbox.path + ' ' + messages.map(entry => entry.uid).join(',') + ' ' + (origin ? origin.sessionNumber : '-'))
        );
        const { cmd } = await open('INBOX');
        const session = ctx.server.control.sessions()[0].session;
        assert.match(await cmd('APPEND INBOX {' + message(3).length + '}\r\n' + message(3)), /^T\d+ OK/m);
        assert.match(await cmd('COPY 1 Archive'), /^T\d+ OK/m);
        assert.match(await cmd('MOVE 2 Archive'), /^T\d+ OK/m);
        ctx.server.control.addMessage('Archive', { raw: message(4) });
        assert.deepStrictEqual(events, ['INBOX 3 ' + session, 'Archive 1 ' + session, 'Archive 2 ' + session, 'Archive 3 -']);
    });
});

describe('trace event', () => {
    const ctx = setupServer(() => ({ storage: storage(), plugins: ['COMPRESS'] }));
    const open = useSessions(ctx);

    it('has the protocol traffic of a session in order', async () => {
        const traced: string[] = [];
        ctx.server.on('trace', ({ session, direction, data }) => traced.push(session + ' ' + direction + ' ' + data.toString('binary')));
        const { cmd } = await open();
        await cmd('NOOP');
        const session = ctx.server.control.sessions()[0].session;
        // the text of the OK responses is left out, the tags count up over the tests
        assert.deepStrictEqual(
            traced.map(line => line.replace(/ OK .*\r\n$/, ' OK').replace(/\bT\d+ /, 'T ')),
            [session + ' out * OK', session + ' in T LOGIN testuser testpass\r\n', session + ' out T OK', session + ' in T NOOP\r\n', session + ' out T OK']
        );
    });

    // RFC 4978 section 3: everything after the tagged OK is compressed, the trace has the IMAP layer above it
    it('has the uncompressed traffic after COMPRESS', async () => {
        const traced: string[] = [];
        const { cmd } = await open();
        assert.match(await cmd('COMPRESS DEFLATE'), /^T\d+ OK/m);
        ctx.server.on('trace', ({ direction, data }) => traced.push(direction + ' ' + data.toString('binary')));
        await cmd('NOOP');
        assert.match(traced[0], /^in T\d+ NOOP\r\n$/);
        assert.match(traced[1], /^out T\d+ OK Completed\r\n$/);
    });

    it('costs nothing without listeners', async () => {
        const { cmd } = await open();
        assert.strictEqual(ctx.server.listenerCount('trace'), 0);
        assert.match(await cmd('NOOP'), /^T\d+ OK/m);
    });
});

/**
 * Opens an implicit TLS connection, sends the commands one by one and resolves with the transcript after the last
 * tagged response
 */
function tlsTranscript(port: number, commands: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
        let transcript = '';
        let next = 0;
        socket.setEncoding('binary');
        socket.on('data', (chunk: string) => {
            transcript += chunk;
            const waitingFor = next ? 'A' + next + ' ' : '* OK';
            if (new RegExp('^' + waitingFor.replace('*', '\\*'), 'm').test(transcript)) {
                if (next < commands.length) {
                    socket.write('A' + ++next + ' ' + commands[next - 1] + '\r\n');
                } else {
                    socket.end();
                    resolve(transcript);
                }
            }
        });
        socket.on('error', reject);
    });
}

describe('tls option', () => {
    it('starts an implicit TLS listener that shares the storage', async () => {
        const server = imapkit({ storage: storage(), tls: { port: 0 } });
        const port = await server.start(0, '127.0.0.1');
        assert.ok(server.tlsServer);
        const tlsPort = (server.tlsServer.address() as { port: number }).port;
        assert.notStrictEqual(tlsPort, port);

        const sessions: boolean[] = [];
        server.on('session', event => event.type === 'open' && sessions.push(event.session.secure));
        const traced: string[] = [];
        server.on('trace', ({ direction, data }) => traced.push(direction + ' ' + data.toString('binary')));

        server.control.addMessage('INBOX', { raw: message(3) });
        const transcript = await tlsTranscript(tlsPort, ['LOGIN testuser testpass', 'STATUS INBOX (MESSAGES)']);
        assert.match(transcript, /^\* STATUS INBOX \(MESSAGES 3\)\r$/m);
        assert.deepStrictEqual(sessions, [true]);
        // the trace is the plaintext above TLS
        assert.ok(traced.includes('in A1 LOGIN testuser testpass\r\n'), traced.join(''));

        await server.stop();
        assert.strictEqual(server.server.listening, false);
        assert.strictEqual(server.tlsServer, null);
    });

    it('waits for TLS sessions on a graceful shutdown', async () => {
        const server = imapkit({ tls: { port: 0, host: '127.0.0.1' } });
        await server.start(0, '127.0.0.1');
        const tlsServer = server.tlsServer!;
        const socket = tls.connect({ port: (tlsServer.address() as { port: number }).port, host: '127.0.0.1', rejectUnauthorized: false });
        await new Promise(resolve => socket.once('data', resolve));
        let done = false;
        const shutdown = server.control.shutdown().then(() => {
            done = true;
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.strictEqual(done, false);
        assert.strictEqual(tlsServer.listening, false);
        socket.end();
        await shutdown;
        assert.strictEqual(done, true);
    });
});
