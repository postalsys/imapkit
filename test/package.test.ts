// Loads the compiled output in dist/ (npm run build) through the package.json exports map, the way
// an installed copy of the package is loaded. Node resolves the package name to the package itself
// when the specifier is used from inside the package.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = fs.existsSync(path.join(root, 'dist', 'cjs', 'index.js'));

// a non-literal specifier keeps TypeScript from resolving the built types, dist/ may not exist yet
const packageName: string = 'imapkit';

const listen = (server: any) => new Promise<number>(resolve => server.listen(0, () => resolve(server.address().port)));
const close = (server: any) => new Promise<void>(resolve => server.close(() => resolve()));

describe('Built package', { skip: !built && 'run npm run build first' }, () => {
    it('ships both module formats with type declarations', () => {
        for (const format of ['esm', 'cjs']) {
            for (const name of ['index', 'server', 'types', 'plugins/idle', 'commands/fetch']) {
                assert.ok(fs.existsSync(path.join(root, 'dist', format, name + '.js')), format + ' ' + name);
                assert.ok(fs.existsSync(path.join(root, 'dist', format, name + '.d.ts')), format + ' ' + name + ' declarations');
            }
        }
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'cjs', 'package.json'), 'utf8')), { type: 'commonjs' });
    });

    it('keeps the CommonJS shape of require("imapkit")', async () => {
        const imapkit = require(packageName);
        assert.equal(typeof imapkit, 'function');
        assert.equal(imapkit.default, imapkit);
        assert.ok(imapkit.TAG_REGEX instanceof RegExp);
        assert.equal(typeof imapkit.IMAPServer, 'function');
        assert.equal(typeof imapkit.ImapKitError, 'function');
        // the old entry point path
        assert.equal(require(packageName + '/lib/server'), imapkit);

        const server = imapkit({ plugins: ['IDLE'] });
        assert.ok(server instanceof imapkit.IMAPServer);
        await listen(server);
        await close(server);
    });

    it('keeps the CommonJS shape of the modules under lib/', () => {
        // a module with a default export loads as that export, with its named exports as properties
        const mailboxName = require(packageName + '/lib/mailbox-name');
        assert.equal(typeof mailboxName, 'function');
        assert.equal(mailboxName.encode('Ä'), '&AMQ-');
        const idle = require(packageName + '/lib/plugins/idle');
        assert.equal(typeof idle, 'function');
        assert.deepEqual(require(packageName + '/lib/plugins/qresync').requires, ['ENABLE', 'CONDSTORE']);
        // a module with only named exports loads as the exports object
        assert.equal(typeof require(packageName + '/lib/command-states').states.AUTHENTICATED, 'object');
    });

    // smtp-server is an optional peer dependency, the package loads it only for SMTP
    it('does not load smtp-server', { skip: !!(process.versions.bun || (globalThis as any).Deno) && 'spawns Node' }, () => {
        const output = execFileSync(
            process.execPath,
            ['-e', "require('imapkit'); console.log(Object.keys(require.cache).filter(name => name.includes('smtp-server')).length)"],
            { cwd: root, encoding: 'utf8' }
        );
        assert.equal(output.trim(), '0');
    });

    it('names the package to install when smtp-server is missing', { skip: !!(process.versions.bun || (globalThis as any).Deno) && 'spawns Node' }, () => {
        // a resolve hook makes smtp-server unavailable, like an install without the optional peer dependency
        const hook =
            'export async function resolve(specifier, context, next) { if (specifier === "smtp-server") { throw Object.assign(new Error("Cannot find package smtp-server"), { code: "ERR_MODULE_NOT_FOUND" }); } return next(specifier, context); }';
        const script = [
            "import { register } from 'node:module';",
            'register(' + JSON.stringify('data:text/javascript,' + encodeURIComponent(hook)) + ');',
            "const { default: imapkit } = await import('imapkit');",
            'const server = imapkit({ smtp: { port: 0 } });',
            'await server.start().then(() => console.log("started"), err => console.log(err.message));',
            'await server.stop();'
        ].join('\n');
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
        assert.match(output, /The smtp option needs the smtp-server package, install it with: npm install smtp-server/);
    });

    it('loads as an ES module', async () => {
        const mod = await import(packageName);
        assert.equal(typeof mod.default, 'function');
        assert.equal(mod.TAG_REGEX, mod.default.TAG_REGEX);
        const server = mod.default();
        assert.ok(server instanceof mod.IMAPServer);
        await listen(server);
        await close(server);
    });

    it('exports the browser bundle as imapkit/browser', async () => {
        const mod = await import(packageName + '/browser');
        assert.equal(typeof mod.default, 'function');
        assert.equal(typeof mod.default().connect, 'function');
    });
});
