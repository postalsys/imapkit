// One terminal session of the playground: an in-memory connection to the ImapKit server running in the page
// (server.connect() of the browser bundle). The output is written straight into a DOM element, not through React
// state, so long transcripts stay fast

/** The parts of the browser bundle the playground uses */
export interface MemorySocket {
    encrypted: boolean;
    write(data: string): boolean;
    destroy(): void;
    on(event: 'data', listener: (chunk: Uint8Array) => void): void;
    on(event: 'close', listener: () => void): void;
    on(event: 'error', listener: (err: Error & { code?: string }) => void): void;
}

export interface SessionInfo {
    session: number;
    user: string | null;
    state: string;
    mailbox: string | null;
    readOnly: boolean;
    secure: boolean;
    enabled: string[];
}

/** A mailbox as `server.control.listMailboxes()` describes it */
export interface MailboxInfo {
    path: string;
    delimiter: string;
    flags: string[];
    selectable: boolean;
    messages: number;
    unseen: number;
    uidvalidity: number;
    specialUse?: string[];
}

/** A message as `server.control.listMessages()` describes it */
export interface MessageInfo {
    uid: number;
    flags: string[];
    internaldate: string;
    size: number;
    raw?: Uint8Array;
}

/** The parts of the control API the storage manager uses, see "Control API" in the README */
export interface Control {
    listMailboxes(): MailboxInfo[];
    listMessages(path: string, options?: { raw?: boolean }): MessageInfo[];
    getMessage(path: string, uid: number): MessageInfo;
    addMessage(path: string, message: { raw: Uint8Array; flags?: string[]; internaldate?: Date }, options?: { checks?: boolean }): { uid: number };
    setFlags(path: string, uids: number[], flags: string[], mode: 'set' | 'add' | 'remove'): unknown;
    expungeMessages(path: string, uids: number[]): number[];
    moveMessages(path: string, uids: number[], target: string): unknown;
    copyMessages(path: string, uids: number[], target: string): unknown;
    createMailbox(path: string, options?: { subscribed?: boolean }): MailboxInfo;
    renameMailbox(path: string, newPath: string): MailboxInfo;
    deleteMailbox(path: string): void;
    reset(): void;
}

export interface ImapServer {
    connect(options?: { secure?: boolean }): MemorySocket;
    close(callback?: () => void): void;
    on(event: 'session', listener: (event: { type: string; session: SessionInfo }) => void): void;
    on(event: 'command' | 'mailbox' | 'notify' | 'reset', listener: () => void): void;
    off(event: string, listener: (...args: never[]) => void): void;
    sessionCounter: number;
    control: Control;
}

export type ImapKitFactory = (options: { plugins: string[]; storage?: unknown }) => ImapServer;

// RFC 3501 commands and the extension commands, a line that starts with one gets a tag
export const COMMANDS = [
    'APPEND',
    'AUTHENTICATE',
    'CANCELUPDATE',
    'CAPABILITY',
    'CHECK',
    'CLOSE',
    'COPY',
    'CREATE',
    'DELETE',
    'DELETEACL',
    'ENABLE',
    'ESEARCH',
    'EXAMINE',
    'EXPUNGE',
    'FETCH',
    'GETACL',
    'GETMETADATA',
    'GETQUOTA',
    'GETQUOTAROOT',
    'ID',
    'IDLE',
    'LIST',
    'LISTRIGHTS',
    'LOGIN',
    'LOGOUT',
    'LSUB',
    'MOVE',
    'MYRIGHTS',
    'NAMESPACE',
    'NOOP',
    'NOTIFY',
    'RENAME',
    'REPLACE',
    'SEARCH',
    'SELECT',
    'SETACL',
    'SETMETADATA',
    'SETQUOTA',
    'SORT',
    'STARTTLS',
    'STATUS',
    'STORE',
    'SUBSCRIBE',
    'THREAD',
    'UID',
    'UNAUTHENTICATE',
    'UNSELECT',
    'UNSUBSCRIBE'
];
const COMMAND_SET = new Set(COMMANDS);

const MAX_LINES = 5000;
let nextId = 0;

export interface SessionOptions {
    secure: boolean;
    autoTag: boolean;
}

export class TerminalSession {
    /** unique in the page, sessions of different servers share numbers */
    id = ++nextId;
    server: ImapServer;
    socket: MemorySocket;
    number: number;
    info: SessionInfo;
    closed = false;
    /** the server waits for continuation data: IDLE, AUTHENTICATE, or a literal typed by hand */
    awaitingContinuation = false;
    options: SessionOptions;
    output: HTMLElement | null = null;
    onChange: () => void;
    /** commands sent so far, and the unsent input, for the prompt */
    history: string[] = [];
    draft = '';
    focusInput?: () => void;

    private stickToBottom = true;
    private scrollScheduled = false;
    private detach = new AbortController();
    private observer: ResizeObserver | null = null;
    private tagCounter = 0;
    private pendingTag: string | null = null;
    private pendingCommand = '';
    private queued: string[] = [];
    private lines: HTMLElement[] = [];
    private reader: ResponseReader;

    constructor(server: ImapServer, options: SessionOptions, onChange: () => void) {
        this.server = server;
        this.options = options;
        this.onChange = onChange;
        this.socket = server.connect({ secure: options.secure });
        this.number = server.sessionCounter;
        this.info = { session: this.number, user: null, state: 'Not Authenticated', mailbox: null, readOnly: false, secure: options.secure, enabled: [] };

        this.reader = new ResponseReader(
            (line, continued) => this.serverLine(line, continued),
            text => this.print('', text, 'lit')
        );
        this.socket.on('data', chunk => this.reader.push(chunk));
        this.socket.on('error', err => this.note(err.code === 'ECONNRESET' ? 'The server reset the connection' : err.message));
        this.socket.on('close', () => {
            this.closed = true;
            this.awaitingContinuation = false;
            this.note('Connection closed. Press Enter to reconnect.');
            this.onChange();
        });
    }

    /** the tag the next command gets */
    get nextTag(): string {
        return 'A' + (this.tagCounter + 1);
    }

    /** IDLE runs, DONE ends it */
    get idling(): boolean {
        return this.awaitingContinuation && this.pendingCommand === 'IDLE';
    }

    attach(output: HTMLElement): void {
        if (this.output === output) {
            return;
        }
        this.output = output;
        output.replaceChildren(...this.lines);
        const scroller = output.parentElement;
        if (scroller) {
            // the view follows new output until the user scrolls up, also when the pane changes size (a new session).
            // Only the user can turn that off, a layout change also moves the scroll position
            let userScroll = 0;
            const intent = () => (userScroll = Date.now());
            const signal = this.detach.signal;
            scroller.addEventListener('wheel', intent, { passive: true, signal });
            scroller.addEventListener('touchmove', intent, { passive: true, signal });
            // a press on the scrollbar, not a click into the text
            scroller.addEventListener('mousedown', event => event.offsetX >= scroller.clientWidth && intent(), { signal });
            scroller.addEventListener('keydown', event => ['PageUp', 'PageDown', 'Home', 'End'].includes(event.key) && intent(), { signal });
            scroller.addEventListener(
                'scroll',
                () => {
                    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60) {
                        this.stickToBottom = true;
                    } else if (Date.now() - userScroll < 1000) {
                        this.stickToBottom = false;
                    }
                },
                { signal }
            );
            this.observer = new ResizeObserver(() => this.stickToBottom && this.scrollToBottom());
            this.observer.observe(scroller);
            this.scrollToBottom();
        }
    }

    scrollToBottom(): void {
        const scroller = this.output?.parentElement;
        if (scroller) {
            scroller.scrollTop = scroller.scrollHeight;
        }
    }

    update(info: SessionInfo): void {
        if (!this.closed) {
            this.info = info;
            this.onChange();
        }
    }

    note(text: string): void {
        this.print('', text, 'note');
    }

    clear(): void {
        this.lines = [];
        this.output?.replaceChildren();
    }

    /** what the screen shows, as text */
    transcript(): string {
        return this.lines.map(row => row.dataset.text).join('\n') + '\n';
    }

    destroy(): void {
        this.closed = true;
        this.socket.destroy();
        this.detach.abort();
        this.observer?.disconnect();
    }

    /**
     * Sends what the user typed. A line that starts with a command name gets the next tag, a line typed while the
     * server waits for a continuation (DONE of IDLE, a SASL response) goes out as it is. Synchronizing literals,
     * `{n}` at the end of a line, wait for the + continuation before their data goes out (RFC 3501 section 7.5)
     *
     * @return the line as it was sent, without CRLF, or null when nothing was sent
     */
    run(typed: string): string | null {
        if (this.closed || !typed.trim()) {
            return null;
        }
        let text = typed.replace(/\r?\n/g, '\r\n');
        if (!text.endsWith('\r\n')) {
            text += '\r\n';
        }
        text = fillLiteralSizes(text);
        if (this.history[this.history.length - 1] !== typed) {
            this.history.push(typed);
        }

        if (this.awaitingContinuation) {
            this.awaitingContinuation = false;
            this.write(text);
            this.onChange();
            return text.trimEnd();
        }

        const words = text.trim().split(/\s+/);
        const firstIsCommand = COMMAND_SET.has(words[0].toUpperCase());
        if (this.options.autoTag && (firstIsCommand || !COMMAND_SET.has((words[1] || '').toUpperCase()))) {
            text = this.nextTag + ' ' + text;
            this.tagCounter++;
        }
        const [tag, command = '', sub = ''] = text.trim().split(/\s+/);
        this.pendingTag = tag;
        this.pendingCommand = (command.toUpperCase() === 'UID' ? 'UID ' + sub : command).toUpperCase();

        // the data after a synchronizing literal waits for the + continuation
        const pieces = text.split(/(?<=\{\d+\}\r\n)/);
        this.queued = pieces.slice(1);
        this.write(pieces[0]);
        this.onChange();
        return text.trimEnd();
    }

    private write(text: string): void {
        for (const line of text.replace(/\r\n$/, '').split('\r\n')) {
            this.print('C:', line, 'client');
        }
        this.socket.write(text);
    }

    private serverLine(line: string, continued: boolean): void {
        if (continued) {
            this.print('', line, '');
            return;
        }
        let kind = 'untagged';
        const status = /^(\S+) (OK|NO|BAD|BYE)\b/i.exec(line);
        if (line.startsWith('+')) {
            kind = 'cont';
        } else if (status && status[1] !== '*') {
            kind = status[2].toLowerCase();
        } else if (status) {
            // untagged: BYE is the end, NO and BAD warnings
            kind = status[2].toUpperCase() === 'BYE' ? 'bad' : status[2].toUpperCase() === 'OK' ? 'untagged' : 'no';
        }
        this.print('S:', line, kind);

        if (line.startsWith('+')) {
            if (this.queued.length) {
                this.write(this.queued.shift() as string);
            } else {
                this.awaitingContinuation = true;
            }
            this.onChange();
        } else if (status && status[1] === this.pendingTag) {
            // the command is done, data still waiting for a continuation is not sent
            this.pendingTag = null;
            this.pendingCommand = '';
            this.queued = [];
            this.awaitingContinuation = false;
            this.onChange();
        }
    }

    private print(gutter: string, text: string, kind: string): void {
        const row = document.createElement('div');
        row.dataset.text = (gutter ? gutter + ' ' : '   ') + text;
        row.className = 'pg-line pg-' + (kind || 'plain');
        const marker = document.createElement('span');
        marker.className = 'pg-gutter';
        marker.textContent = gutter;
        marker.setAttribute('aria-hidden', 'true');
        const content = document.createElement('span');
        content.className = 'pg-text';
        content.textContent = text;
        row.append(marker, content);
        this.lines.push(row);
        if (this.lines.length > MAX_LINES) {
            this.lines.shift()?.remove();
        }
        if (this.output) {
            this.output.append(row);
            // once per frame, a long FETCH prints many lines at once
            if (this.stickToBottom && !this.scrollScheduled) {
                this.scrollScheduled = true;
                requestAnimationFrame(() => {
                    this.scrollScheduled = false;
                    this.scrollToBottom();
                });
            }
        }
    }
}

/**
 * Splits the output of the server into lines and literals. Literal sizes count octets, so it works on bytes
 */
class ResponseReader {
    private buffer: Uint8Array = new Uint8Array(0);
    private literal = 0;
    // the line after a literal continues the response that the literal is part of
    private continued = false;
    private decoder = new TextDecoder();

    constructor(
        private onLine: (line: string, continued: boolean) => void,
        private onLiteral: (text: string) => void
    ) {}

    push(chunk: Uint8Array): void {
        if (this.buffer.length) {
            const joined = new Uint8Array(this.buffer.length + chunk.length);
            joined.set(this.buffer);
            joined.set(chunk, this.buffer.length);
            this.buffer = joined;
        } else {
            this.buffer = chunk;
        }

        while (this.buffer.length) {
            if (this.literal) {
                const size = Math.min(this.literal, this.buffer.length);
                const text = this.decoder.decode(this.buffer.subarray(0, size)).replace(/\r?\n$/, '');
                for (const line of text.split(/\r?\n/)) {
                    this.onLiteral(line);
                }
                this.buffer = this.buffer.subarray(size);
                this.literal -= size;
                this.continued = true;
                continue;
            }
            const end = this.buffer.indexOf(10);
            if (end < 0) {
                return;
            }
            const line = this.decoder.decode(this.buffer.subarray(0, end + 1));
            this.buffer = this.buffer.subarray(end + 1);
            const match = /~?\{(\d+)\}\r?\n$/.exec(line);
            this.literal = match ? Number(match[1]) : 0;
            this.onLine(line.replace(/\r?\n$/, ''), this.continued);
            this.continued = false;
        }
    }
}

/**
 * Replaces `{size}` (or `{size+}` for LITERAL+) at the end of a line with the octet count of the lines after it, so a
 * typed APPEND needs no counting
 */
export function fillLiteralSizes(text: string): string {
    const match = /\{size(\+?)\}\r\n/i.exec(text);
    if (!match) {
        return text;
    }
    const data = text.slice(match.index + match[0].length).replace(/\r\n$/, '');
    const body = data + '\r\n';
    const size = new TextEncoder().encode(body).length;
    return text.slice(0, match.index) + '{' + size + match[1] + '}\r\n' + body + '\r\n';
}
