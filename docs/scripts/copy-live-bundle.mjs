// Copies the browser bundle of ImapKit (dist/browser/imapkit.js in the repository root, built by `npm run build`
// there) into static/live/, where the "Try it live" page loads it from. The page always runs the ImapKit of this
// checkout, not a published release

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(docs, '..', 'dist', 'browser');
const target = path.join(docs, 'static', 'live');

if (!fs.existsSync(path.join(source, 'imapkit.js'))) {
    console.error('The ImapKit browser bundle is missing. Run "npm install" (or "npm run build") in the repository root first.');
    process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(source, 'imapkit.js'), path.join(target, 'imapkit.js'));
