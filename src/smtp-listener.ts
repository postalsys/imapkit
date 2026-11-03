import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import type { IMAPServer } from './types.js';
import type { OAuthProvider } from './oauth/provider.js';

/**
 * Starts an SMTP server that appends every received message to the INBOX
 * of the given ImapKit IMAP server. Any sender, recipient and password are
 * accepted. With the OAuth provider, AUTH XOAUTH2 is offered too and checks
 * the access token like the IMAP login does.
 *
 * @param {Number} smtpPort - port to listen on for SMTP commands
 * @param {Object} imapServer - the ImapKit IMAP server
 * @param {Function} [callback] - function executed when SMTP server is listening, with the port
 * @param {String} [host] - address to listen on, all addresses if not set
 * @return {SMTPServer} the SMTP server instance, use `close()` to stop it
 */
export function startSMTPServer(smtpPort: number, imapServer: IMAPServer, callback?: ((port: number) => void) | null, host?: string): SMTPServer {
    const credentials = imapServer.getCredentials();

    const server = new SMTPServer({
        banner: 'ImapKit',
        key: credentials.key,
        cert: credentials.cert,
        authOptional: true,
        // with the OAuth provider, clients can also log in with its access tokens
        authMethods: imapServer.oauth ? ['PLAIN', 'LOGIN', 'XOAUTH2'] : ['PLAIN', 'LOGIN'],
        logger: false,
        onAuth(auth, session, done) {
            // XOAUTH2 is only offered with the OAuth provider
            if (auth.method !== 'XOAUTH2') {
                return done(null, { user: auth.username });
            }
            const result = imapServer.checkAccessToken(auth.accessToken || '', auth.username, 'smtp');
            if ('error' in result) {
                // the JSON error of Gmail's XOAUTH2, the client answers it and gets 535
                return done(null, { data: { status: '401', schemes: 'bearer', scope: (imapServer.oauth as OAuthProvider).mailScope } });
            }
            done(null, { user: result.user });
        },
        onData(stream, session, done) {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('error', done);
            stream.on('end', () => {
                // smtp-server has already removed the dot-stuffing (RFC 5321 section 4.5.2)
                imapServer.appendMessage('INBOX', [], false, Buffer.concat(chunks).toString('binary'));
                done();
            });
        }
    });

    server.on('error', (err: Error) => {
        if (imapServer.options.debug) {
            console.error('SMTP server error: %s', err.message);
        }
    });

    const onListening = () => callback?.((server.server.address() as AddressInfo).port);
    if (host) {
        server.listen(smtpPort, host, onListening);
    } else {
        server.listen(smtpPort, onListening);
    }

    return server;
}
