import type { Callback, IMAPConnection, IMAPServer, ParsedCommand } from '../types.js';

/**
 * @help Adds AUTH=OAUTHBEARER [RFC7628] capability
 * @help Works with and without SASL-IR [RFC4959]
 * @help Valid login info, same as for XOAUTH2:
 * @help   Username (authzid, optional): testuser
 * @help   Access Token: testtoken, or a token of the OAuth provider
 */

const KVSEP = '\x01';
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A parsed OAUTHBEARER client response, see parseClientResponse() */
interface ClientResponse {
    kvsepOnly?: boolean | undefined;
    error?: string | undefined;
    channelBinding?: boolean | undefined;
    authzid?: string | false | undefined;
    pairs?: Record<string, string> | undefined;
    /** the user that the credentials log in, set by checkCredentials() */
    username?: string | undefined;
}

/**
 * Parses an OAUTHBEARER client response (RFC 7628 section 3.1)
 *
 *     client-resp = (gs2-header kvsep *kvpair kvsep) / kvsep
 *     kvpair      = key "=" value kvsep
 *     key         = 1*(ALPHA)
 *     value       = *(VCHAR / SP / HTAB / CR / LF)
 *
 * and its GS2 header (RFC 5801 section 4)
 *
 *     gs2-header = [gs2-nonstd-flag ","] gs2-cb-flag "," [gs2-authzid] ","
 *     gs2-cb-flag = ("p=" cb-name) / "n" / "y"
 *     gs2-authzid = "a=" saslname
 *
 * @param {Buffer} input Decoded client response
 * @return {Object} `{ kvsepOnly }`, `{ error }` when the response breaks the grammar, or
 *   `{ channelBinding, authzid, pairs }` where pairs maps keys to values
 */
function parseClientResponse(input: Buffer): ClientResponse {
    const str = input.toString('binary');
    if (str === KVSEP) {
        return { kvsepOnly: true };
    }

    const header = str.match(/^(?:F,)?(n|y|p=[A-Za-z0-9.-]+),(?:a=([^,]+))?,/);
    if (!header || str.charAt(header[0].length) !== KVSEP) {
        return { error: 'Invalid GS2 header' };
    }

    let authzid: string | false = false;
    if (header[2]) {
        // saslname: "," and "=" are only allowed as "=2C" and "=3D", NUL is not allowed
        if (/=(?!2C|3D)/.test(header[2]) || header[2].includes('\x00')) {
            return { error: 'Invalid authorization identity' };
        }
        try {
            authzid = utf8.decode(Buffer.from(header[2].replace(/=2C/g, ',').replace(/=3D/g, '='), 'binary'));
        } catch {
            return { error: 'Invalid UTF-8 in the authorization identity' };
        }
    }

    // *kvpair kvsep: every pair ends with a kvsep of its own, so the split ends with two empty parts
    const parts = str.substr(header[0].length + 1).split(KVSEP);
    if (parts.pop() !== '' || parts.pop() !== '') {
        return { error: 'The client response must end with %x01' };
    }

    const pairs: Record<string, string> = Object.create(null);
    for (const pair of parts) {
        const match = pair.match(/^([A-Za-z]+)=([\x20-\x7e\t\r\n]*)$/);
        if (!match) {
            return { error: 'Invalid key/value pair' };
        }
        pairs[match[1]] = match[2];
    }

    return { channelBinding: header[1].charAt(0) === 'p', authzid, pairs };
}

export default function oauthbearerPlugin(server: IMAPServer) {
    server.registerCapability('AUTH=OAUTHBEARER', (connection: IMAPConnection) => connection.state === 'Not Authenticated');

    const fail = (connection: IMAPConnection, parsed: ParsedCommand, data: string, command: string, text: string) => {
        // RFC 5530 section 3: a rejected login is AUTHENTICATIONFAILED
        connection.sendStatus(parsed, data, command, text, command === 'NO' && 'AUTHENTICATIONFAILED', 'AUTHENTICATE OAUTHBEARER FAILED');
    };

    /**
     * Checks the client response. Returns the OAuth error status (RFC 6750 section 3.1) if the
     * credentials are not accepted, or false if the user is logged in
     */
    const checkCredentials = (request: ClientResponse) => {
        if (request.channelBinding) {
            // RFC 5801 section 5: "p" asks for channel binding, which this mechanism does not support
            return 'invalid_request';
        }

        const { auth, port } = request.pairs!;
        // port: a decimal positive integer string without leading zeros (RFC 7628 section 3.1)
        if (typeof port === 'string' && !/^[1-9][0-9]*$/.test(port)) {
            return 'invalid_request';
        }

        // RFC 6750 section 2.1: "Bearer" 1*SP b64token, the scheme name is case insensitive
        const bearer = typeof auth === 'string' && auth.match(/^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i);
        if (!bearer) {
            // an empty auth value is how a client asks for the error details (RFC 7628 section 4.3)
            return auth === '' ? 'invalid_token' : 'invalid_request';
        }
        const token = bearer[1];

        // without an authzid the token tells who the user is
        const result = server.checkAccessToken(token, request.authzid === false ? undefined : request.authzid);
        if ('error' in result) {
            return result.error;
        }
        request.username = result.user;
        return false;
    };

    // RFC 7628 section 3.2.2: with the OAuth provider the error result also says where to get a token and for which scope
    const errorResult = (status: string) =>
        server.oauth && server.oauth.issuer ? { status, scope: server.oauth.mailScope, 'openid-configuration': server.oauth.discoveryUrl() } : { status };

    // Decodes a base64 client response, sends BAD and returns false if it is not valid base64
    const decode = (connection: IMAPConnection, parsed: ParsedCommand, data: string, input: string) => {
        const decoded = connection.decodeSaslResponse(input);
        if (!decoded) {
            fail(connection, parsed, data, 'BAD', 'Invalid base64 in SASL response');
        }
        return decoded;
    };

    // Waits for the next client response line. "*" cancels the exchange, which RFC 3501 section 6.2.2
    // answers with BAD
    const readResponse = (connection: IMAPConnection, parsed: ParsedCommand, data: string, onResponse: (decoded: Buffer) => void) => {
        connection.inputHandler = (line: string) => {
            connection.inputHandler = false;
            if (line === '*') {
                return fail(connection, parsed, data, 'BAD', 'Authentication cancelled');
            }
            const decoded = decode(connection, parsed, data, line);
            if (decoded) {
                onResponse(decoded);
            }
        };
    };

    // Handles the decoded client response, sent with SASL-IR or after the empty continuation request
    const authenticate = (connection: IMAPConnection, parsed: ParsedCommand, data: string, decoded: Buffer) => {
        const request = parseClientResponse(decoded);
        if (request.error) {
            return fail(connection, parsed, data, 'BAD', request.error + ' in the OAUTHBEARER client response');
        }
        if (request.kvsepOnly) {
            // RFC 7628 section 3.1: as the first message the server may fail without discovery information
            return fail(connection, parsed, data, 'NO', 'SASL authentication failed');
        }

        const status = checkCredentials(request);
        if (!status) {
            connection.state = 'Authenticated';
            connection.username = request.username;
            return connection.sendStatus(parsed, data, 'OK', 'SASL authentication succeeded', false, 'AUTHENTICATE OAUTHBEARER SUCCESS');
        }

        // RFC 7628 section 3.2.2: the error result is a JSON document in a continuation request, the
        // client MUST answer with a single %x01 or cancel, and the server then fails the exchange
        readResponse(connection, parsed, data, (response: Buffer) => {
            if (response.toString('binary') !== KVSEP) {
                return fail(connection, parsed, data, 'BAD', 'The client must answer the error result with a single %x01 (RFC 7628 section 3.2.3)');
            }
            fail(connection, parsed, data, 'NO', 'SASL authentication failed');
        });
        connection.send(
            {
                tag: '+',
                attributes: [
                    {
                        type: 'ATOM',
                        value: Buffer.from(JSON.stringify(errorResult(status))).toString('base64')
                    }
                ]
            },
            'AUTHENTICATE OAUTHBEARER CHALLENGE',
            parsed,
            data
        );
    };

    server.setCommandHandler('AUTHENTICATE OAUTHBEARER', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const args = parsed.attributes || [];

        if (!args.length) {
            // without an initial response the client sends its response after an empty challenge
            readResponse(connection, parsed, data, decoded => authenticate(connection, parsed, data, decoded));
            connection.sendContinuation('', 'AUTHENTICATE OAUTHBEARER');
            return callback();
        }

        if (args.length !== 1 || !args[0] || args[0].type !== 'ATOM') {
            fail(connection, parsed, data, 'BAD', 'Invalid arguments for AUTHENTICATE OAUTHBEARER');
            return callback();
        }

        // RFC 4959 section 3: an initial response is only allowed when SASL-IR is advertised
        if (!server.capabilities['SASL-IR'] || !server.capabilities['SASL-IR'](connection)) {
            fail(connection, parsed, data, 'BAD', 'SASL-IR must be enabled to send Initial Response with the request');
            return callback();
        }

        const decoded = decode(connection, parsed, data, args[0].value);
        if (decoded) {
            authenticate(connection, parsed, data, decoded);
        }
        return callback();
    });
}

export { parseClientResponse };
