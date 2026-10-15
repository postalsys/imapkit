// Helpers of the storage manager: mailbox names (modified UTF-7, RFC 3501 section 5.1.3) and a summary of a
// message source for the message list

const decoder = new TextDecoder();

/** Turns a storage name (modified UTF-7) into the name to show */
export function decodeMailboxName(name: string): string {
    return name.replace(/&([^-]*)-/g, (match, encoded: string) => {
        if (!encoded) {
            return '&';
        }
        const binary = atob(encoded.replace(/,/g, '/'));
        let text = '';
        for (let i = 0; i + 1 < binary.length; i += 2) {
            text += String.fromCharCode((binary.charCodeAt(i) << 8) | binary.charCodeAt(i + 1));
        }
        return text;
    });
}

/** Turns a name typed by the user into a storage name (modified UTF-7) */
export function encodeMailboxName(name: string): string {
    return name.replace(/&|[^\x20-\x7e]+/g, run => {
        if (run === '&') {
            return '&-';
        }
        let binary = '';
        for (let i = 0; i < run.length; i++) {
            const code = run.charCodeAt(i);
            binary += String.fromCharCode(code >> 8, code & 0xff);
        }
        return '&' + btoa(binary).replace(/=+$/, '').replace(/\//g, ',') + '-';
    });
}

export interface MessageSummary {
    from: string;
    to: string;
    subject: string;
    /** the Date header, or null when it is missing or invalid */
    date: Date | null;
}

/** The header block of a message source, unfolded */
function headerBlock(source: string): string {
    const end = source.search(/\r?\n\r?\n/);
    return (end < 0 ? source : source.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
}

function headerValue(header: string, name: string): string {
    const match = new RegExp('^' + name + '[ \\t]*:[ \\t]*(.*)$', 'im').exec(header);
    return match ? decodeWords(match[1].trim()) : '';
}

/** Decodes RFC 2047 encoded words, the white space between two of them goes away */
function decodeWords(value: string): string {
    return value
        .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?[^?]+\?[bq]\?[^?]*\?=)/gi, '$1')
        .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bq])\?([^?]*)\?=/gi, (match, charset: string, encoding: string, text: string) => {
            let bytes: Uint8Array;
            try {
                if (encoding.toUpperCase() === 'B') {
                    bytes = Uint8Array.from(atob(text), char => char.charCodeAt(0));
                } else {
                    const binary = text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (hex, code: string) => String.fromCharCode(parseInt(code, 16)));
                    bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
                }
                return new TextDecoder(charset).decode(bytes);
            } catch {
                return match;
            }
        });
}

/** The display name of the first address, or the address */
function displayAddress(value: string): string {
    const match = /^\s*"?([^"<]*?)"?\s*<([^>]*)>/.exec(value);
    if (match) {
        return match[1].trim() || match[2].trim();
    }
    return value.split(',')[0].trim();
}

export function summarize(raw: Uint8Array): MessageSummary {
    // header fields are ASCII or, with UTF8=ACCEPT, UTF-8
    const header = headerBlock(decoder.decode(raw.subarray(0, 64 * 1024)));
    const date = new Date(headerValue(header, 'Date'));
    return {
        from: displayAddress(headerValue(header, 'From')),
        to: displayAddress(headerValue(header, 'To')),
        subject: headerValue(header, 'Subject'),
        date: isNaN(date.getTime()) ? null : date
    };
}

/** True if the start of a file looks like a message header: a header field before the first empty line */
export function looksLikeMessage(raw: Uint8Array): boolean {
    const start = decoder.decode(raw.subarray(0, 2048));
    return /^(From [^\r\n]*\r?\n)?[\x21-\x39\x3b-\x7e]+[ \t]*:/.test(start);
}

export function formatSize(size: number): string {
    if (size < 1024) {
        return size + ' B';
    }
    if (size < 1024 * 1024) {
        return (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0) + ' KB';
    }
    return (size / 1024 / 1024).toFixed(1) + ' MB';
}

/** A file name for a downloaded message */
export function fileName(subject: string, uid: number): string {
    const base = subject
        .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return (base || 'message-' + uid) + '.eml';
}
