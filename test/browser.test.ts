// Runs the browser bundle (dist/browser/imapkit.js, npm run build) in a context that has only the globals of a
// browser: no process, Buffer, setImmediate or require

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'dist', 'browser', 'imapkit.js');

describe('Browser bundle', { skip: !fs.existsSync(bundle) && 'run npm run build first' }, () => {
    let context: any;
    let imapkit: any;

    before(() => {
        // the bundle is an ES module, vm runs scripts
        const code = transformSync(fs.readFileSync(bundle, 'utf8'), { format: 'iife', globalName: 'imapkitBundle' }).code;
        context = vm.createContext({
            console,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            queueMicrotask,
            structuredClone,
            MessageChannel,
            TextEncoder,
            TextDecoder,
            URL,
            atob,
            btoa
        });
        vm.runInContext(code, context);
        imapkit = context.imapkitBundle.default;
    });

    it('has no Node globals to lean on', () => {
        assert.equal(
            vm.runInContext('[typeof process, typeof Buffer, typeof setImmediate, typeof require].join()', context),
            'undefined,undefined,undefined,undefined'
        );
        assert.equal(typeof imapkit, 'function');
        assert.equal(typeof context.imapkitBundle.IMAPServer, 'function');
    });

    it('runs a session over server.connect()', async () => {
        const server = imapkit({
            plugins: ['IDLE', 'CONDSTORE', 'ENABLE', 'LIST-EXTENDED', 'UTF8=ACCEPT'],
            storage: { INBOX: { messages: [{ raw: 'Subject: =?UTF-8?Q?h=C3=A9llo?=\r\n\r\nWorld\r\n', flags: ['\\Seen'] }] }, '': {} }
        });
        const client = server.connect();
        const commands = [
            'A1 LOGIN testuser testpass',
            'A2 ENABLE UTF8=ACCEPT',
            'A3 SELECT INBOX (CONDSTORE)',
            'A4 FETCH 1 (ENVELOPE BODYSTRUCTURE BODY[])',
            'A5 SEARCH SUBJECT "héllo"',
            'A6 LIST "" "*" RETURN (CHILDREN)',
            'A7 LOGOUT'
        ];
        const transcript = await new Promise<string>((resolve, reject) => {
            let output = '';
            let next = 0;
            client.on('data', (chunk: Uint8Array) => {
                const text = new TextDecoder().decode(chunk);
                output += text;
                if (/^(\* OK ImapKit|A\d+ )/m.test(text) && next < commands.length) {
                    client.write(commands[next++] + '\r\n');
                }
            });
            client.on('error', reject);
            client.on('close', () => resolve(output));
        });
        assert.match(transcript, /^A3 OK \[READ-WRITE\]/m);
        assert.match(transcript, /^\* 1 FETCH \(ENVELOPE \(NIL "=\?UTF-8\?Q\?h=C3=A9llo\?=" .*BODY\[\] \{42\}\r\n/m);
        // the encoded word is decoded for SEARCH, the quoted UTF-8 string goes through isUtf8 of the node:buffer shim
        assert.match(transcript, /^\* SEARCH 1\r$/m);
        assert.match(transcript, /^A5 OK/m);
        assert.match(transcript, /^\* LIST \(\\HasNoChildren\) "\/" "INBOX"\r$/m);
        assert.match(transcript, /^A7 OK/m);
        assert.equal(server.connections.size, 0);
    });

    it('turns on the encryption of a plaintext in-memory connection with STARTTLS', async () => {
        const server = imapkit({ plugins: ['STARTTLS', 'LOGINDISABLED'] });
        const client = server.connect({ secure: false });
        const commands = ['A1 STARTTLS', 'A2 LOGIN testuser testpass', 'A3 LOGOUT'];
        const transcript = await new Promise<string>(resolve => {
            let output = '';
            let next = 0;
            client.setEncoding('binary');
            client.on('data', (text: string) => {
                output += text;
                if (/^(\* OK ImapKit|A\d+ )/m.test(text) && next < commands.length) {
                    client.write(commands[next++] + '\r\n');
                }
            });
            client.on('close', () => resolve(output));
        });
        assert.match(transcript, /^A1 OK/m);
        assert.match(transcript, /^A2 OK/m);
        assert.equal(client.encrypted, true);
    });

    it('refuses what needs Node', async () => {
        assert.throws(() => imapkit().listen(1143), /server.connect\(\)/);
        assert.throws(() => imapkit({ plugins: ['COMPRESS'] }), /COMPRESS plugin is not available in the browser/);
        await assert.rejects(imapkit().startSmtp(), /SMTP is not available in the browser/);
    });
});
