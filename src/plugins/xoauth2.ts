import type { Callback, IMAPConnection, IMAPServer, ParsedCommand } from '../types.js';

// https://developers.google.com/gmail/xoauth2_protocol

/**
 * @help Enables XOAUTH2 capability
 * @help Implementation difference - ImapKit requires
 * @help SASL-IR enabled and used while Gmail does not
 * @help Valid login info:
 * @help   Username: testuser
 * @help   Access Token: testtoken, or a token of the OAuth provider
 */

const utf8 = new TextDecoder('utf-8', { fatal: true });

export default function xoauth2Plugin(server: IMAPServer) {
    // Register capability, usable for non authenticated users
    server.registerCapability('AUTH=XOAUTH2', (connection: IMAPConnection) => {
        return connection.state === 'Not Authenticated';
    });

    server.setCommandHandler('AUTHENTICATE XOAUTH2', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        if (!server.capabilities['SASL-IR'] || !server.capabilities['SASL-IR'](connection)) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'SASL-IR must be enabled to support XOAUTH2'
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );
            return callback();
        }

        if (!parsed.attributes || parsed.attributes.length !== 1 || !parsed.attributes[0] || ['STRING', 'ATOM'].indexOf(parsed.attributes[0].type) < 0) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Invalid SASL argument'
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );
            return callback();
        }

        const decoded = connection.decodeSaslResponse(parsed.attributes[0].value);
        if (!decoded) {
            connection.sendStatus(parsed, data, 'BAD', 'Invalid base64 in SASL response', false, 'AUTHENTICATE XOAUTH2 FAILED');
            return callback();
        }
        let parts: string[] = [];
        try {
            // user names are unicode strings, like the keys of `users`
            parts = utf8.decode(decoded).split('\x01');
        } catch {
            // invalid UTF-8 is a malformed payload like any other
        }
        const user = (parts[0] || '').substr(5);
        const accessToken = (parts[1] || '').substr(12);

        if (
            parts.length !== 4 ||
            !parts[0].match(/^user=/) ||
            !parts[1].match(/^auth=Bearer /) ||
            !user || // Must be present
            !accessToken || // Must be present
            parts[2] || // Must be empty
            parts[3] // Must be empty
        ) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Invalid SASL argument.'
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );
            return callback();
        }

        const userData = connection.server.getUser(user);
        if (!userData) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [
                        // RFC 5530 section 3: unknown user or bad token
                        { type: 'SECTION', section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }] },
                        {
                            type: 'TEXT',
                            value: 'Invalid credentials'
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );
            return callback();
        }

        if ('error' in server.checkAccessToken(accessToken, user)) {
            connection.send(
                {
                    tag: '+',
                    attributes: [
                        {
                            type: 'ATOM',
                            value: Buffer.from(
                                JSON.stringify({
                                    status: '400',
                                    schemes: 'Bearer',
                                    // the scope the OAuth provider of this server asks for, Gmail's without one
                                    scope: server.oauth ? server.oauth.mailScope : 'https://mail.google.com/'
                                })
                            ).toString('base64')
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );

            // wait for response
            connection.inputHandler = function () {
                connection.inputHandler = false;
                connection.send(
                    {
                        tag: parsed.tag,
                        command: 'NO',
                        attributes: [
                            { type: 'SECTION', section: [{ type: 'ATOM', value: 'AUTHENTICATIONFAILED' }] },
                            {
                                type: 'TEXT',
                                value: 'SASL authentication failed'
                            }
                        ]
                    },
                    'AUTHENTICATE XOAUTH2 FAILED',
                    parsed,
                    data
                );
            };
        } else {
            connection.state = 'Authenticated';
            connection.username = user;
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'OK',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'User logged in'
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 SUCCESS',
                parsed,
                data
            );
        }
        return callback();
    });
}
