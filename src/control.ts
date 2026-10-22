/**
 * The control API, `server.control`: inspects and changes the server state from a test, without an IMAP session.
 * Every change reaches the connected sessions as if another session had made it (EXISTS, EXPUNGE or VANISHED,
 * unsolicited FETCH, BYE, NOTIFY events, CONDSTORE mod-sequences), with no session as its origin. The API is the
 * operator: ACL does not apply, but every argument is checked. Mailboxes are addressed by their storage name
 * (modified UTF-7), messages by mailbox and UID. Methods return plain data and throw an ImapKitError with a `code`:
 * NONEXISTENT, ALREADYEXISTS, INVALID, or the response code of a failed mailbox operation (CANNOT, HASCHILDREN ...)
 */

import validateMailboxName from './mailbox-name.js';
import {
    DEFAULT_SESSION_TIMEOUT,
    ImapKitError,
    expungeMessages,
    checkFlags,
    changeFlags,
    createMailbox,
    deleteMailbox,
    renameMailbox,
    resetUidValidity,
    subscribeMailbox,
    unsubscribeMailbox
} from './store-operations.js';
import type { FlagMode, UidValidityOptions } from './store-operations.js';
import type { IMAPConnection, IMAPServer, Mailbox, Message, StorageMailbox, StorageNamespace, UserData } from './types.js';

/** A mailbox as `getMailbox()` and `listMailboxes()` describe it */
interface MailboxInfo {
    path: string;
    delimiter: string;
    /** mailbox attributes, e.g. \Noselect, \HasChildren */
    flags: string[];
    /** false for a \Noselect name that only holds child mailboxes */
    selectable: boolean;
    subscribed: boolean;
    messages: number;
    unseen: number;
    uidnext: number;
    uidvalidity: number;
    /** the flags of the FLAGS response, SELECT adds \* to PERMANENTFLAGS when new keywords are allowed */
    permanentFlags: string[];
    /** only with CONDSTORE */
    highestModseq?: number;
    /** only with SPECIAL-USE */
    specialUse?: string[];
    /** only with OBJECTID */
    mailboxId?: string;
}

/** A message as `getMessage()` and `listMessages()` describe it */
interface MessageInfo {
    uid: number;
    flags: string[];
    internaldate: string;
    /** size of the source in octets */
    size: number;
    /** only with CONDSTORE */
    modseq?: number;
    /** only with OBJECTID */
    emailId?: string;
    threadId?: string;
    /** the message source, only when asked for */
    raw?: Buffer;
}

/** A connected session as `sessions()` describes it */
interface SessionInfo {
    session: number;
    user: string | null;
    state: string;
    /** storage name of the selected mailbox */
    mailbox: string | null;
    readOnly: boolean;
    /** extensions enabled with ENABLE */
    enabled: string[];
    secure: boolean;
    compressed: boolean;
    remoteAddress: string | null;
}

interface NewMessage {
    /** the message source, a string is encoded as UTF-8 */
    raw: string | Uint8Array;
    flags?: string[] | undefined;
    /** a Date or a RFC 3501 date-time string, the current time if not set */
    internaldate?: Date | string | undefined;
}

/** The credentials of a user, see UserData */
type UserOptions = Pick<UserData, 'password' | 'xoauth2'>;

/** What a REST route handler gets, see src/rest.ts */
interface RouteRequest {
    params: Record<string, string>;
    query: URLSearchParams;
    body: any;
}

/** A REST route of the control API, see src/rest.ts */
interface ControlRoute {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    /** URL path, `{name}` matches one URL encoded segment */
    path: string;
    summary: string;
    /** returns the response body, `{ status, body }` for another status than 200 */
    handler(request: RouteRequest): unknown;
}

/** Selects sessions: a session number, or the sessions of a user */
type SessionFilter = number | { session?: number | undefined; user?: string | undefined };

/**
 * Copies a value of a plugin into the snapshot as JSON data, values that JSON can not hold are left out
 *
 * @param {*} value Any value
 * @return {*} a JSON copy, or undefined
 */
function jsonCopy(value: unknown): unknown {
    if (value === undefined || typeof value === 'function') {
        return undefined;
    }
    // strings, numbers and booleans are immutable, the message source does not need a round trip
    return value === null || typeof value !== 'object' ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Copies the properties of an object as JSON data, except the listed keys and values JSON can not hold
 *
 * @param {Object} source Object to copy
 * @param {Set} skip Keys to leave out
 * @return {Object} copy
 */
function copyProperties(source: Record<string, any>, skip: Set<string>): Record<string, any> {
    const result: Record<string, any> = {};
    Object.keys(source).forEach(key => {
        const value = skip.has(key) ? undefined : jsonCopy(source[key]);
        if (value !== undefined) {
            result[key] = value;
        }
    });
    return result;
}

const MESSAGE_SKIP = new Set(['ghost']);
const NAMESPACE_SKIP = new Set(['folders']);

// properties the server derives when it loads a mailbox, a snapshot leaves them out
const DERIVED_MAILBOX_KEYS = new Set(['path', 'namespace', 'messages', 'folders', 'subscribed', 'flags']);
const DERIVED_FLAGS = new Set(['\\HasChildren', '\\HasNoChildren']);

class Control {
    // plugins add their operations with register()
    [key: string]: any;

    server: IMAPServer;
    /** REST routes that plugins registered, the REST API serves them after its own */
    routes: ControlRoute[];
    /** `(mailbox, copy)` functions that put plugin data that is not JSON into the snapshot of a mailbox */
    snapshotHandlers: ((mailbox: Mailbox, copy: StorageMailbox) => void)[];
    /** `(mailbox, info)` and `(message, info)` functions that add plugin fields to getMailbox() and getMessage() */
    mailboxInfoHandlers: ((mailbox: Mailbox, info: MailboxInfo) => void)[];
    messageInfoHandlers: ((message: Message, info: MessageInfo) => void)[];

    constructor(server: IMAPServer) {
        this.server = server;
        this.routes = [];
        this.snapshotHandlers = [];
        this.mailboxInfoHandlers = [];
        this.messageInfoHandlers = [];
    }

    /**
     * Adds an operation of a plugin, e.g. `server.control.setAcl()` of ACL, so that a plugin that is not loaded
     * leaves no trace. The operation runs with no session as its origin, like the built-in ones, and throws
     * ImapKitErrors (see storeError() in store-operations.ts)
     *
     * @param {String} name Method name on server.control
     * @param {Function} fn Operation
     * @param {Array} [routes] REST routes of the operation
     */
    register(name: string, fn: (...args: any[]) => unknown, routes?: ControlRoute[]): void {
        if (name in this) {
            throw new Error('Control operation ' + name + ' exists already');
        }
        this[name] = (...args: unknown[]) => this.run(() => fn(...args));
        this.routes.push(...(routes || []));
    }

    /**
     * Runs a change with no session as its origin, also when a listener of a command event calls the API
     *
     * @param {Function} fn Change
     * @return {*} the result of fn
     */
    run<T>(fn: () => T): T {
        return this.server.withOrigin(null, fn);
    }

    /**
     * Finds a mailbox by its storage name
     *
     * @param {String} path Storage name, INBOX in any case
     * @param {Boolean} [selectable] true if the mailbox must hold messages (not \Noselect)
     * @return {Object} mailbox
     * @throws {ImapKitError} NONEXISTENT
     */
    requireMailbox(path: unknown, selectable?: boolean): Mailbox {
        const mailbox = typeof path === 'string' && path ? this.server.getMailbox(path) : undefined;
        if (!mailbox || (selectable && mailbox.flags.indexOf('\\Noselect') >= 0)) {
            throw new ImapKitError('Mailbox ' + JSON.stringify(path) + ' does not exist', 'NONEXISTENT');
        }
        return mailbox;
    }

    /**
     * Checks a new mailbox name
     *
     * @param {String} path Storage name
     * @throws {ImapKitError} INVALID for a name that is not valid modified UTF-7
     */
    checkName(path: unknown): asserts path is string {
        this.checkPath(path);
        const problem = validateMailboxName(path);
        if (problem) {
            throw new ImapKitError(problem, 'INVALID');
        }
    }

    /**
     * Checks that a mailbox argument is a name, the store operations check the rest
     *
     * @param {String} path Storage name
     * @throws {ImapKitError} INVALID
     */
    checkPath(path: unknown): asserts path is string {
        if (typeof path !== 'string' || !path) {
            throw new ImapKitError('Mailbox name must be a non-empty string', 'INVALID');
        }
    }

    /**
     * Finds messages by UID
     *
     * @param {Object} mailbox Mailbox
     * @param {Array} uids UIDs of the messages
     * @return {Array} messages in the order of the UIDs, without duplicates
     * @throws {ImapKitError} INVALID for a list that is not UIDs, NONEXISTENT for a UID that is not in the mailbox
     */
    requireMessages(mailbox: Mailbox, uids: unknown): Message[] {
        if (!Array.isArray(uids) || uids.some(uid => !Number.isSafeInteger(uid) || uid < 1)) {
            throw new ImapKitError('UIDs must be an array of positive integers', 'INVALID');
        }
        const byUid = new Map(mailbox.messages.map(message => [message.uid, message]));
        const missing = uids.filter(uid => !byUid.has(uid));
        if (missing.length) {
            throw new ImapKitError('No message with UID ' + missing.join(', ') + ' in ' + mailbox.path, 'NONEXISTENT');
        }
        return [...new Set(uids as number[])].map(uid => byUid.get(uid) as Message);
    }

    /**
     * Finds the sessions a filter selects
     *
     * @param {Number|Object} filter A session number, or `{ session, user }`
     * @return {Array} connections
     */
    findSessions(filter: SessionFilter): IMAPConnection[] {
        const query = typeof filter === 'number' ? { session: filter } : filter || {};
        if (query.session === undefined && query.user === undefined) {
            throw new ImapKitError('Select sessions by number or user', 'INVALID');
        }
        // a session that is closing already (BYE) is left out
        return [...this.server.connections].filter(
            connection =>
                connection.isOpen() &&
                (query.session === undefined || connection.sessionNumber === query.session) &&
                (query.user === undefined || connection.username === query.user)
        );
    }

    // Inspection

    /**
     * Returns the storage as JSON data in the shape of the `storage` option, so that `imapkit({ storage })` with it
     * starts from the same mailboxes, messages, UIDs, flags and subscriptions. Plugin data on mailboxes and messages
     * is included as far as it is JSON data. Subscriptions of names that are not mailboxes are not part of it
     *
     * @return {Object} storage
     */
    snapshot(): Record<string, StorageNamespace> {
        const server = this.server;
        const copyMailbox = (mailbox: Mailbox): StorageMailbox => {
            const result: StorageMailbox = copyProperties(mailbox, DERIVED_MAILBOX_KEYS);
            this.snapshotHandlers.forEach(handler => handler(mailbox, result));
            result.flags = mailbox.flags.filter(flag => !DERIVED_FLAGS.has(flag));
            result.subscribed = !!mailbox.subscribed;
            result.messages = mailbox.messages.map(message => copyProperties(message, MESSAGE_SKIP));
            if (mailbox.folders) {
                result.folders = copyFolders(mailbox.folders);
            }
            return result;
        };
        const copyFolders = (folders: Record<string, Mailbox>) => {
            const result: Record<string, StorageMailbox> = {};
            Object.keys(folders).forEach(name => {
                result[name] = copyMailbox(folders[name]);
            });
            return result;
        };

        const storage: Record<string, StorageNamespace> = {};
        Object.keys(server.storage).forEach(key => {
            if (key === 'INBOX') {
                storage.INBOX = copyMailbox(server.storage.INBOX);
                return;
            }
            const namespace = server.storage[key];
            storage[key] = Object.assign(copyProperties(namespace, NAMESPACE_SKIP), { folders: copyFolders(namespace.folders || {}) });
        });
        return storage;
    }

    /**
     * Describes every mailbox, including \Noselect hierarchy levels
     *
     * @return {Array} mailboxes ordered by name
     */
    listMailboxes(): MailboxInfo[] {
        return Object.keys(this.server.folderCache)
            .sort()
            .map(path => this.describeMailbox(this.server.folderCache[path]));
    }

    /**
     * Describes a mailbox
     *
     * @param {String} path Storage name
     * @return {Object} mailbox info
     */
    getMailbox(path: string): MailboxInfo {
        return this.describeMailbox(this.requireMailbox(path));
    }

    describeMailbox(mailbox: Mailbox): MailboxInfo {
        const status = this.server.getStatus(mailbox);
        const info: MailboxInfo = {
            path: mailbox.path,
            delimiter: this.server.getSeparator(mailbox),
            flags: mailbox.flags.slice(),
            selectable: mailbox.flags.indexOf('\\Noselect') < 0,
            subscribed: !!mailbox.subscribed,
            messages: mailbox.messages.length,
            unseen: status ? status.unseen : 0,
            uidnext: mailbox.uidnext,
            uidvalidity: mailbox.uidvalidity,
            permanentFlags: status ? status.permanentFlags.slice() : []
        };
        if (this.server.condstore && typeof mailbox.HIGHESTMODSEQ === 'number') {
            info.highestModseq = mailbox.HIGHESTMODSEQ;
        }
        this.mailboxInfoHandlers.forEach(handler => handler(mailbox, info));
        return info;
    }

    /**
     * Describes the messages of a mailbox
     *
     * @param {String} path Storage name
     * @param {Object} [options] `{ uids, raw }`: only these UIDs, include the message source
     * @return {Array} messages ordered by UID
     */
    listMessages(path: string, options: { uids?: number[] | undefined; raw?: boolean | undefined } = {}): MessageInfo[] {
        const mailbox = this.requireMailbox(path, true);
        const messages = options.uids ? this.requireMessages(mailbox, options.uids).sort((a, b) => a.uid - b.uid) : mailbox.messages;
        return messages.map(message => this.describeMessage(message, !!options.raw));
    }

    /**
     * Describes a message
     *
     * @param {String} path Storage name
     * @param {Number} uid UID of the message
     * @param {Object} [options] `{ raw }`: include the message source, true by default
     * @return {Object} message info
     */
    getMessage(path: string, uid: number, options: { raw?: boolean | undefined } = {}): MessageInfo {
        const mailbox = this.requireMailbox(path, true);
        return this.describeMessage(this.requireMessages(mailbox, [uid])[0], options.raw !== false);
    }

    describeMessage(message: Message, raw: boolean): MessageInfo {
        const info: MessageInfo = {
            uid: message.uid,
            flags: message.flags.slice(),
            internaldate: message.internaldate,
            size: message.raw.length
        };
        if (this.server.condstore && typeof message.MODSEQ === 'number') {
            info.modseq = message.MODSEQ;
        }
        if (raw) {
            info.raw = Buffer.from(message.raw, 'binary');
        }
        this.messageInfoHandlers.forEach(handler => handler(message, info));
        return info;
    }

    /**
     * Describes the connected sessions
     *
     * @return {Array} sessions ordered by number
     */
    sessions(): SessionInfo[] {
        return [...this.server.connections].map(connection => connection.describe()).sort((a, b) => a.session - b.session);
    }

    // Messages

    /**
     * Adds a message to a mailbox, like a delivery from outside: sessions that have the mailbox selected get EXISTS,
     * the first read-write one sees it as \Recent
     *
     * @param {String} path Storage name
     * @param {Object} message `{ raw, flags, internaldate }`
     * @param {Object} [options] `{ checks }`: true runs the checks APPEND runs (QUOTA, APPENDLIMIT ...), a failed
     *   one throws an ImapKitError with its response code, e.g. OVERQUOTA
     * @return {Object} `{ uid, uidvalidity }`
     */
    addMessage(path: string, message: NewMessage, options: { checks?: boolean | undefined } = {}): { uid: number; uidvalidity: number } {
        const mailbox = this.requireMailbox(path, true);
        const { raw, flags, internaldate } = message || ({} as NewMessage);
        let source: string;
        if (typeof raw === 'string') {
            source = Buffer.from(raw, 'utf-8').toString('binary');
        } else if (raw instanceof Uint8Array) {
            source = Buffer.from(raw).toString('binary');
        } else {
            throw new ImapKitError('Message source (raw) must be a string or a Buffer', 'INVALID');
        }
        if (!source.length) {
            throw new ImapKitError('Message source (raw) can not be empty', 'INVALID');
        }
        const list = checkFlags(this.server, mailbox, flags || [], true);
        if (
            internaldate !== undefined &&
            !(internaldate instanceof Date && !isNaN(internaldate.getTime())) &&
            !this.server.validateInternalDate(internaldate)
        ) {
            throw new ImapKitError('Internal date must be a Date or a date-time string like "17-Jul-1996 02:44:25 -0700"', 'INVALID');
        }
        if (options.checks) {
            const failure = this.server.appendChecks
                .map(check => check(null, mailbox, [{ raw: source, flags: list, internaldate }], { command: 'APPEND' }))
                .find(result => result && !result.soft);
            if (failure) {
                const code = Array.isArray(failure.code) ? failure.code[0] : failure.code;
                throw new ImapKitError(failure.text, typeof code === 'string' ? code : 'CANNOT');
            }
        }
        const added = this.run(() => this.server.appendMessage(mailbox, list, internaldate || null, source));
        return { uid: added.message.uid, uidvalidity: mailbox.uidvalidity };
    }

    /**
     * Changes the flags of messages. Sessions that have the mailbox selected get unsolicited FETCH responses, with
     * CONDSTORE the messages get new mod-sequences
     *
     * @param {String} path Storage name
     * @param {Array} uids UIDs of the messages
     * @param {Array} flags Flags
     * @param {String} [mode] "set" (default), "add" or "remove"
     * @return {Array} `{ uid, flags }` of every message
     */
    setFlags(path: string, uids: number[], flags: string[], mode: FlagMode = 'set'): { uid: number; flags: string[] }[] {
        const mailbox = this.requireMailbox(path, true);
        const messages = this.requireMessages(mailbox, uids);
        this.run(() => changeFlags(this.server, mailbox, messages, flags, mode));
        return messages.map(message => ({ uid: message.uid, flags: message.flags.slice() }));
    }

    /**
     * Removes messages. Sessions that have the mailbox selected get EXPUNGE (VANISHED with QRESYNC), following the
     * RFC 2180 rules a session's EXPUNGE would
     *
     * @param {String} path Storage name
     * @param {Array} uids UIDs of the messages
     * @return {Array} the removed UIDs
     */
    expungeMessages(path: string, uids: number[]): number[] {
        const mailbox = this.requireMailbox(path, true);
        const messages = this.requireMessages(mailbox, uids);
        return this.run(() => expungeMessages(this.server, mailbox, messages)).map(message => message.uid);
    }

    /**
     * Copies messages to another mailbox, the copies keep flags and internal date and get new UIDs
     *
     * @param {String} path Storage name of the source
     * @param {Array} uids UIDs of the messages
     * @param {String} target Storage name of the target
     * @return {Object} `{ uidvalidity, uids }`: UIDVALIDITY of the target, `{ uid, targetUid }` for every message
     */
    copyMessages(path: string, uids: number[], target: string): { uidvalidity: number; uids: { uid: number; targetUid: number }[] } {
        return this.transfer(path, uids, target, false);
    }

    /**
     * Moves messages to another mailbox: copies them and expunges them from the source
     *
     * @param {String} path Storage name of the source
     * @param {Array} uids UIDs of the messages
     * @param {String} target Storage name of the target
     * @return {Object} `{ uidvalidity, uids }`: UIDVALIDITY of the target, `{ uid, targetUid }` for every message
     */
    moveMessages(path: string, uids: number[], target: string): { uidvalidity: number; uids: { uid: number; targetUid: number }[] } {
        return this.transfer(path, uids, target, true);
    }

    transfer(path: string, uids: number[], target: string, move: boolean): { uidvalidity: number; uids: { uid: number; targetUid: number }[] } {
        const mailbox = this.requireMailbox(path, true);
        const targetMailbox = this.requireMailbox(target, true);
        // in UID order, like COPY and MOVE
        const messages = this.requireMessages(mailbox, uids).sort((a, b) => a.uid - b.uid);
        return this.run(() => {
            const result = messages.map(message => ({ uid: message.uid, targetUid: this.server.copyMessage(targetMailbox, message).message.uid }));
            if (move) {
                expungeMessages(this.server, mailbox, messages);
            }
            return { uidvalidity: targetMailbox.uidvalidity, uids: result };
        });
    }

    /**
     * Replaces a message. The content of a UID never changes (RFC 9051 section 2.3.1.1), so this adds the new
     * message and expunges the old one, the new message gets a new UID. Flags and internal date of the old
     * message are kept unless given
     *
     * @param {String} path Storage name
     * @param {Number} uid UID of the message to replace
     * @param {Object} message `{ raw, flags, internaldate }`
     * @return {Object} `{ uid, uidvalidity }` of the new message
     */
    replaceMessage(path: string, uid: number, message: NewMessage): { uid: number; uidvalidity: number } {
        const mailbox = this.requireMailbox(path, true);
        const old = this.requireMessages(mailbox, [uid])[0];
        const added = this.addMessage(path, {
            raw: message && message.raw,
            flags: message && message.flags ? message.flags : old.flags.slice(),
            internaldate: message && message.internaldate ? message.internaldate : old.internaldate
        });
        this.run(() => expungeMessages(this.server, mailbox, [old]));
        return added;
    }

    // Mailboxes

    /**
     * Creates a mailbox, with any missing superior levels
     *
     * @param {String} path Storage name
     * @param {Object} [options] `{ subscribed }`
     * @return {Object} mailbox info
     */
    createMailbox(path: string, options: { subscribed?: boolean | undefined } = {}): MailboxInfo {
        this.checkName(path);
        const mailbox = this.run(() => {
            const created = createMailbox(this.server, path);
            if (options.subscribed) {
                subscribeMailbox(this.server, created.path);
            }
            return created;
        });
        return this.describeMailbox(mailbox);
    }

    /**
     * Deletes a mailbox. Sessions that have it selected are disconnected with BYE, like after DELETE in another session
     *
     * @param {String} path Storage name
     */
    deleteMailbox(path: string): void {
        this.checkPath(path);
        this.run(() => deleteMailbox(this.server, path));
    }

    /**
     * Renames a mailbox, with the RENAME rules (renaming INBOX moves its messages)
     *
     * @param {String} path Storage name
     * @param {String} newPath New storage name
     * @return {Object} info of the renamed mailbox
     */
    renameMailbox(path: string, newPath: string): MailboxInfo {
        this.checkPath(path);
        this.checkName(newPath);
        const result = this.run(() => renameMailbox(this.server, path, newPath));
        return this.getMailbox(result.path);
    }

    /**
     * Gives a mailbox a new UIDVALIDITY, optionally with new UIDs ("keep", "renumber", "shuffle" or "offset"). Sessions
     * that have the mailbox selected are disconnected with BYE, as a UID must not change during a session
     *
     * @param {String} path Storage name
     * @param {Object} [options] `{ uidvalidity, uids, offset, seed }`
     * @return {Object} `{ uidvalidity, uidnext, uids }`, `uids` lists `{ uid, newUid }` for every message
     */
    resetUidValidity(path: string, options: UidValidityOptions = {}): { uidvalidity: number; uidnext: number; uids: { uid: number; newUid: number }[] } {
        const mailbox = this.requireMailbox(path, true);
        return this.run(() => resetUidValidity(this.server, mailbox, options || {}));
    }

    /**
     * Subscribes a mailbox
     *
     * @param {String} path Storage name
     * @return {Boolean} true if the subscription changed
     */
    subscribe(path: string): boolean {
        this.checkPath(path);
        return this.run(() => subscribeMailbox(this.server, path));
    }

    /**
     * Unsubscribes a name, it does not have to be a mailbox
     *
     * @param {String} path Storage name
     * @return {Boolean} true if the subscription changed
     */
    unsubscribe(path: string): boolean {
        this.checkPath(path);
        return this.run(() => unsubscribeMailbox(this.server, path));
    }

    // Users

    /**
     * Lists the users, without credentials
     *
     * @return {Array} `{ name, xoauth2 }`, xoauth2 is true for a user with an access token
     */
    listUsers(): { name: string; xoauth2: boolean }[] {
        return Object.keys(this.server.users)
            .sort()
            .map(name => ({ name, xoauth2: !!(this.server.users[name].xoauth2 && this.server.users[name].xoauth2.accessToken) }));
    }

    /**
     * Adds a user
     *
     * @param {String} name User name
     * @param {Object} options `{ password, xoauth2: { accessToken, sessionTimeout } }`
     */
    addUser(name: string, options: UserOptions): void {
        if (typeof name !== 'string' || !name) {
            throw new ImapKitError('User name must be a non-empty string', 'INVALID');
        }
        if (Object.hasOwn(this.server.users, name)) {
            throw new ImapKitError('User ' + JSON.stringify(name) + ' already exists', 'ALREADYEXISTS');
        }
        this.server.users[name] = this.userData({}, options);
    }

    /**
     * Changes the password or the XOAUTH2 token of a user
     *
     * @param {String} name User name
     * @param {Object} options `{ password, xoauth2 }`, null xoauth2 removes the token
     */
    updateUser(name: string, options: UserOptions): void {
        this.server.users[name] = this.userData(this.requireUser(name), options);
    }

    /**
     * Deletes a user, its sessions are disconnected with BYE unless `disconnect` is false
     *
     * @param {String} name User name
     * @param {Object} [options] `{ disconnect }`
     */
    deleteUser(name: string, options: { disconnect?: boolean | undefined } = {}): void {
        this.requireUser(name);
        delete this.server.users[name];
        if (options.disconnect !== false) {
            this.findSessions({ user: name }).forEach(connection => connection.bye('User was deleted', 'USER DELETED'));
        }
    }

    requireUser(name: unknown): UserData {
        if (typeof name !== 'string' || !Object.hasOwn(this.server.users, name)) {
            throw new ImapKitError('User ' + JSON.stringify(name) + ' does not exist', 'NONEXISTENT');
        }
        return this.server.users[name];
    }

    userData(user: UserData, options: UserOptions): UserData {
        const { password, xoauth2 } = options || ({} as UserOptions);
        const result: UserData = Object.assign({}, user);
        if (password !== undefined) {
            if (typeof password !== 'string') {
                throw new ImapKitError('Password must be a string', 'INVALID');
            }
            result.password = password;
        }
        if (xoauth2 === null) {
            delete result.xoauth2;
        } else if (xoauth2 !== undefined) {
            if (typeof xoauth2 !== 'object' || typeof xoauth2.accessToken !== 'string') {
                throw new ImapKitError('xoauth2 must be { accessToken, sessionTimeout }', 'INVALID');
            }
            result.xoauth2 = { accessToken: xoauth2.accessToken, sessionTimeout: Number(xoauth2.sessionTimeout) || DEFAULT_SESSION_TIMEOUT };
        }
        return result;
    }

    // Server

    /**
     * Disconnects sessions
     *
     * @param {Number|Object} filter A session number, or `{ session, user }`
     * @param {Object} [options] `{ text, reset }`: the text of the untagged BYE, or reset the TCP connection without BYE
     * @return {Number} how many sessions were disconnected
     */
    disconnect(filter: SessionFilter, options: { text?: string | undefined; reset?: boolean | undefined } = {}): number {
        const sessions = this.findSessions(filter);
        sessions.forEach(connection => {
            if (options.reset) {
                connection.closeNow('reset');
            } else {
                connection.bye(options.text || 'Disconnected by the server', 'DISCONNECT');
            }
        });
        return sessions.length;
    }

    /**
     * Writes bytes to a session as they are, e.g. an untagged response between commands (ALERT, BYE, EXISTS).
     * Nothing checks that they are valid IMAP
     *
     * @param {Number} session Session number
     * @param {String|Buffer} data Bytes to send, a string is encoded as UTF-8
     */
    inject(session: number, data: string | Uint8Array): void {
        const connection = this.findSessions({ session })[0];
        if (!connection) {
            throw new ImapKitError('Session ' + session + ' does not exist', 'NONEXISTENT');
        }
        if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
            throw new ImapKitError('Data must be a string or a Buffer', 'INVALID');
        }
        connection.write(Buffer.from(data));
    }

    /**
     * Restores the mailboxes and users of the server options and disconnects every session with BYE, so that a
     * long running server (the imapkit command) can be reused between tests. Plugins restore their own state on
     * the `reset` event (QUOTA limits, server annotations). Script rules stay, `server.script.clear()` removes them
     */
    reset(): void {
        this.server.connections.forEach(connection => {
            if (connection.isOpen()) {
                connection.bye('Server reset', 'RESET');
            }
        });
        this.run(() => {
            this.server.loadUsers();
            this.server.loadStorage();
            this.server.emit('reset');
        });
    }

    /**
     * Stops the server. A graceful shutdown stops accepting connections and waits until the clients disconnect,
     * otherwise the sessions are closed right away
     *
     * @param {Object} [options] `{ graceful }`, true by default
     * @return {Promise} resolves when the server is closed
     */
    shutdown(options: { graceful?: boolean | undefined } = {}): Promise<void> {
        return new Promise((resolve, reject) => {
            const done = (err?: Error) => (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve());
            if (options.graceful === false) {
                this.server.close(done);
            } else {
                this.server.closeListeners(false);
                this.server.closeImapListeners(done);
            }
        });
    }
}

export { Control, ImapKitError };
export type { MailboxInfo, MessageInfo, SessionInfo, NewMessage, UserOptions, SessionFilter, ControlRoute, RouteRequest };
