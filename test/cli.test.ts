// The imapkit command (bin/imapkit.js), which runs the built package in dist/

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(__dirname, '..', 'bin', 'imapkit.js');
const built = fs.existsSync(path.join(__dirname, '..', 'dist', 'esm', 'index.js'));

describe('imapkit command', { skip: !built && 'run npm run build first' }, () => {
    it('lists the plugins in --help', () => {
        const output = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf-8' });
        assert.match(output, /^ IDLE\s+Adds IDLE \[RFC2177\] capability$/m);
        assert.match(output, /^ X-GM-EXT-1\s+/m);
        assert.doesNotMatch(output, /__PLUGINS__|__VERSION__/);
    });

    /** a free port for the server */
    function freePort(): Promise<number> {
        return new Promise<number>(resolve => {
            const probe = net.createServer().listen(0, () => {
                const address = probe.address() as net.AddressInfo;
                probe.close(() => resolve(address.port));
            });
        });
    }

    /** resolves once the command printed a line that matches, by default once it listens */
    function listening(child: ReturnType<typeof spawn>, pattern = /listening on port/): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let output = '';
            child.stdout?.on('data', chunk => {
                output += chunk;
                if (pattern.test(output)) {
                    resolve();
                }
            });
            child.once('exit', code => reject(new Error('imapkit exited with ' + code)));
        });
    }

    /** sends A1 CAPABILITY after the greeting and resolves with everything received until the tagged response */
    function capability(port: number): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const socket = net.connect(port, 'localhost');
            let received = '';
            socket.on('data', chunk => {
                received += chunk.toString('binary');
                if (/^\* (OK|PREAUTH)/.test(received) && !received.includes('A1 ')) {
                    socket.write('A1 CAPABILITY\r\n');
                }
                if (/^A1 /m.test(received)) {
                    socket.end();
                    resolve(received);
                }
            });
            socket.on('error', reject);
        });
    }

    it('starts a server that answers IMAP', async () => {
        const port = await freePort();
        const child = spawn(process.execPath, [bin, '-p', String(port), '--plugin=IDLE,MOVE'], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
            await listening(child);
            const transcript = await capability(port);
            assert.match(transcript, /^\* CAPABILITY .*\bIDLE\b.*\bMOVE\b/m);
            assert.match(transcript, /^A1 OK/m);
        } finally {
            child.kill();
        }
    });

    it('prints the port it listens on, also for -p 0', async () => {
        const child = spawn(process.execPath, [bin, '-p', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
            const port = await new Promise<number>((resolve, reject) => {
                let output = '';
                child.stdout?.on('data', chunk => {
                    output += chunk;
                    const match = output.match(/listening on port (\d+)/);
                    if (match) {
                        resolve(Number(match[1]));
                    }
                });
                child.once('exit', code => reject(new Error('imapkit exited with ' + code)));
            });
            assert.ok(port > 0);
            assert.match(await capability(port), /^A1 OK/m);
        } finally {
            child.kill();
        }
    });

    it('loads script rules with --script', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imapkit-script-'));
        const file = path.join(dir, 'script.json');
        fs.writeFileSync(
            file,
            JSON.stringify([
                { on: 'greeting', send: '* PREAUTH scripted\r\n' },
                { on: 'response', command: 'CAPABILITY', untagged: false, send: '$TAG NO [UNAVAILABLE] scripted\r\n' }
            ])
        );
        const port = await freePort();
        const child = spawn(process.execPath, [bin, '-p', String(port), '--script=' + file], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
            await listening(child);
            const transcript = await capability(port);
            assert.match(transcript, /^\* PREAUTH scripted\r\n/);
            assert.match(transcript, /^A1 NO \[UNAVAILABLE\] scripted\r\n/m);
        } finally {
            child.kill();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('leaves plugins out with --quirk', async () => {
        const port = await freePort();
        const child = spawn(process.execPath, [bin, '-p', String(port), '--plugin=IDLE,MOVE', '--quirk=no-move'], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
            await listening(child);
            const transcript = await capability(port);
            assert.match(transcript, /^\* CAPABILITY .*\bIDLE\b/m);
            assert.doesNotMatch(transcript, /\bMOVE\b/);
        } finally {
            child.kill();
        }
    });

    it('refuses an unknown quirk', () => {
        assert.throws(
            () => execFileSync(process.execPath, [bin, '-p', '0', '--quirk=nope'], { encoding: 'utf-8', stdio: 'pipe' }),
            /Failed to start ImapKit: Unknown quirk "nope"/
        );
    });

    it('listens for implicit TLS connections with --tls-port', async () => {
        const [port, tlsPort] = [await freePort(), await freePort()];
        const child = spawn(process.execPath, [bin, '-p', String(port), '--tls-port=' + tlsPort], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
            await listening(child, new RegExp('listening for TLS connections on port ' + tlsPort));
            const greeting = await new Promise<string>((resolve, reject) => {
                const socket = tls.connect({ port: tlsPort, host: '127.0.0.1', rejectUnauthorized: false }, () => undefined);
                socket.once('data', chunk => {
                    socket.end();
                    resolve(chunk.toString());
                });
                socket.on('error', reject);
            });
            assert.match(greeting, /^\* OK ImapKit ready/);
        } finally {
            child.kill();
        }
    });

    it('starts the REST API with --rest-port', async () => {
        const [port, restPort] = [await freePort(), await freePort()];
        const child = spawn(process.execPath, [bin, '-p', String(port), '--rest-port=' + restPort, '--rest-token=sekret'], {
            stdio: ['ignore', 'pipe', 'inherit']
        });
        try {
            await listening(child, /REST API listening on 127\.0\.0\.1:\d+/);
            const res = await fetch('http://127.0.0.1:' + restPort + '/v1/users', { headers: { Authorization: 'Bearer sekret' } });
            assert.deepStrictEqual(await res.json(), [{ name: 'testuser', xoauth2: true }]);
        } finally {
            child.kill();
        }
    });
});
