/**
 * Response grammar guardrail. Checks that everything a server sent can be parsed by a standards
 * compliant client: framing (CRLF line ends, literals), the shape of tagged, untagged and
 * continuation responses as defined by the RFC 3501 section 9 formal syntax, and that ImapFlow's
 * response parser accepts every response.
 */

import assert from 'node:assert';
import { isUtf8 } from 'node:buffer';
import { parser } from 'imapflow/lib/handler/imap-handler.js';
import * as framing from '../../src/framing.js';
import { TAG_REGEX } from '../../src/server.js';
import type { FrameLine, FramedResponse } from '../../src/framing.js';
import type { Attribute } from '../../src/types.js';

/** A response split from a transcript, see splitResponses() */
export interface CheckedResponse {
    payload: Buffer;
    literals: Buffer[];
    literal8: boolean[];
    lines: Buffer[];
    text: string;
    end: number;
}

/** The responses of a transcript, with the UTF8=ACCEPT and UIDONLY state at its end, see validateResponses() */
export interface ValidatedResponses extends Array<CheckedResponse> {
    utf8: boolean;
    uidonly: boolean;
}

/** Options of validateResponses() */
export interface ValidateOptions {
    utf8?: boolean | undefined;
    uidonly?: boolean | undefined;
}

/** A response as ImapFlow's parser returns it, the attributes are walked freely */
interface ParsedResponse {
    tag?: string | undefined;
    command?: string | undefined;
    attributes?: Attribute[] | undefined;
    numbers?: number[] | undefined;
}

const CR = 0x0d;

// Untagged response names ImapKit may send. RFC 3501 section 9 (response-data, mailbox-data,
// capability-data) plus the extensions it implements: ENABLED (RFC 5161), ID (RFC 2971),
// NAMESPACE (RFC 2342), ESEARCH (RFC 4731), VANISHED (RFC 7162 and RFC 9586), METADATA (RFC 5464), SORT and THREAD (RFC 5256), QUOTA and QUOTAROOT (RFC 9208),
// ACL, LISTRIGHTS and MYRIGHTS (RFC 4314). "X" prefixed names are
// experimental extensions (RFC 3501 section 6.5.1 allows X commands, and their responses).
const UNTAGGED = new Set([
    'OK',
    'NO',
    'BAD',
    'PREAUTH',
    'BYE',
    'CAPABILITY',
    'LIST',
    'LSUB',
    'STATUS',
    'SEARCH',
    'FLAGS',
    'ENABLED',
    'ID',
    'NAMESPACE',
    'ESEARCH',
    'VANISHED',
    'METADATA',
    'SORT',
    'THREAD',
    'QUOTA',
    'QUOTAROOT',
    'ACL',
    'LISTRIGHTS',
    'MYRIGHTS'
]);

// RFC 4314 section 7: rights = astring, only lowercase ASCII letters and digits are allowed
const RIGHTS_RE = /^[a-z0-9]*$/;

// RFC 3501 section 9: message-data uses nz-number, EXISTS and RECENT use number. RFC 9586 section 4:
// uidfetch-resp = uniqueid SP "UIDFETCH" SP msg-att, uniqueid = nz-number
const NUMERIC: Record<string, string> = {
    EXISTS: 'number',
    RECENT: 'number',
    EXPUNGE: 'nz-number',
    FETCH: 'nz-number',
    UIDFETCH: 'nz-number'
};

// RFC 3501 section 9: resp-text-code = ... / atom [SP 1*<any TEXT-CHAR except "]">]
const ATOM_RE = /^(?:(?![(){%*"\\\]])[!-~])+$/;

const NUMBER_RE = /^[0-9]+$/;
// RFC 8474 section 7: objectid = 1*255(ALPHA / DIGIT / "_" / "-")
const OBJECTID_RE = /^[A-Za-z0-9_-]{1,255}$/;
const NZ_NUMBER_RE = /^[1-9][0-9]*$/;

/**
 * Splits a transcript into responses with the shared framing code, and adds the strict checks:
 * every line ends with CRLF, no bare CR, and nothing is left over at the end.
 *
 * @param {Buffer|String} transcript Everything the server sent (a string is read as binary)
 * @param {Object} [options]
 * @param {Boolean} [options.partial] if true, an incomplete response at the end is not an error but
 *        is left out, for transcripts that are still being received
 * @return {Array} list of `{ payload, literals, text, end }`, where `payload` is the response without
 *         literal data and without the final CRLF (the shape ImapFlow's parser expects), `text`
 *         is a printable version for error messages and `end` is the offset right after the response
 */
function splitResponses(transcript: Buffer | string, options?: { partial?: boolean | undefined }): CheckedResponse[] {
    const partial = !!(options && options.partial);
    const buf = Buffer.isBuffer(transcript) ? transcript : Buffer.from(transcript, 'binary');
    const framed = framing.splitResponses(buf);

    const responses = framed.responses.map(response => {
        response.lines.forEach(line => checkLineEnd(buf, line));
        return finishResponse(buf, response);
    });

    const incomplete = framed.incomplete;
    if (incomplete) {
        // the lines of an unfinished response that did end must end correctly as well
        incomplete.lines.forEach(line => checkLineEnd(buf, line));
    }
    if (incomplete && !partial) {
        const tail = buf.subarray(framed.end);
        if (incomplete.reason === 'literal') {
            fail('Literal of ' + incomplete.size + ' octets is cut short, only ' + incomplete.available + ' octets follow', tail);
        }
        if (incomplete.reason === 'response') {
            fail('Transcript ends inside a response that has a literal', tail);
        }
        fail('Response is not terminated with CRLF', tail);
    }

    return responses;
}

// RFC 3501 section 9: every line ends with CRLF, and CR is not allowed anywhere else in a line
function checkLineEnd(buf: Buffer, line: FrameLine): void {
    if (line.end === line.lf) {
        fail('Line ends with a bare LF instead of CRLF', buf.subarray(line.start, line.lf + 1));
    }
    if (buf.subarray(line.start, line.end).indexOf(CR) >= 0) {
        fail('Line contains a bare CR', buf.subarray(line.start, line.lf + 1));
    }
}

function finishResponse(buf: Buffer, response: FramedResponse): CheckedResponse {
    const lines = response.lines.map(line => buf.subarray(line.start, line.end));
    const literals = response.literals.map(literal => buf.subarray(literal.start, literal.end));
    const parts: Buffer[] = [];
    let text = '';
    lines.forEach((line, i) => {
        parts.push(line);
        if (i < lines.length - 1) {
            parts.push(Buffer.from('\r\n'));
        }
        text += line.toString('binary');
        if (i < literals.length) {
            text += '\r\n<' + literals[i].length + ' octets>';
        }
    });
    return {
        payload: Buffer.concat(parts),
        literals,
        literal8: response.literals.map(literal => literal.literal8),
        lines,
        text,
        end: response.end
    };
}

function fail(message: string, data: Buffer | string): never {
    const text = Buffer.isBuffer(data) ? data.toString('binary') : String(data);
    throw new assert.AssertionError({ message: message + ': ' + JSON.stringify(text.length > 500 ? text.substr(0, 500) + '...' : text) });
}

/**
 * Checks `resp-text` (RFC 3501 section 9: resp-text = ["[" resp-text-code "]" SP] text) that
 * follows a status keyword. `rest` is everything after the keyword. `uidonly` is true after
 * ENABLE UIDONLY.
 */
function checkRespText(rest: string, response: CheckedResponse, uidonly: boolean): void {
    if (rest.charAt(0) !== ' ') {
        // RFC 3501 section 9: resp-cond-state = ("OK" / "NO" / "BAD") SP resp-text
        fail('Status response keyword must be followed by SP and text', response.text);
    }
    let text = rest.substr(1);
    if (/[\x80-\xff]/.test(text)) {
        // TEXT-CHAR is 7-bit, RFC 9755 only extends quoted strings
        fail('Status response text contains an 8-bit octet', response.text);
    }
    if (text.charAt(0) === '[') {
        const end = text.indexOf(']');
        if (end < 0) {
            fail('Response code is missing the closing "]"', response.text);
        }
        const code = text.substring(1, end);
        const space = code.indexOf(' ');
        const name = space >= 0 ? code.substr(0, space) : code;
        if (!ATOM_RE.test(name)) {
            fail('Response code name is not an atom', response.text);
        }
        if (space >= 0 && space === code.length - 1) {
            fail('Response code has SP without arguments', response.text);
        }
        if (name.toUpperCase() === 'METADATA' && !/^METADATA (LONGENTRIES [0-9]+|MAXSIZE [0-9]+|TOOMANY|NOPRIVATE)$/i.test(code)) {
            // RFC 5464 section 5: "METADATA" SP ("LONGENTRIES" SP number / "MAXSIZE" SP number / "TOOMANY" / "NOPRIVATE")
            fail('Invalid METADATA response code', response.text);
        }
        if (name.toUpperCase() === 'BADEVENT' && !/^BADEVENT \([A-Za-z]+( [A-Za-z]+)*\)$/i.test(code)) {
            // RFC 5465 section 8: "BADEVENT" SP "(" event-name *(SP event-name) ")"
            fail('Invalid BADEVENT response code', response.text);
        }
        if (name.toUpperCase() === 'NOTIFICATIONOVERFLOW' && space >= 0) {
            // RFC 5465 section 8: the code takes no arguments
            fail('NOTIFICATIONOVERFLOW takes no arguments', response.text);
        }
        if (name.toUpperCase() === 'UIDREQUIRED' && space >= 0) {
            // RFC 9586 section 4: resp-text-code =/ "UIDREQUIRED"
            fail('UIDREQUIRED response code takes no arguments', response.text);
        }
        if (name.toUpperCase() === 'MESSAGELIMIT' && !/^MESSAGELIMIT [1-9][0-9]*( [1-9][0-9]*)?$/i.test(code)) {
            // RFC 9738 section 5: resp-text-code =/ "MESSAGELIMIT" SP message-limit [SP uniqueid]
            fail('Invalid MESSAGELIMIT response code', response.text);
        }
        if (uidonly && name.toUpperCase() === 'UNSEEN') {
            // RFC 9586 section 3: no message sequence numbers in any response once UIDONLY is enabled
            fail('UNSEEN response code holds a message number, not allowed once UIDONLY is enabled', response.text);
        }
        text = text.substr(end + 1);
        if (text.charAt(0) !== ' ') {
            fail('Response code must be followed by SP and text', response.text);
        }
        text = text.substr(1);
    }
    if (!text.length) {
        // RFC 3501 section 9: text = 1*TEXT-CHAR (RFC 9051 made it optional, IMAP4rev1 clients may not cope)
        fail('Status response has no human readable text', response.text);
    }
}

const isString = (value: Attribute): boolean => !!value && !Array.isArray(value) && ['ATOM', 'STRING', 'LITERAL'].includes(value.type);

// RFC 3501 section 9 mbx-list-sflag, extended with \NonExistent by RFC 5258 section 6. At most one per response
const SFLAGS = ['\\NOSELECT', '\\MARKED', '\\UNMARKED', '\\NONEXISTENT'];

/**
 * Checks a LIST or LSUB response. RFC 3501 section 9 mailbox-list, as updated by RFC 5258 section 6:
 * "(" [mbx-list-flags] ")" SP (DQUOTE QUOTED-CHAR DQUOTE / nil) SP mailbox [SP mbox-list-extended]
 *
 * @param {String} name LIST or LSUB
 * @param {Array} attrs Parsed response attributes
 * @param {Object} response Response from splitResponses
 */
function checkMailboxList(name: string, attrs: Attribute[], response: CheckedResponse): void {
    if (attrs.length < 3 || attrs.length > (name === 'LIST' ? 4 : 3) || !Array.isArray(attrs[0])) {
        fail(name + ' response must be a flag list, a delimiter and a mailbox name', response.text);
    }

    const flags: string[] = attrs[0].map((flag: Attribute) => {
        // flag-extension = "\" atom
        if (!flag || flag.type !== 'ATOM' || !/^\\/.test(flag.value) || !ATOM_RE.test(flag.value.substr(1))) {
            fail(name + ' response has an invalid mailbox attribute', response.text);
        }
        return flag.value.toUpperCase();
    });
    if (flags.filter(flag => SFLAGS.includes(flag)).length > 1) {
        fail(name + ' response has more than one of ' + SFLAGS.join(', '), response.text);
    }
    // RFC 5258 section 4 and RFC 3348 section 3
    if (flags.includes('\\HASCHILDREN') && (flags.includes('\\HASNOCHILDREN') || flags.includes('\\NOINFERIORS'))) {
        fail(name + ' response has \\HasChildren together with \\HasNoChildren or \\Noinferiors', response.text);
    }

    if (attrs[1] !== null && (!attrs[1] || attrs[1].type !== 'STRING' || attrs[1].value.length !== 1)) {
        fail(name + ' response delimiter must be a quoted character or NIL', response.text);
    }

    if (!isString(attrs[2])) {
        fail(name + ' response must have a mailbox name', response.text);
    }

    // mbox-list-extended = "(" [mbox-list-extended-item *(SP mbox-list-extended-item)] ")",
    // mbox-list-extended-item = mbox-list-extended-item-tag SP tagged-ext-val
    if (attrs.length === 4 && (!Array.isArray(attrs[3]) || attrs[3].length % 2 || attrs[3].some((item: Attribute, i: number) => !(i % 2) && !isString(item)))) {
        fail('LIST response has invalid extended data', response.text);
    }
    if (attrs.length === 4) {
        for (let i = 0; i < attrs[3].length; i += 2) {
            const value = attrs[3][i + 1];
            // RFC 5465 section 8: oldname-extended-item = "OLDNAME" SP "(" mailbox ")"
            if (String(attrs[3][i].value).toUpperCase() === 'OLDNAME' && (!Array.isArray(value) || value.length !== 1 || !isString(value[0]))) {
                fail('LIST response has an invalid OLDNAME extended data item', response.text);
            }
        }
    }
}

function isNumber(attr: Attribute): boolean {
    return !!attr && attr.type === 'ATOM' && NUMBER_RE.test(attr.value);
}

/**
 * Checks a response line for NUL and 8-bit octets. RFC 3501 section 9: CHAR = %x01-7F, TEXT-CHAR and
 * QUOTED-CHAR are 7-bit, only literals carry 8-bit data. After ENABLE UTF8=ACCEPT, quoted strings
 * may hold UTF-8 as well (RFC 9755 section 3: uQUOTED-CHAR).
 *
 * @param {Buffer} line Response line without literal data
 * @param {Object} response Response for error messages
 * @param {Boolean} utf8 true if UTF8=ACCEPT is enabled
 */
function checkOctets(line: Buffer, response: CheckedResponse, utf8: boolean): void {
    let quoteStart = -1;
    for (let i = 0; i < line.length; i++) {
        const octet = line[i];
        if (octet === 0) {
            fail('Response line contains a NUL octet outside a literal', response.text);
        }
        if (quoteStart >= 0 && octet === 0x5c) {
            // quoted-specials are escaped, skip the escaped octet
            i++;
        } else if (octet === 0x22) {
            if (quoteStart < 0) {
                quoteStart = i + 1;
            } else {
                if (!isUtf8(line.subarray(quoteStart, i))) {
                    fail('Quoted string is not valid UTF-8', response.text);
                }
                quoteStart = -1;
            }
        } else if (octet >= 0x80 && (!utf8 || quoteStart < 0)) {
            fail('Response line contains an 8-bit octet outside a literal' + (utf8 ? ' or quoted string' : ''), response.text);
        }
    }
}

function checkResponse(response: CheckedResponse, parsed: ParsedResponse, utf8: boolean, uidonly: boolean): void {
    const first = response.lines[0].toString('binary');

    // Literals (CHAR8 = %x01-ff) must not contain NUL, literal8 (RFC 3516) may.
    response.lines.forEach(line => checkOctets(line, response, utf8));
    response.literals.forEach((literal, i) => {
        if (!response.literal8[i] && literal.indexOf(0) >= 0) {
            fail('Literal contains a NUL octet', response.text);
        }
        // a server sends a literal8 only as the value of BINARY[section-binary] (RFC 3516 section 7) or of a
        // METADATA entry (RFC 5464 section 5)
        if (response.literal8[i]) {
            const line = response.lines[i].toString('binary');
            const binaryItem = /^\* [0-9]+ FETCH \(/i.test(first) && /(?:^|[ (])BINARY\[[0-9.]*\](?:<[0-9]+>)? ~\{[0-9]+\}$/i.test(line);
            const metadataValue = /^\* METADATA /i.test(first) && / ~\{[0-9]+\}$/.test(line);
            if (!binaryItem && !metadataValue) {
                fail('Literal8 outside of a BINARY[] FETCH item or a METADATA value', response.text);
            }
        }
    });

    if (parsed.tag === '+') {
        // RFC 3501 section 9 and RFC 9051 section 9: continue-req = "+" SP (resp-text / base64) CRLF.
        // base64 may be empty, so "+ " is valid but a bare "+" is not.
        if (!/^\+ /.test(first)) {
            fail('Continuation response must start with "+ "', response.text);
        }
        return;
    }

    if (parsed.tag !== '*') {
        // RFC 3501 section 9: response-tagged = tag SP resp-cond-state CRLF
        const match = first.match(/^([^ ]+) (OK|NO|BAD)(?![^ ])(.*)$/i);
        if (!match || !TAG_REGEX.test(match[1])) {
            fail('Tagged response must be "tag OK|NO|BAD text"', response.text);
        }
        checkRespText(match[3], response, uidonly);
        return;
    }

    const numeric = first.match(/^\* ([^ ]+) ([^ ]+)/);
    if (numeric && /^[0-9]/.test(numeric[1])) {
        const name = numeric[2].toUpperCase();
        if (!NUMERIC[name]) {
            fail('Unknown numeric untagged response', response.text);
        }
        const re = NUMERIC[name] === 'number' ? NUMBER_RE : NZ_NUMBER_RE;
        if (!re.test(numeric[1])) {
            fail(name + ' requires a ' + NUMERIC[name], response.text);
        }
        // RFC 9586 sections 3.3 and 3.4: once UIDONLY is enabled, UIDFETCH and VANISHED replace FETCH and EXPUNGE,
        // and UIDFETCH is not sent before
        if (uidonly && (name === 'FETCH' || name === 'EXPUNGE')) {
            fail(name + ' response holds a message number, not allowed once UIDONLY is enabled', response.text);
        }
        if (!uidonly && name === 'UIDFETCH') {
            fail('UIDFETCH response before ENABLE UIDONLY', response.text);
        }
        if (name === 'FETCH' || name === 'UIDFETCH') {
            // RFC 3501 section 9: "FETCH" SP msg-att, msg-att = "(" att SP value *(SP att SP value) ")"
            const attrs = parsed.attributes || [];
            if (attrs.length !== 2 || !Array.isArray(attrs[1]) || !new RegExp('^\\* [0-9]+ ' + name + ' \\(', 'i').test(first)) {
                fail(name + ' response must have exactly one parenthesized list', response.text);
            }
            if (!attrs[1].length || attrs[1].length % 2) {
                fail(name + ' response list must hold attribute and value pairs', response.text);
            }
        } else if ((parsed.attributes || []).length !== 1) {
            fail(name + ' response takes no arguments', response.text);
        }
        return;
    }

    const name = String(parsed.command || '').toUpperCase();
    if (!UNTAGGED.has(name) && !/^X/.test(name)) {
        fail('Unknown untagged response "' + parsed.command + '"', response.text);
    }

    if (['OK', 'NO', 'BAD', 'PREAUTH', 'BYE'].includes(name)) {
        // RFC 3501 section 9: resp-cond-state, resp-cond-auth, resp-cond-bye are all keyword SP resp-text
        checkRespText(first.substr(2 + name.length), response, uidonly);
        return;
    }

    if (name === 'LIST' || name === 'LSUB') {
        checkMailboxList(name, parsed.attributes || [], response);
    }

    if (name === 'STATUS') {
        // RFC 3501 section 9: "STATUS" SP mailbox SP "(" [status-att-list] ")", every status-att-val is
        // an item name and a number (RFC 8438 section 4: SIZE is a number64), except
        // RFC 8474 section 7: status-att-val =/ "MAILBOXID" SP "(" objectid ")", and
        // RFC 7889 section 5: status-att-val =/ "APPENDLIMIT" SP (number / nil)
        const attrs = parsed.attributes || [];
        if (attrs.length !== 2 || !isString(attrs[0]) || !Array.isArray(attrs[1]) || attrs[1].length % 2) {
            fail('STATUS response must be a mailbox and a list of item and value pairs', response.text);
        }
        for (let i = 0; i < attrs[1].length; i += 2) {
            const item = attrs[1][i];
            const value = attrs[1][i + 1];
            if (item && String(item.value).toUpperCase() === 'MAILBOXID') {
                if (!Array.isArray(value) || value.length !== 1 || !value[0] || value[0].type !== 'ATOM' || !OBJECTID_RE.test(value[0].value)) {
                    fail('STATUS MAILBOXID must be a parenthesized object identifier', response.text);
                }
                continue;
            }
            const isNil = value === null && item && item.type === 'ATOM' && String(item.value).toUpperCase() === 'APPENDLIMIT';
            if (!item || item.type !== 'ATOM' || !ATOM_RE.test(item.value) || (!isNil && (!value || value.type !== 'ATOM' || !NUMBER_RE.test(value.value)))) {
                fail('STATUS response items must be atoms with numeric values', response.text);
            }
        }
    }

    if (name === 'METADATA') {
        checkMetadata(parsed.attributes || [], response);
    }

    if (name === 'SORT' && !/^\* SORT(?:(?: [1-9][0-9]*)+(?: \(MODSEQ [1-9][0-9]*\))?)?$/i.test(first)) {
        // RFC 5256 section 5: sort-data = "SORT" *(SP nz-number), RFC 7162 section 7 appends SP search-sort-mod-seq
        fail('SORT response must only list nz-numbers', response.text);
    }

    if (name === 'THREAD' && (response.lines.length > 1 || !isThreadData(first.replace(/^\* THREAD/i, '')))) {
        fail('THREAD response does not match the thread-data grammar', response.text);
    }

    if (name === 'QUOTA') {
        // RFC 9208 section 7: "QUOTA" SP quota-root-name SP quota-list, quota-resource = resource-name SP resource-usage SP resource-limit
        const attrs = parsed.attributes || [];
        const list = attrs[1];
        if (attrs.length !== 2 || !isString(attrs[0]) || !Array.isArray(list) || list.length % 3) {
            fail('QUOTA response must have a quota root name and a list of resource triplets', response.text);
        }
        for (let i = 0; i < list.length; i += 3) {
            if (!list[i] || list[i].type !== 'ATOM' || !ATOM_RE.test(list[i].value) || !isNumber(list[i + 1]) || !isNumber(list[i + 2])) {
                fail('QUOTA resource must be an atom and two numbers', response.text);
            }
        }
    }

    if (name === 'QUOTAROOT') {
        // RFC 9208 section 7: "QUOTAROOT" SP mailbox *(SP quota-root-name)
        const attrs = parsed.attributes || [];
        if (!attrs.length || !attrs.every(isString)) {
            fail('QUOTAROOT response must have a mailbox name and quota root names', response.text);
        }
    }

    if (name === 'ACL' || name === 'LISTRIGHTS' || name === 'MYRIGHTS') {
        // RFC 4314 section 7: acl-data = "ACL" SP mailbox *(SP identifier SP rights),
        // listrights-data = "LISTRIGHTS" SP mailbox SP identifier SP rights *(SP rights),
        // myrights-data = "MYRIGHTS" SP mailbox SP rights. All of them are astrings
        const attrs = parsed.attributes || [];
        if (attrs.some((attr: Attribute) => !attr || Array.isArray(attr) || ['ATOM', 'STRING', 'LITERAL'].indexOf(attr.type) < 0)) {
            fail(name + ' response arguments must be strings', response.text);
        }
        const valid = (
            {
                ACL: attrs.length % 2 === 1,
                LISTRIGHTS: attrs.length >= 3,
                MYRIGHTS: attrs.length === 2
            } as Record<string, boolean>
        )[name];
        if (!valid) {
            fail(name + ' response has the wrong number of arguments', response.text);
        }
        const rights = name === 'ACL' ? attrs.filter((attr: Attribute, i: number) => i && i % 2 === 0) : attrs.slice(name === 'MYRIGHTS' ? 1 : 2);
        if (rights.some((attr: Attribute) => !RIGHTS_RE.test(String(attr.value)))) {
            fail(name + ' response rights may only hold lowercase letters and digits', response.text);
        }
        return;
    }

    if (name === 'SEARCH') {
        // RFC 3501 section 9: "SEARCH" *(SP nz-number), RFC 7162 section 7 appends SP "(" "MODSEQ" SP mod-sequence-value ")"
        const attrs = parsed.attributes || [];
        attrs.forEach((attr: Attribute, i: number) => {
            if (Array.isArray(attr)) {
                const ok =
                    i === attrs.length - 1 &&
                    attr.length === 2 &&
                    String(attr[0].value).toUpperCase() === 'MODSEQ' &&
                    attr[1] &&
                    NZ_NUMBER_RE.test(attr[1].value);
                if (!ok) {
                    fail('SEARCH response has an invalid list', response.text);
                }
                return;
            }
            if (!attr || attr.type !== 'ATOM' || !NZ_NUMBER_RE.test(attr.value)) {
                fail('SEARCH response must only list nz-numbers', response.text);
            }
        });
    }

    if (name === 'ESEARCH') {
        checkEsearch(parsed, response, uidonly);
    }

    // RFC 7162 section 7: expunged-resp = "VANISHED" [SP "(EARLIER)"] SP known-uids, known-uids is a sequence-set without "*"
    if (name === 'VANISHED' && !/^\* VANISHED (\(EARLIER\) )?[1-9][0-9]*(:[1-9][0-9]*)?(,[1-9][0-9]*(:[1-9][0-9]*)?)*$/i.test(first)) {
        fail('VANISHED response must be "VANISHED [(EARLIER)] uid-set"', response.text);
    }
}

/**
 * RFC 4466 section 2.6.2: esearch-response = "ESEARCH" [search-correlator] [SP "UID"] *(SP search-return-data),
 * search-correlator = SP "(" "TAG" SP tag-string ")", search-return-data = search-modifier-name SP search-return-value.
 * RFC 7377 section 4 extends the correlator: one-correlator = ("TAG" SP tag-string) / ("MAILBOX" SP astring) /
 * ("UIDVALIDITY" SP nz-number), each one at most once. The return data of RFC 4731 section 4 (MIN, MAX, ALL, COUNT,
 * MODSEQ), RFC 5267 section 5 (ADDTO, REMOVEFROM, PARTIAL) and RFC 9394 section 4 (PARTIAL) is checked by its own grammar
 */
function checkEsearch(parsed: ParsedResponse, response: CheckedResponse, uidonly: boolean): void {
    const attrs = (parsed.attributes || []).slice();
    if (Array.isArray(attrs[0])) {
        const correlator = attrs.shift();
        const seenCorrelators = new Set<string>();
        let ok = correlator.length >= 2 && correlator.length % 2 === 0;
        for (let i = 0; ok && i < correlator.length; i += 2) {
            const name = correlator[i] && correlator[i].type === 'ATOM' ? String(correlator[i].value).toUpperCase() : '';
            const value = correlator[i + 1];
            if (seenCorrelators.has(name)) {
                ok = false;
            }
            seenCorrelators.add(name);
            if (name === 'TAG' || name === 'MAILBOX') {
                ok = ok && !!value && ['STRING', 'LITERAL'].concat(name === 'MAILBOX' ? 'ATOM' : []).includes(value.type);
            } else if (name === 'UIDVALIDITY') {
                ok = ok && !!value && value.type === 'ATOM' && NZ_NUMBER_RE.test(value.value);
            } else {
                ok = false;
            }
        }
        if (!ok || !seenCorrelators.has('TAG')) {
            fail('ESEARCH search correlator must be (TAG string [MAILBOX astring] [UIDVALIDITY nz-number])', response.text);
        }
    }
    if (attrs[0] && attrs[0].type === 'ATOM' && String(attrs[0].value).toUpperCase() === 'UID') {
        attrs.shift();
    } else if (uidonly) {
        // RFC 9586 section 3: results of SEARCH (without UID) are message numbers
        fail('ESEARCH response without UID, not allowed once UIDONLY is enabled', response.text);
    }
    if (attrs.length % 2) {
        fail('ESEARCH return data must be name and value pairs', response.text);
    }

    const SEQUENCE_SET_RE = /^[1-9][0-9]*(:[1-9][0-9]*)?(,[1-9][0-9]*(:[1-9][0-9]*)?)*$/;
    const isSequenceSet = (value: Attribute): boolean => !!value && !Array.isArray(value) && SEQUENCE_SET_RE.test(value.value);
    // RFC 5267 section 5: "(" context-position SP sequence-set *(SP context-position SP sequence-set) ")"
    const isUpdateList = (value: Attribute): boolean =>
        Array.isArray(value) &&
        value.length >= 2 &&
        value.length % 2 === 0 &&
        value.every((item: Attribute, i: number) => (i % 2 ? isSequenceSet(item) : !!item && !Array.isArray(item) && NUMBER_RE.test(item.value)));
    // RFC 9394 section 4: "(" partial-range SP partial-results ")", partial-results = sequence-set / "NIL"
    const isPartial = (value: Attribute): boolean =>
        Array.isArray(value) &&
        value.length === 2 &&
        !!value[0] &&
        /^(?:[1-9][0-9]*:[1-9][0-9]*|-[1-9][0-9]*:-[1-9][0-9]*)$/.test(value[0].value) &&
        (value[1] === null || isSequenceSet(value[1]));
    const VALUES: Record<string, RegExp> = {
        MIN: NZ_NUMBER_RE,
        MAX: NZ_NUMBER_RE,
        COUNT: NUMBER_RE,
        ALL: SEQUENCE_SET_RE,
        MODSEQ: NZ_NUMBER_RE
    };
    const LISTS: Record<string, (value: Attribute) => boolean> = { ADDTO: isUpdateList, REMOVEFROM: isUpdateList, PARTIAL: isPartial };
    const seen = new Set<string>();
    for (let i = 0; i < attrs.length; i += 2) {
        const label = attrs[i];
        // tagged-ext-label = tagged-label-fchar *tagged-label-char, tagged-label-fchar = ALPHA / "-" / "_" / "."
        if (!label || label.type !== 'ATOM' || !/^[A-Za-z\-_.][A-Za-z0-9\-_.:]*$/.test(label.value)) {
            fail('ESEARCH return data name must be a tagged-ext-label', response.text);
        }
        const key = label.value.toUpperCase();
        // RFC 4466 section 2.6.2: any return item name SHOULD appear only once. RFC 5267 section 4.3.3 shows
        // ADDTO more than once in a response, and the updates are processed in order
        if (seen.has(key) && key !== 'ADDTO' && key !== 'REMOVEFROM') {
            fail('ESEARCH return data ' + key + ' appears more than once', response.text);
        }
        seen.add(key);
        const value = attrs[i + 1];
        const valueRe = VALUES[key];
        if (valueRe && (!value || Array.isArray(value) || !valueRe.test(value.value))) {
            fail('ESEARCH ' + key + ' has an invalid value', response.text);
        }
        const isList = LISTS[key];
        if (isList && !isList(value)) {
            fail('ESEARCH ' + key + ' has an invalid value', response.text);
        }
    }
}

const isAstring = (attr: Attribute): boolean => !!attr && !Array.isArray(attr) && ['ATOM', 'STRING', 'LITERAL'].includes(attr.type);

/**
 * Checks a METADATA response, RFC 5464 section 5:
 * metadata-resp = "METADATA" SP mailbox SP (entry-values / entry-list),
 * entry-values = "(" entry-value *(SP entry-value) ")", entry-value = entry SP value,
 * entry-list = entry *(SP entry), entry = astring, value = nstring / literal8
 */
function checkMetadata(attrs: Attribute[], response: CheckedResponse): void {
    if (attrs.length < 2 || !isAstring(attrs[0])) {
        fail('METADATA response needs a mailbox name and entries', response.text);
    }
    const isEntry = (attr: Attribute): boolean => isAstring(attr) && attr.value.charAt(0) === '/';
    if (Array.isArray(attrs[1])) {
        const list = attrs[1];
        if (attrs.length !== 2 || !list.length || list.length % 2) {
            fail('METADATA response list must hold entry and value pairs', response.text);
        }
        for (let i = 0; i < list.length; i += 2) {
            const value = list[i + 1];
            if (!isEntry(list[i]) || (value !== null && (!value || !['STRING', 'LITERAL'].includes(value.type)))) {
                fail('METADATA response has an invalid entry or value', response.text);
            }
        }
        return;
    }
    // an unsolicited response lists only entry names (RFC 5464 section 4.4)
    if (!attrs.slice(1).every(isEntry)) {
        fail('METADATA response has an invalid entry list', response.text);
    }
}

/**
 * Checks thread-data after the "THREAD" keyword (RFC 5256 section 5):
 * thread-data = "THREAD" [SP 1*thread-list], thread-list = "(" (thread-members / thread-nested) ")",
 * thread-members = nz-number *(SP nz-number) [SP thread-nested], thread-nested = 2*thread-list
 *
 * @param {String} rest Everything after "* THREAD"
 * @return {Boolean} true if valid
 */
function isThreadData(rest: string): boolean {
    if (!rest) {
        return true;
    }
    let pos = 1;
    const peek = () => rest.charAt(pos);
    const number = () => {
        const match = rest.substr(pos).match(/^[1-9][0-9]*/);
        if (!match) {
            return false;
        }
        pos += match[0].length;
        return true;
    };
    // thread-nested: at least two adjacent thread-lists
    const nested = () => {
        let count = 0;
        while (peek() === '(') {
            if (!list()) {
                return false;
            }
            count++;
        }
        return count >= 2;
    };
    const list = (): boolean => {
        pos++;
        if (peek() === '(') {
            if (!nested()) {
                return false;
            }
        } else {
            if (!number()) {
                return false;
            }
            while (peek() === ' ') {
                pos++;
                if (peek() === '(') {
                    if (!nested()) {
                        return false;
                    }
                    break;
                }
                if (!number()) {
                    return false;
                }
            }
        }
        if (peek() !== ')') {
            return false;
        }
        pos++;
        return true;
    };
    if (rest.charAt(0) !== ' ' || peek() !== '(') {
        return false;
    }
    while (pos < rest.length) {
        if (peek() !== '(' || !list()) {
            return false;
        }
    }
    return true;
}

/**
 * Checks if a response is "* ENABLED" with an extension, e.g. UTF8=ACCEPT (RFC 9755 section 3)
 */
function enables(parsed: ParsedResponse, name: string): boolean {
    return (
        parsed.tag === '*' &&
        String(parsed.command || '').toUpperCase() === 'ENABLED' &&
        (parsed.attributes || []).some((attr: Attribute) => attr && String(attr.value).toUpperCase() === name)
    );
}

/**
 * Validates a full server transcript. Rejects with an AssertionError naming the offending response.
 * UTF-8 in quoted strings is accepted after a "* ENABLED UTF8=ACCEPT" or "* ENABLED IMAP4rev2" response (RFC 9051
 * Appendix A: no UTF-8 quoted strings before ENABLE IMAP4rev2). After "* ENABLED UIDONLY"
 * responses with message numbers are refused (RFC 9586 section 3).
 *
 * @param {Buffer|String} transcript Everything the server sent (a string is read as binary)
 * @param {Object} [options]
 * @param {Boolean} [options.utf8] if true, UTF8=ACCEPT was enabled before this transcript
 * @param {Boolean} [options.uidonly] if true, UIDONLY was enabled before this transcript
 * @return {Promise} resolves with the responses once every response has been checked, `utf8` and `uidonly`
 *         tell if UTF8=ACCEPT and UIDONLY are enabled at the end
 */
async function validateResponses(transcript: Buffer | string, options?: ValidateOptions): Promise<ValidatedResponses> {
    let utf8 = !!(options && options.utf8);
    let uidonly = !!(options && options.uidonly);
    const responses = splitResponses(transcript) as ValidatedResponses;
    for (const response of responses) {
        let parsed: ParsedResponse;
        try {
            parsed = await parser(response.payload, { literals: response.literals.slice() });
        } catch (err) {
            fail('ImapFlow can not parse the response (' + (err as Error).message + ')', response.text);
        }
        if (parsed.numbers) {
            // ImapFlow reads a plain SEARCH response into numbers and loses how each one was written ("01" becomes 1),
            // the checks need the atoms as the server sent them. It does this only for single spaces and digits
            parsed.attributes = response.payload
                .toString('binary')
                .split(' ')
                .slice(2)
                .map(value => ({ type: 'ATOM', value }));
            delete parsed.numbers;
        }
        checkResponse(response, parsed, utf8, uidonly);
        utf8 = utf8 || enables(parsed, 'UTF8=ACCEPT') || enables(parsed, 'IMAP4REV2');
        uidonly = uidonly || enables(parsed, 'UIDONLY');
    }
    // lets a caller that validates a session in chunks carry the UTF8=ACCEPT and UIDONLY state forward
    responses.utf8 = utf8;
    responses.uidonly = uidonly;
    return responses;
}

/**
 * Validates a transcript and then calls `callback` outside of the promise chain, so that assertion
 * errors from either the validator or the callback surface as uncaught exceptions that node:test
 * attributes to the running test.
 *
 * @param {Buffer|String} transcript Everything the server sent
 * @param {Function} callback Called with the validated responses once the transcript is valid
 * @param {Object} [options] see validateResponses
 */
function validateThen(transcript: Buffer | string, callback: (responses: ValidatedResponses) => void, options?: ValidateOptions): void {
    validateResponses(transcript, options).then(
        responses => setImmediate(() => callback(responses)),
        err =>
            setImmediate(() => {
                throw err;
            })
    );
}

export { validateResponses, validateThen, splitResponses };
