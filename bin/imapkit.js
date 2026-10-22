#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import imapkit from '../dist/esm/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

// Non-strict so that boolean flags also accept an explicit value (`--secure=true`)
const { values: argv } = parseArgs({
    strict: false,
    options: {
        port: { type: 'string', short: 'p' },
        secure: { type: 'boolean', short: 's' },
        debug: { type: 'boolean', short: 'd' },
        help: { type: 'boolean', short: 'h' },
        config: { type: 'string' },
        storage: { type: 'string' },
        script: { type: 'string' },
        plugin: { type: 'string', multiple: true },
        smtpPort: { type: 'string' },
        'smtp-port': { type: 'string' },
        'tls-port': { type: 'string' },
        'rest-port': { type: 'string' },
        'rest-host': { type: 'string' },
        'rest-token': { type: 'string' },
        quirk: { type: 'string', multiple: true },
        'script-seed': { type: 'string' }
    }
});

const isTrue = value => (value || '').toString().trim().toLowerCase() === 'true';

// a repeated option or a comma separated list, e.g. --plugin=IDLE,MOVE --plugin=ID
const listOption = value =>
    []
        .concat(value || [])
        .flatMap(item =>
            String(item)
                .trim()
                .split(/\s*,\s*/)
        )
        .filter(Boolean);

const configLocation = argv.config || process.env.IMAPKIT_CONFIG;
const storageLocation = argv.storage || process.env.IMAPKIT_STORAGE;
const scriptLocation = argv.script || process.env.IMAPKIT_SCRIPT;
const smtpPort = argv.smtpPort || argv['smtp-port'] || process.env.IMAPKIT_SMTPPORT;
const tlsPort = argv['tls-port'] || process.env.IMAPKIT_TLS_PORT;
const restPort = argv['rest-port'] || process.env.IMAPKIT_REST_PORT;
const restHost = argv['rest-host'] || process.env.IMAPKIT_REST_HOST;
const restToken = argv['rest-token'] || process.env.IMAPKIT_REST_TOKEN;
const quirksList = listOption(argv.quirk || process.env.IMAPKIT_QUIRKS);
const scriptSeed = argv['script-seed'] || process.env.IMAPKIT_SCRIPT_SEED;
const pluginsList = listOption(argv.plugin || process.env.IMAPKIT_PLUGINS).map(plugin => plugin.toUpperCase());
const secure = isTrue(argv.secure || process.env.IMAPKIT_SECURE);
const debug = isTrue(argv.debug || process.env.IMAPKIT_DEBUG);

let config = {};

if (configLocation) {
    config = JSON.parse(fs.readFileSync(configLocation, 'utf-8'));
}

if (storageLocation) {
    config.storage = JSON.parse(fs.readFileSync(storageLocation, 'utf-8'));
}

if (scriptLocation) {
    config.script = JSON.parse(fs.readFileSync(scriptLocation, 'utf-8'));
}

if (pluginsList.length) {
    config.plugins = pluginsList;
}

if (secure) {
    config.secureConnection = true;
}

if (debug) {
    config.debug = true;
}

// secureConnection can also come from the --config file
const isSecure = secure || config.secureConnection === true;
const port = argv.port || process.env.IMAPKIT_PORT || config.port || (isSecure ? 993 : 143);

if (argv.help) {
    const help = fs.readFileSync(path.join(__dirname, 'help.txt'), 'utf-8');
    // the @help lines of every plugin, collected by the build (scripts/build.js)
    const pluginHelp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'plugin-help.json'), 'utf-8'));
    const plugins = Object.keys(pluginHelp).map(key => ({ key, value: pluginHelp[key] }));

    const indent = Math.max(0, ...plugins.map(plugin => plugin.key.length)) + 2;
    const pluginText = plugins.flatMap(plugin => [
        ' ' + plugin.key.padEnd(indent - 1) + (plugin.value[0] || ''),
        ...plugin.value.slice(1).map(line => ' '.repeat(indent) + line)
    ]);

    console.log(
        help
            .replace(/__PLUGINS__/g, pluginText.join('\n'))
            .replace(/__VERSION__/g, packageData.version)
            .replace(/__VBAR__/g, '='.repeat(packageData.version.length))
            .replace(/__HOMEPAGE__/g, packageData.homepage)
            .replace(/__BUGS__/g, packageData.bugs.url)
            .trim()
    );
} else {
    if (quirksList.length) {
        config.quirks = quirksList;
    }
    if (scriptSeed !== undefined) {
        config.scriptSeed = Number(scriptSeed);
    }
    if (tlsPort) {
        config.tls = { port: Number(tlsPort) };
    }
    if (restPort) {
        config.rest = { port: Number(restPort), host: restHost, token: restToken };
    }
    if (smtpPort) {
        // smtp-server is an optional dependency, start() loads it only when SMTP is enabled
        config.smtp = { port: Number(smtpPort) };
    }
    let server;
    try {
        server = imapkit(config);
    } catch (err) {
        // an unknown plugin or quirk name, invalid storage ...
        console.error('Failed to start ImapKit: %s', err.message);
        process.exit(1);
    }
    console.log('Starting ImapKit ...');
    server.start(Number(port)).then(
        listening => {
            // the actual port, also for -p 0
            console.log('ImapKit successfully%s listening on port %s', isSecure ? ' and securely' : '', listening);
            if (server.tlsServer) {
                console.log('ImapKit listening for TLS connections on port %s', server.tlsServer.address().port);
            }
            if (server.restServer) {
                console.log('REST API listening on %s:%s', (config.rest && config.rest.host) || '127.0.0.1', server.restServer.address().port);
            }
            if (server.smtpServer) {
                console.log('Incoming SMTP server up and running on port %s', server.smtpServer.server.address().port);
            }
        },
        err => {
            console.error('Failed to start ImapKit: %s', err.message);
            process.exit(1);
        }
    );
}
