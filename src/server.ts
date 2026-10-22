import { Stream } from 'node:stream';
import net from 'node:net';
import tls from 'node:tls';
import imapHandler from 'imap-handler';
import type { CompilerOptions, ParserOptions } from 'imap-handler';
import formalSyntax from 'imap-handler/lib/formal';
import loadPlugins from './load-plugins.js';
import { commands as builtinCommands } from './commands/index.js';
import { getCommandOptions, commandOptions } from './command-states.js';
import type { ResolvedCommandOptions } from './command-states.js';
import validateMailboxName from './mailbox-name.js';
import { MONTHS, monthIndex, isDateTime } from './dates.js';
import fetchHandlers from './commands/handlers/fetch.js';
import { hasSequenceSetKey } from './commands/handlers/search.js';
import { isSequenceSet } from './numbers.js';
import { restoreNilAtoms, isAtom } from './arguments.js';
import { refuseMissingTarget } from './commands/append.js';
import { DEFAULT_SESSION_TIMEOUT, storeError, expungeMessages, notifyFlagChanges } from './store-operations.js';
import { Control } from './control.js';
import { resolveQuirks } from './quirks.js';
import { validateStorage } from './storage-schema.js';
import { createRestServer } from './rest.js';
import type { RestServer } from './rest.js';
import type { SessionInfo } from './control.js';
import * as bundledCert from './cert.js';
import { createSocketPair } from './memory-socket.js';
import type { MemorySocket } from './memory-socket.js';
import { ServerScript, sendOutput, handleLine, handleQuiet, literalResponse, releaseDeferred } from './script.js';
import type { DeferredOutput, OutputOperation, ScriptContext, ScriptEvent, ScriptRule } from './script.js';
import type {
    AppendCheck,
    AppendCheckOptions,
    AppendDataHandler,
    AppendMessage,
    Attribute,
    CapabilityCheck,
    CheckResult,
    ClosedCheck,
    CommandCheck,
    CommandContext,
    CommandOptions,
    CommandHandler,
    ConnectionHandler,
    ConnectionState,
    CopyHandler,
    FetchHandler,
    IMAPError,
    IMAPResponse,
    IMAPServerOptions,
    ListedMailbox,
    LiteralFilter,
    Mailbox,
    MailboxChangeEvent,
    MailboxHandler,
    MailboxStatus,
    Message,
    MessageFilter,
    MessageHandler,
    MessageRange,
    Namespace,
    Notification,
    NotifyEvent,
    NotifyFilter,
    OutputHandler,
    ParsedCommand,
    RangeLimit,
    Refusal,
    SearchAccessCheck,
    SearchHandler,
    SearchLimit,
    ServerStorage,
    StatusHandler,
    StorageMailbox,
    StorageMessage,
    StoreHandler,
    SubscriptionStandIn,
    Transport,
    UrlAccessCheck,
    UserData
} from './types.js';

// longest command line (not counting literals) accepted from a client
const MAX_LINE_LENGTH = 1024 * 1024;
// milliseconds between the last output and the RST of a script rule with `close: 'reset'`
const RESET_DELAY = 20;
// largest literal accepted after login, override with the maxLiteralSize option
const MAX_LITERAL_SIZE = 64 * 1024 * 1024;
// largest literal accepted before login, enough for any user name or password
const MAX_PREAUTH_LITERAL_SIZE = 64 * 1024;
const LITERAL_TOO_LARGE = 'Literal too large';
// status responses, their text must follow the RFC 3501 section 9 resp-text rules
const STATUS_RESPONSES = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']);
// RFC 3501 section 9: tag = 1*<any ASTRING-CHAR except "+">
const TAG_REGEX = new RegExp('^[' + formalSyntax.tag().replace(/[\\\]^-]/g, '\\$&') + ']+$');
// RFC 3501 section 9: atom = 1*ATOM-CHAR
const ATOM_CHARS = '[' + formalSyntax['ATOM-CHAR']().replace(/[\\\]^-]/g, '\\$&') + ']+';
const ATOM_REGEX = new RegExp('^' + ATOM_CHARS + '$');
// RFC 3501 section 9: a command name, and the second word of UID and AUTHENTICATE, is an atom
const COMMAND_REGEX = new RegExp('^' + ATOM_CHARS + '( ' + ATOM_CHARS + ')?$');

// RFC spelling of the mailbox attributes the server checks or computes (RFC 3501 section 7.2.2, RFC 3348
// section 3, RFC 5258 section 3), keyed by lowercase name
const MAILBOX_ATTRIBUTES = new Map(
    ['\\Noinferiors', '\\Noselect', '\\Marked', '\\Unmarked', '\\HasChildren', '\\HasNoChildren', '\\NonExistent'].map(flag => [flag.toLowerCase(), flag])
);

/**
 * Returns the tag to use when answering a raw command line that could not be parsed. A line
 * without a valid tag is answered untagged, a client could not parse the invalid tag anyway.
 *
 * @param {String} line Raw command line
 * @return {String} tag or "*"
 */
function getResponseTag(line: string): string {
    // only SP separates the tag (RFC 3501 section 9: command = tag SP ...)
    const space = line.indexOf(' ');
    const tag = space >= 0 ? line.substr(0, space) : line;
    return tag && TAG_REGEX.test(tag) ? tag : '*';
}

/** The parts of a smtp-server SMTPServer that the server uses, smtp-server is an optional dependency */
interface SMTPListener {
    close(callback: () => void): void;
    once(event: 'error', listener: (err: Error) => void): unknown;
    removeListener(event: 'error', listener: (err: Error) => void): unknown;
    server: net.Server;
}

/** The command whose tagged response is pending, and the session state before it ran */
interface CommandStart {
    tag: string;
    command: string;
    state: ConnectionState;
}

/**
 * Text for a command that is not valid in the current connection state
 *
 * @param {String} command Upper case command name
 * @param {String} state Connection state
 * @return {String} Error text
 */
function stateError(command: string, state: string): string {
    return command + ' is not allowed in the ' + state + ' state';
}

/**
 * Checks if a queued notification changes message sequence numbers by removing messages: an EXPUNGE response, or the
 * EXISTS that follows the EXPUNGE responses of another session (it carries the snapshot of the old message list)
 *
 * @param {Object} notification Queued notification
 * @return {Boolean} true if the notification must wait while EXPUNGE responses are not allowed
 */
function isPendingExpunge(notification: Notification): boolean {
    return !!notification.mailboxCopy || isAtom(notification.attributes && notification.attributes[1], 'EXPUNGE');
}

/**
 * Checks if a notification is an untagged EXISTS response
 *
 * @param {Object} [notification] Notification to send
 * @return {Boolean} true for an EXISTS response
 */
function isExists(notification?: Notification): boolean {
    return !!notification && !notification.command && isAtom(notification.attributes && notification.attributes[1], 'EXISTS');
}

/**
 * Answers AUTHENTICATE with a mechanism no plugin supports: NO, not a syntax error (RFC 3501 section 6.2.2). It runs
 * through the command queue, so the state check comes first (AUTHENTICATE is only valid in the Not Authenticated
 * state, RFC 3501 section 6.2)
 */
// usesSequenceNumbers() of each running command
const sequenceNumberUse = new WeakMap<CommandContext, boolean>();

const unsupportedMechanism: CommandHandler = (connection, parsed, data, callback) => {
    connection.sendStatus(parsed, data, 'NO', 'Unsupported authentication mechanism', false, 'UNKNOWN COMMAND');
    callback();
};

/**
 * Creates a new IMAP server, call `listen()` on it to start accepting connections
 *
 * @param options Server options, the mailbox tree comes from `options.storage`
 * @return Server instance
 */
export default function server(options?: IMAPServerOptions): IMAPServer {
    return new IMAPServer(options);
}

class IMAPServer extends Stream {
    // plugins keep their own state on the server (acl, condstore, searchReturnOptions ...)
    [key: string]: any;

    declare options: IMAPServerOptions;
    declare server: net.Server | tls.Server;
    declare connections: Set<IMAPConnection>;

    declare connectionHandlers: ConnectionHandler[];
    declare resetHandlers: ConnectionHandler[];
    declare outputHandlers: OutputHandler[];
    declare messageHandlers: MessageHandler[];
    declare fetchHandlers: Record<string, FetchHandler>;
    declare fetchFilters: MessageFilter[];
    declare searchHandlers: Record<string, SearchHandler>;
    declare storeHandlers: Record<string, StoreHandler>;
    declare storeFilters: MessageFilter[];
    declare notifyFilters: NotifyFilter[];
    declare mailboxHandlers: MailboxHandler[];
    declare appendChecks: AppendCheck[];
    declare copyHandlers: CopyHandler[];
    declare appendDataHandlers: Record<string, AppendDataHandler>;
    declare literalFilters: LiteralFilter[];
    declare urlAccessChecks: UrlAccessCheck[];
    declare searchAccessChecks: SearchAccessCheck[];
    declare commandChecks: CommandCheck[];
    declare rangeLimits: RangeLimit[];
    declare searchLimits: SearchLimit[];
    declare closedChecks: ClosedCheck[];
    declare multiAppend: boolean;
    /** set by BINARY (RFC 3516 section 4.4), converts the octets of an APPEND literal8 to the stored message source */
    declare appendLiteral8?: ((raw: string) => string) | undefined;
    declare commandHandlers: Record<string, CommandHandler>;
    declare commandOptions: Record<string, ResolvedCommandOptions>;
    declare capabilities: Record<string, CapabilityCheck>;
    declare allowedStatus: string[];
    declare statusHandlers: Record<string, StatusHandler>;
    declare literalPlus: boolean;
    declare nonSyncLiteralLimit: number;
    declare parserOptions: ParserOptions;
    /** the personal namespace that an empty LIST reference stands for, set by indexFolders() */
    declare referenceNamespace: string | false;
    declare activeConnection: IMAPConnection | null;
    declare users: Record<string, UserData>;
    declare systemFlags: string[];
    declare storage: ServerStorage;
    declare uidvalidityCounter: number;
    declare subscriptions: Set<string>;
    declare folderCache: Record<string, Mailbox>;
    /** scripted faults, see src/script.ts */
    declare script: ServerScript;
    /** connections accepted so far, the number of a connection is `connection.sessionNumber` */
    declare sessionCounter: number;
    /** the control API, see src/control.ts */
    declare control: Control;
    /** the implicit TLS listener that `start()` runs for the `tls` option */
    declare tlsServer: tls.Server | null;
    /** the SMTP server that `start()` runs for the `smtp` option */
    declare smtpServer: SMTPListener | null;
    /** the HTTP server of the REST API that `start()` runs for the `rest` option */
    declare restServer: RestServer | null;

    constructor(options?: IMAPServerOptions) {
        super();

        // shallow copy, so that the caller's options object is never modified
        this.options = Object.assign({}, options);

        if (this.options.secureConnection) {
            this.server = tls.createServer(this.getCredentials(), this.createClient.bind(this));
        } else {
            this.server = net.createServer(this.createClient.bind(this));
        }

        // every connection listens to the notify event
        this.setMaxListeners(0);
        this.connections = new Set();

        this.connectionHandlers = [];
        // run when a connection returns to the Not Authenticated state (UNAUTHENTICATE), each one
        // clears the per-session state its plugin keeps on the connection
        this.resetHandlers = [];
        this.outputHandlers = [];
        this.messageHandlers = [];
        this.fetchHandlers = {};
        this.fetchFilters = [];
        this.searchHandlers = {};
        this.storeHandlers = {};
        this.storeFilters = [];
        // `filter(connection, notification)` functions, a notification only reaches connections they all accept
        this.notifyFilters = [];
        // run on every mailbox in processMailbox, like messageHandlers for messages
        this.mailboxHandlers = [];
        // consulted before messages are added to a mailbox by APPEND, COPY or MOVE, see IMAPConnection#checkAppend
        this.appendChecks = [];
        // carry properties over when a message is copied to another mailbox (COPY, MOVE, RENAME INBOX), see copyMessage
        this.copyHandlers = [];
        // append-data extensions such as CATENATE (RFC 4466 section 2.7), and checks that can refuse
        // a synchronizing literal before it is read, see IMAPConnection#checkLiteral
        this.appendDataHandlers = Object.create(null);
        // APPEND and REPLACE to a mailbox that does not exist are refused before the message is sent
        this.literalFilters = [refuseMissingTarget];
        // can refuse IMAP URLs that read a mailbox (CATENATE), `(connection, mailbox, url)` returns `{ text }` to refuse
        this.urlAccessChecks = [];
        // can leave mailboxes out of a search of several mailboxes (ESEARCH of MULTISEARCH), `(connection, mailbox, named)`
        // returns false for a mailbox that is skipped, `named` is true if the client gave its name
        this.searchAccessChecks = [];
        // run before a command handler, `(connection, parsed)` returns `{ command, code, text }` to refuse the command
        // (e.g. commands with message sequence numbers after ENABLE UIDONLY), see IMAPConnection#processQueue
        this.commandChecks = [];
        // `(connection, parsed, range)` functions that can cut the messages that FETCH, STORE, COPY, MOVE and UID EXPUNGE
        // (and the UID variants) operate on, e.g. MESSAGELIMIT. See IMAPConnection#limitRange
        this.rangeLimits = [];
        // `(connection, messages, query)` functions that can narrow down the messages a SEARCH (or SORT, THREAD) looks
        // at by returning a shorter list, e.g. MESSAGELIMIT. See commands/handlers/search.ts
        this.searchLimits = [];
        // `check(connection)` functions, SELECT and EXAMINE send `* OK [CLOSED]` when they close the selected mailbox
        // if any of them is true (CONDSTORE, RFC 7162 section 3.2.11, IMAP4rev2, RFC 9051 section 6.3.2)
        this.closedChecks = [];
        // set by MULTIAPPEND (RFC 3502), otherwise APPEND takes a single message
        this.multiAppend = false;
        // the built-in handlers, setCommandHandler replaces them. Without a prototype, a command name like
        // "TOSTRING" never finds an inherited function
        this.commandHandlers = Object.assign(Object.create(null), builtinCommands);
        // options of commands that plugins add, core commands are listed in command-states.ts
        this.commandOptions = Object.create(null);
        this.capabilities = {};
        this.allowedStatus = ['MESSAGES', 'RECENT', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN'];
        // values of STATUS items that plugins add, consulted before the built-in items in commands/handlers/status.ts
        this.statusHandlers = {};
        // non-synchronizing literals {n+} are accepted when literalPlus is set (LITERAL+ and LITERAL-),
        // up to nonSyncLiteralLimit octets (4096 for LITERAL-, RFC 7888 section 5)
        this.literalPlus = false;
        this.nonSyncLiteralLimit = Infinity;
        // extra options for the imap-handler command parser, e.g. literal8 for BINARY
        this.parserOptions = {
            // items that take a [section] and <partial>, the imap-handler default
            allowSection: ['BODY', 'BODY.PEEK']
        };
        this.referenceNamespace = false;
        // the session whose command is running, see IMAPServer#notify
        this.activeConnection = null;
        this.sessionCounter = 0;
        // rules that make the server misbehave on purpose, from the script option or server.script.add(), and the rules
        // of the quirk presets after them
        this.script = new ServerScript(this, this.options.script);
        const quirks = resolveQuirks(this.options.quirks);
        if (quirks.rules.length) {
            this.script.add(quirks.rules);
        }

        this.loadUsers();

        // plugins register their control operations
        this.control = new Control(this);

        // a quirk preset can leave plugins out (no-move, no-uidplus)
        loadPlugins(this, this.options.plugins, quirks.removePlugins);

        if (this.options.storage) {
            // a typo in a fixture fails here with the path of the problem
            validateStorage(this.options.storage);
        }
        this.systemFlags = ([] as string[]).concat(this.options.systemFlags || ['\\Answered', '\\Flagged', '\\Draft', '\\Deleted', '\\Seen']);
        this.loadStorage();
        this.tlsServer = null;
        this.smtpServer = null;
        this.restServer = null;
    }

    /**
     * Sets the users from the `users` option, or the default user. The users are deep copied, so that runtime changes
     * never leak into the caller's objects or into other servers built from the same fixture. Without a prototype,
     * user names like "__proto__" or "toString" are plain keys
     */
    loadUsers(): void {
        this.users = Object.assign(
            Object.create(null),
            this.options.users
                ? structuredClone(this.options.users)
                : {
                      testuser: {
                          password: 'testpass',
                          xoauth2: {
                              accessToken: 'testtoken',
                              sessionTimeout: DEFAULT_SESSION_TIMEOUT
                          }
                      }
                  }
        );
    }

    /**
     * Builds the mailboxes from the `storage` option, a deep copy of it. Message and mailbox handlers of plugins run
     * on every message and mailbox
     */
    loadStorage(): void {
        // indexFolders() below turns the storage option into namespaces and mailboxes in place
        this.storage = (
            this.options.storage
                ? structuredClone(this.options.storage)
                : {
                      INBOX: {},
                      '': {}
                  }
        ) as ServerStorage;
        this.referenceNamespace = false;
        this.uidvalidityCounter = 0; // highest UIDVALIDITY in use, new mailboxes get a higher one
        // subscribed mailbox names (RFC 3501 section 6.3.6). Names, not mailboxes: a subscription outlives
        // DELETE and stays with the old name on RENAME (RFC 9051 section 6.3.6), see trackSubscription
        this.subscriptions = new Set();
        this.folderCache = Object.create(null);
        this.indexFolders(true);
    }

    /**
     * Starts accepting connections
     *
     * @param {Number} [port] Port to listen on, a free port if not set
     * @param {String} [host] Address to listen on, all addresses if not set
     * @return {Promise<Number>} resolves with the port the server listens on
     */
    async start(port?: number, host?: string): Promise<number> {
        const imapPort = await listenOn(this.server, port, host);
        await Promise.all([
            this.options.tls ? this.startTlsListener(host) : null,
            this.options.smtp ? this.startSmtp() : null,
            this.options.rest ? this.startRest() : null
        ]);
        return imapPort;
    }

    /**
     * Starts the implicit TLS listener of the `tls` option. Its sessions are sessions of this server like the ones of
     * the main listener, they share the storage and count as encrypted
     *
     * @param {String} [defaultHost] Address to listen on when the `tls` option has no host
     * @return {Promise<Number>} resolves with the port of the TLS listener
     */
    startTlsListener(defaultHost?: string): Promise<number> {
        const { port, host } = this.options.tls || {};
        this.tlsServer = tls.createServer(this.getCredentials(), this.createClient.bind(this));
        return listenOn(this.tlsServer, port, host || defaultHost);
    }

    /**
     * Starts the REST API of the `rest` option, see src/rest.ts
     *
     * @return {Promise<Number>} resolves with the HTTP port
     */
    async startRest(): Promise<number> {
        const { port, host, token } = this.options.rest || {};
        this.restServer = createRestServer(this, { host, token });
        return listenOn(this.restServer, port, host || '127.0.0.1');
    }

    /**
     * Starts the SMTP server of the `smtp` option. smtp-server is an optional dependency, loaded only here
     *
     * @return {Promise<Number>} resolves with the SMTP port
     */
    startSmtp(): Promise<number> {
        const { port, host } = this.options.smtp || {};
        return this.loadSmtpListener().then(
            ({ startSMTPServer }) =>
                new Promise<number>((resolve, reject) => {
                    const smtp = startSMTPServer(
                        port || 0,
                        this,
                        smtpPort => {
                            smtp.removeListener('error', reject);
                            resolve(smtpPort);
                        },
                        host
                    );
                    smtp.once('error', reject);
                    this.smtpServer = smtp;
                })
        );
    }

    /**
     * Loads the SMTP listener, which needs the smtp-server package
     *
     * @return {Promise<Object>} the smtp-listener module
     */
    loadSmtpListener(): Promise<{
        startSMTPServer(port: number, server: IMAPServer, callback: (port: number) => void, host?: string): SMTPListener;
    }> {
        return import('./smtp-listener.js').catch((err: Error) => {
            throw new Error('The smtp option needs the smtp-server package, install it with: npm install smtp-server (' + err.message + ')');
        });
    }

    /**
     * Stops the server and closes every connection
     *
     * @return {Promise} resolves when the server is closed
     */
    stop(): Promise<void> {
        return this.control.shutdown({ graceful: false });
    }

    /**
     * Starts accepting connections, takes the arguments of `net.Server#listen()`
     */
    listen(port?: number, listeningListener?: () => void): void;
    listen(port: number, hostname: string, listeningListener?: () => void): void;
    listen(options: net.ListenOptions, listeningListener?: () => void): void;
    listen(...args: unknown[]): void {
        (this.server.listen as (...listenArgs: unknown[]) => unknown).apply(this.server, args);
    }

    close(callback?: (err?: Error) => void): void {
        this.closeListeners(true);
        this.closeImapListeners(callback);
        // close() only completes once all connections are gone
        this.connections.forEach((connection: IMAPConnection) => {
            if (connection.socket) {
                connection.socket.destroy();
            }
        });
    }

    /**
     * Stops accepting IMAP connections, on the main listener and on the TLS listener of the `tls` option
     *
     * @param {Function} [callback] Called once both listeners are closed, which is after their last connection is
     *   gone, with the first error
     */
    closeImapListeners(callback?: (err?: Error) => void): void {
        const listeners: (net.Server | tls.Server)[] = this.tlsServer ? [this.server, this.tlsServer] : [this.server];
        this.tlsServer = null;
        let pending = listeners.length;
        let error: Error | undefined;
        listeners.forEach(listener =>
            listener.close(err => {
                error = error || err;
                if (--pending === 0) {
                    callback?.(error);
                }
            })
        );
    }

    /**
     * Stops the SMTP and REST listeners of `start()`
     *
     * @param {Boolean} force true closes the open REST connections too, otherwise only the idle ones (a request that
     *   is answered, like POST /v1/shutdown, finishes first)
     */
    closeListeners(force: boolean): void {
        if (this.smtpServer) {
            this.smtpServer.close(() => false);
            this.smtpServer = null;
        }
        if (this.restServer) {
            // event streams never end on their own, a graceful shutdown would wait for them forever
            this.restServer.endStreams?.();
            this.restServer.close();
            // keep-alive connections would hold the server open
            if (force) {
                this.restServer.closeAllConnections?.();
            } else {
                this.restServer.closeIdleConnections?.();
            }
            this.restServer = null;
        }
    }

    /**
     * Returns TLS key and certificate. Without credentials in the options the
     * bundled self-signed certificate for localhost is used.
     *
     * @return {Object} TLS options
     */
    getCredentials(): { key: string | Buffer; cert: string | Buffer } {
        if (!this.options.credentials) {
            this.options.credentials = {
                key: bundledCert.key,
                cert: bundledCert.cert
            };
        }
        return this.options.credentials;
    }

    address(): ReturnType<net.Server['address']> {
        return this.server.address();
    }

    createClient(socket: net.Socket): void {
        const connection = new IMAPConnection(this, socket);
        this.connectionHandlers.forEach(handler => {
            handler(connection);
        });
    }

    /**
     * Opens a connection to the server in memory, without a network socket (no `listen()` needed). This is how the
     * server runs in a browser, see the README "Run in a browser"
     *
     * @param {Object} [options] `{ secure }`: false makes the connection a plaintext one, where STARTTLS turns on the
     *   encryption (nothing is encrypted, the session only counts as encrypted). By default the connection counts as
     *   one over TLS
     * @return {MemorySocket} the client end, write commands to it and read the responses from its `data` events
     */
    connect(options?: { secure?: boolean | undefined }): MemorySocket {
        const [serverSocket, clientSocket] = createSocketPair();
        serverSocket.encrypted = clientSocket.encrypted = !options || options.secure !== false;
        this.createClient(serverSocket as unknown as net.Socket);
        return clientSocket;
    }

    registerCapability(keyword: string, handler?: CapabilityCheck | null): void {
        this.capabilities[keyword] =
            handler ||
            function () {
                return true;
            };
    }

    /**
     * Sets the handler of a command
     *
     * @param {String} command Command name, e.g. "UID MOVE"
     * @param {Function} handler Command handler `(connection, parsed, data, callback)`
     * @param {Object|Array} [options] `{ states, noArguments, mailboxArguments, astringArguments, searchCriteria, sequenceSet,
     *   noExpunge, literal8, noPipelining }`: the connection states the command is valid in (any state if not set), if it takes
     *   no arguments, the positions of its mailbox name arguments and of its other astring arguments, the position where its search criteria start, the position of its argument
     *   with message sequence numbers, if EXPUNGE responses
     *   are not allowed while it runs, if it accepts literal8 arguments (true, or the name of the capability that
     *   allows them), and if it is refused when the client sent more input after it. A list is read as the states.
     *   Without options, a command keeps its earlier settings
     */
    setCommandHandler(command: string, handler: CommandHandler, options?: CommandOptions | string[] | null): void {
        command = (command || '').toString().toUpperCase();
        this.commandHandlers[command] = handler;
        if (options) {
            this.commandOptions[command] = commandOptions(options);
        }
    }

    /**
     * Returns the options of a command, see setCommandHandler
     *
     * @param {String} command Command name
     * @return {Object} the command options, see setCommandHandler, states is false if any state is fine
     */
    getCommandOptions(command: string | null | undefined): ResolvedCommandOptions {
        command = (command || '').toString().toUpperCase();
        return this.commandOptions[command] || getCommandOptions(command) || commandOptions();
    }

    /**
     * Returns the connection states a command may be used in. Public API for custom plugins (see README), the server
     * itself reads getCommandOptions
     *
     * @param {String} command Command name
     * @return {Array|Boolean} List of states, or false if any state is fine
     */
    getCommandStates(command: string): string[] | false {
        return this.getCommandOptions(command).states;
    }

    /**
     * Returns a user account
     *
     * @param {String} username User name
     * @return {Object|false} User data or false if there is no such user
     */
    getUser(username: unknown): UserData | false {
        return (typeof username === 'string' && this.users[username]) || false;
    }

    /**
     * Returns a mailbox object from folderCache
     *
     * @param {String} path Pathname for the mailbox
     * @return {Object} mailbox object or undefined
     */
    getMailbox(path: string): Mailbox | undefined {
        if (path.toUpperCase() === 'INBOX') {
            return this.folderCache.INBOX;
        }
        return this.folderCache[path];
    }

    /**
     * Schedules a notifying message
     *
     * @param {Object} command An object of untagged response message
     * @param {Object|String} mailbox Mailbox the message is related to
     * @param {Object} ignoreConnection if set the selected connection ignores this notification
     * @param {Function} [filter] if set, only connections for which `filter(connection)` is true get the notification
     */
    notify(
        command: Notification,
        mailbox: Mailbox | string | false | null | undefined,
        ignoreConnection?: IMAPConnection | false | null,
        filter?: ((connection: IMAPConnection) => boolean) | false | null
    ): void {
        command.notification = true;
        const event: NotifyEvent = {
            command: command,
            mailbox: mailbox,
            ignoreConnection: ignoreConnection,
            filter: filter,
            // the session whose command caused the change, null for changes from outside (e.g. SMTP)
            origin: this.activeConnection
        };
        this.emit('notify', event);
    }

    /**
     * Tells plugins that a mailbox was created, deleted, renamed, subscribed or unsubscribed, with a
     * `mailbox` event: `{ type, path, oldPath, mailbox, origin }`. `type` is "create", "delete", "rename",
     * "subscribe" or "unsubscribe", `origin` is the session that made the change
     *
     * @param {String} type Kind of change
     * @param {String} path Storage name of the mailbox
     * @param {Object} [details] `{ oldPath, mailbox, created }`: the earlier name of a renamed mailbox, the mailbox
     *   object that a DELETE removed, the mailboxes a CREATE made (superior levels first)
     */
    mailboxChanged(
        type: string,
        path: string,
        details?: { oldPath?: string | undefined; mailbox?: Mailbox | undefined; created?: string[] | undefined }
    ): void {
        const event: MailboxChangeEvent = Object.assign({ type, path, oldPath: null, mailbox: null }, details, { origin: this.activeConnection });
        this.emit('mailbox', event);
    }

    /**
     * Runs a change with `origin` as the session that caused it, the `origin` of the notifications and events it
     * makes. Commands run with their session, the control API with null
     *
     * @param {Object|null} origin Session, or null for a change from outside
     * @param {Function} fn Change
     * @return {*} the result of fn
     */
    withOrigin<T>(origin: IMAPConnection | null, fn: () => T): T {
        const previous = this.activeConnection;
        this.activeConnection = origin;
        try {
            return fn();
        } finally {
            this.activeConnection = previous;
        }
    }

    /**
     * Retrieves the handler of an IMAP command
     *
     * @param {String} command Command name
     * @return {Function} handler for the specified command
     */
    getCommandHandler(command: string | null | undefined): CommandHandler | false {
        return this.commandHandlers[(command || '').toString().toUpperCase()] || false;
    }

    /**
     * Returns some useful information about a mailbox that can be used with STATUS, SELECT and EXAMINE
     *
     * @param {Object|String} mailbox Mailbox object or path
     */
    getStatus(path: Mailbox | string): MailboxStatus | false {
        const mailbox = typeof path === 'string' ? this.getMailbox(path) : path;
        if (!mailbox) {
            return false;
        }

        const flags: Record<string, number> = {};
        let seen = 0;
        let unseen = 0;
        // flags stay defined in the mailbox once a message had them, see rememberFlags
        const permanentFlags = this.permanentFlagList(mailbox);

        let recent = 0;
        // \Recent sets of the sessions that have this mailbox selected
        const recentSets: Set<Message>[] = [];
        this.connections.forEach(connection => {
            if (connection.selectedMailbox === mailbox && connection.recent) {
                recentSets.push(connection.recent);
            }
        });

        mailbox.messages.forEach(message => {
            if (message.flags.indexOf('\\Seen') < 0) {
                unseen++;
            } else {
                seen++;
            }

            if (message.recent || recentSets.some(set => set.has(message))) {
                recent++;
            }

            message.flags.forEach(flag => {
                if (!flags[flag]) {
                    flags[flag] = 1;
                } else {
                    flags[flag]++;
                }

                if (permanentFlags.indexOf(flag) < 0) {
                    permanentFlags.push(flag);
                }
            });
        });

        return {
            flags: flags,
            seen: seen,
            unseen: unseen,
            recent: recent,
            permanentFlags: permanentFlags
        };
    }

    /**
     * Validates a date value. Useful for validating APPEND dates
     *
     * @param {String} date Date value to be validated
     * @return {Boolean} Returns true if the date string is in IMAP date-time format
     */
    validateInternalDate(date: unknown): boolean {
        // date-time from RFC 3501 section 9
        return isDateTime(date);
    }

    /**
     * Converts a date object to a valid date-time string format
     *
     * @param {Object} date Date object to be converted
     * @return {String} Returns a valid date-time formatted string
     */
    formatInternalDate(date: Date): string {
        const day = date.getDate();
        const month = MONTHS[date.getMonth()];
        const year = date.getFullYear();
        const hour = date.getHours();
        const minute = date.getMinutes();
        const second = date.getSeconds();
        const tz = date.getTimezoneOffset();
        const tzHours = Math.floor(Math.abs(tz) / 60);
        const tzMins = Math.abs(tz) % 60;

        return (
            (day < 10 ? '0' : '') +
            day +
            '-' +
            month +
            '-' +
            year +
            ' ' +
            (hour < 10 ? '0' : '') +
            hour +
            ':' +
            (minute < 10 ? '0' : '') +
            minute +
            ':' +
            (second < 10 ? '0' : '') +
            second +
            ' ' +
            (tz > 0 ? '-' : '+') +
            (tzHours < 10 ? '0' : '') +
            tzHours +
            (tzMins < 10 ? '0' : '') +
            tzMins
        );
    }

    /**
     * Creates a mailbox with specified path
     *
     * @param {String} path Pathname for the mailbox
     * @param {Object} [defaultMailbox] use this object as the mailbox to add instead of empty'
     * @return {Object} the created mailbox
     */
    createMailbox(path: string, defaultMailbox?: StorageMailbox | null): Mailbox {
        if (!path) {
            throw storeError('Invalid mailbox name', 'CANNOT');
        }

        // Ensure case insensitive INBOX
        if (path.toUpperCase() === 'INBOX') {
            throw storeError('INBOX can not be modified', 'ALREADYEXISTS');
        }

        const { namespace, storage } = this.getPersonalNamespace(path);
        path = this.stripSeparator(path, storage.separator);

        if (this.folderCache[path] && this.folderCache[path].flags.indexOf('\\Noselect') < 0) {
            throw storeError('Mailbox already exists', 'ALREADYEXISTS');
        }

        const folderPath = path.substr(namespace.length).split(storage.separator);
        if (folderPath.some(name => !name)) {
            // an empty hierarchy level ("foo//bar", "/foo", "foo//"). RFC 5530 section 3 has this very case as the
            // example of CANNOT, Dovecot refuses it too
            throw storeError('Mailbox names can not have empty hierarchy levels', 'CANNOT');
        }

        let parent: Namespace | Mailbox = storage;
        let curPath = namespace;

        if (curPath) {
            curPath = curPath.substr(0, curPath.length - storage.separator.length);
        }

        folderPath.forEach(folderName => {
            curPath += (curPath.length ? storage.separator : '') + folderName;

            let folder = this.getMailbox(curPath) || false;

            if (folder && folder.flags && folder.flags.indexOf('\\Noinferiors') >= 0) {
                throw storeError('Can not create subfolders for ' + folder.path, 'CANNOT');
            }

            // a \Noselect placeholder that is created again is replaced with a new mailbox that only keeps
            // the children, nothing else of a deleted mailbox may come back (RFC 3501 section 6.3.3)
            const isTarget = curPath === path;
            const useDefault = isTarget && defaultMailbox;
            if (!folder || useDefault || (isTarget && folder.flags.indexOf('\\Noselect') >= 0)) {
                const children = folder && folder.folders;
                // a recreated mailbox must never reuse an earlier UIDVALIDITY value
                const created: StorageMailbox = useDefault ? defaultMailbox : { uidvalidity: ++this.uidvalidityCounter };
                if (children) {
                    created.folders = Object.assign({}, children, created.folders);
                }
                // a new mailbox is subscribed if its name is, a subscription is not part of the mailbox
                this.trackSubscription(created);
                this.processMailbox(curPath, created, namespace);
                parent.folders = parent.folders || {};
                parent.folders[folderName] = created;
                this.folderCache[curPath] = created;
                folder = created;
            }

            if (parent !== storage) {
                // Remove \HasNoChildren and add \\HasChildren from parent. A \Noselect parent stays \Noselect,
                // it already is the hierarchy level the new mailbox needs
                this.setChildrenFlags(parent as Mailbox, true);
            } else if (folder.namespace === this.referenceNamespace && this.inboxHoldsNamespace()) {
                this.setChildrenFlags(this.storage.INBOX, true);
            }

            parent = folder;
        });

        return this.folderCache[path];
    }

    /**
     * Deletes a mailbox with specified path
     *
     * @param {String} path Pathname for the mailbox
     * @param {boolean} keepContents If true do not delete messages
     */
    deleteMailbox(path: string, keepContents?: boolean): void {
        // Ensure case insensitive INBOX
        if (path.toUpperCase() === 'INBOX') {
            throw storeError('INBOX can not be modified', 'CANNOT');
        }

        const { namespace, storage } = this.getPersonalNamespace(path);
        const mailbox = this.folderCache[this.stripSeparator(path, storage.separator)];

        if (!mailbox) {
            throw storeError('Mailbox does not exist', 'NONEXISTENT');
        }

        if (mailbox.flags.indexOf('\\Noselect') >= 0 && Object.keys(mailbox.folders || {}).length) {
            // RFC 9051 section 6.3.5: deleting a \Noselect name that has inferior names is an error, the RFC 5530
            // section 3 HASCHILDREN response code tells the client to delete the children first
            throw storeError('Mailbox has children, delete them first', 'HASCHILDREN');
        }

        const levels = mailbox.path.split(storage.separator);
        const folderName = levels.pop() as string;
        const parentKey = levels.join(storage.separator);
        const parent: Namespace | Mailbox = (parentKey !== 'INBOX' && this.folderCache[parentKey]) || storage;

        if (mailbox.folders && Object.keys(mailbox.folders).length && !keepContents) {
            // Sessions that have the mailbox selected keep the old object, a new SELECT finds the
            // placeholder. The placeholder only keeps the children. Plugin data (MAILBOXID, special-use, metadata, ACL,
            // HIGHESTMODSEQ ...) belongs to the deleted mailbox and must not survive (RFC 3501 section 6.3.4)
            const folder = {
                flags: ['\\Noselect'],
                folders: mailbox.folders
            };
            this.trackSubscription(folder);
            this.processMailbox(mailbox.path, folder, mailbox.namespace);
            (parent.folders as Record<string, Mailbox>)[folderName] = folder;
            this.folderCache[mailbox.path] = folder;
            return;
        }

        delete this.folderCache[mailbox.path];
        delete (parent.folders as Record<string, Mailbox>)[folderName];

        if (parent !== storage) {
            if (parent.flags.indexOf('\\Noselect') >= 0 && !Object.keys(parent.folders || {}).length) {
                this.deleteMailbox(parent.path);
            } else {
                this.setChildrenFlags(parent as Mailbox, Object.keys(parent.folders || {}).length > 0);
            }
        } else if (namespace === this.referenceNamespace && this.inboxHoldsNamespace()) {
            this.setChildrenFlags(this.storage.INBOX, Object.keys(storage.folders || {}).length > 0);
        }
    }

    /**
     * Finds the personal namespace that a new or existing mailbox name belongs to, for CREATE and DELETE
     *
     * @param {String} path Mailbox path
     * @return {Object} `{ namespace, storage }`, the namespace key and its storage object
     * @throws {Error} CANNOT for a namespace prefix or a name in no namespace, NOPERM outside personal namespaces
     */
    getPersonalNamespace(path: string): { namespace: string; storage: Namespace } {
        let namespace = '';
        Object.keys(this.storage).forEach(key => {
            if (key === 'INBOX') {
                return;
            }
            const prefix = key.length ? key.substr(0, key.length - this.storage[key].separator.length) : key;
            if (key.length && (path === prefix || path.substr(0, key.length) === key)) {
                if (path === prefix) {
                    throw storeError('Used mailbox name is a namespace value', 'CANNOT');
                }
                namespace = key;
            } else if (!namespace && !key && this.storage[key].type === 'personal') {
                namespace = key;
            }
        });

        const storage = this.storage[namespace];
        if (!storage) {
            throw storeError('Unknown namespace', 'CANNOT');
        }
        if (storage.type !== 'personal') {
            throw storeError('Permission denied', 'NOPERM');
        }
        return { namespace, storage };
    }

    /**
     * Removes a trailing hierarchy separator from a mailbox name, "foo/" names the mailbox "foo"
     *
     * @param {String} path Mailbox path
     * @param {String} separator Hierarchy separator
     * @return {String} path without the separator at the end
     */
    stripSeparator(path: string, separator: string): string {
        return path.substr(-separator.length) === separator ? path.substr(0, path.length - separator.length) : path;
    }

    /**
     * Checks if the personal namespace is below INBOX (e.g. "INBOX."), then the mailboxes of that namespace are
     * the children of INBOX
     *
     * @return {Boolean} true if the reference namespace is INBOX followed by the separator
     */
    inboxHoldsNamespace(): boolean {
        const reference = this.referenceNamespace;
        if (reference === false) {
            return false;
        }
        const namespace = this.storage[reference];
        return !!namespace && reference.substr(0, reference.length - namespace.separator.length).toUpperCase() === 'INBOX';
    }

    /**
     * Rebuilds folderCache and the path, namespace and flags of every mailbox from storage.
     * INBOX has its own namespace
     *
     * @param {Boolean} [processMessages] If true, messages are prepared as well. Only needed for
     *   messages from the initial storage, as message handlers must not run twice for a message
     */
    indexFolders(processMessages?: boolean): void {
        const folders: Record<string, Mailbox> = Object.create(null);

        const walkTree = (path: string, separator: string, branch: Record<string, StorageMailbox>, namespace: string) => {
            Object.keys(branch).forEach(key => {
                const curBranch = branch[key];
                const curPath = (path ? path + (path.substr(-1) !== separator ? separator : '') : '') + key;

                this.processMailbox(curPath, curBranch, namespace);
                folders[curPath] = curBranch;
                if (processMessages) {
                    this.processMessages(curBranch);
                }

                if (curBranch.folders && Object.keys(curBranch.folders).length) {
                    walkTree(curPath, separator, curBranch.folders, namespace);
                }
            });
        };

        // Ensure INBOX namespace always exists, processMailbox() below makes it a mailbox
        if (!this.storage.INBOX) {
            this.storage.INBOX = {} as Mailbox;
        }

        Object.keys(this.storage).forEach(key => {
            if (key !== 'INBOX') {
                this.storage[key].folders = this.storage[key].folders || {};
                // "INBOX." uses "." as the separator, but "#news" does not use "s"
                this.storage[key].separator = this.storage[key].separator || (/[^a-z0-9]$/i.test(key) ? key.substr(-1) : '/');
                this.storage[key].type = this.storage[key].type || 'personal';

                if (this.storage[key].type === 'personal' && this.referenceNamespace === false) {
                    this.referenceNamespace = key;
                }

                walkTree(key, this.storage[key].separator, this.storage[key].folders, key);
            }
        });

        if (!this.referenceNamespace) {
            // the keys are set below
            this.storage[''] = this.storage[''] || ({} as Namespace);
            this.storage[''].folders = this.storage[''].folders || {};
            this.storage[''].separator = this.storage[''].separator || '/';
            this.storage[''].type = 'personal';
            this.referenceNamespace = '';
        }

        // referenceNamespace is set by now
        if (!this.storage.INBOX.separator) {
            this.storage.INBOX.separator = this.storage[this.referenceNamespace].separator;
        }

        // INBOX is its own namespace, but its subfolders belong to the personal namespace
        folders.INBOX = this.storage.INBOX;
        this.processMailbox('INBOX', this.storage.INBOX, 'INBOX');
        if (processMessages) {
            this.processMessages(this.storage.INBOX);
        }
        if (this.storage.INBOX.folders && Object.keys(this.storage.INBOX.folders).length) {
            walkTree('INBOX', this.storage.INBOX.separator as string, this.storage.INBOX.folders, this.referenceNamespace);
        }

        if (this.inboxHoldsNamespace()) {
            this.setChildrenFlags(this.storage.INBOX, Object.keys(this.storage[this.referenceNamespace].folders || {}).length > 0);
        }

        this.folderCache = folders;
    }

    /**
     * Ensures uid, flags and internaldate for every message of a mailbox and
     * keeps the message list ordered by UID
     *
     * @param {Object} mailbox Mailbox object
     */
    processMessages(mailbox: Mailbox): void {
        const seen = new Set<number>();
        // messages from storage, before they are processed
        const messages = mailbox.messages as (StorageMessage | string)[];

        messages.forEach((entry, i) => {
            // If the input was a raw message, convert it to an object
            const message: StorageMessage =
                typeof entry === 'string'
                    ? (messages[i] = {
                          raw: entry
                      })
                    : entry;

            this.processMessage(message, mailbox);

            if (seen.has(message.uid)) {
                throw new Error('Duplicate UID ' + message.uid + ' in mailbox ' + mailbox.path);
            }
            seen.add(message.uid);
        });

        mailbox.messages.sort((a, b) => a.uid - b.uid);
    }

    /**
     * Sets the path, namespace, flags and counters of a mailbox from storage or a new one, and runs the
     * mailbox handlers of plugins on it
     *
     * @param path Mailbox path
     * @param mailbox Mailbox object, completed in place
     * @param namespace Namespace key of the mailbox
     */
    processMailbox(path: string, mailbox: StorageMailbox, namespace: string): asserts mailbox is Mailbox {
        mailbox.path = path;

        mailbox.namespace = namespace;
        mailbox.uid = mailbox.uid || 1;
        mailbox.uidvalidity = mailbox.uidvalidity || 1;
        this.uidvalidityCounter = Math.max(this.uidvalidityCounter, mailbox.uidvalidity);
        // mailbox attributes are case-insensitive (RFC 3501 section 9, note 1), storage may spell them in any case,
        // the checks and responses use the RFC spelling
        mailbox.flags = ([] as string[]).concat(mailbox.flags || []).map(flag => MAILBOX_ATTRIBUTES.get(String(flag).toLowerCase()) || flag);
        mailbox.allowPermanentFlags = 'allowPermanentFlags' in mailbox ? mailbox.allowPermanentFlags : true;
        mailbox.permanentFlags = ([] as string[]).concat(mailbox.permanentFlags || this.systemFlags);

        // a mailbox from storage is subscribed unless it says otherwise
        this.trackSubscription(mailbox, true);

        // ensure message array
        const messages = ([] as (StorageMessage | string)[]).concat(mailbox.messages || []);
        mailbox.messages = messages;

        // ensure highest uidnext
        mailbox.uidnext = Math.max(
            ...[mailbox.uidnext || 1].concat(
                messages.map(message => {
                    // a raw message (string) has no UID yet
                    return ((typeof message === 'string' ? 0 : message.uid) || 0) + 1;
                })
            )
        );

        const processed = mailbox as Mailbox;
        this.setChildrenFlags(processed, Object.keys(processed.folders || {}).length > 0);

        // Allow plugins to process mailboxes
        this.mailboxHandlers.forEach(handler => {
            handler(this, processed);
        });
    }

    /**
     * Makes `mailbox.subscribed` read and change the subscription of the mailbox name in
     * `server.subscriptions`, so that the subscription stays with the name when the mailbox is deleted
     * or renamed (RFC 3501 section 6.3.6, RFC 9051 section 6.3.6). A `subscribed` value the mailbox
     * already has (from storage) is moved over to the subscription list.
     *
     * @param {Object} mailbox Mailbox object, its `path` is read whenever the subscription is used
     * @param {Boolean} [defaultValue] Subscription of a mailbox without a `subscribed` value. If not
     *   set, the subscription list is left as it is
     */
    trackSubscription(mailbox: StorageMailbox, defaultValue?: boolean): void {
        const descriptor = Object.getOwnPropertyDescriptor(mailbox, 'subscribed');
        if (descriptor && descriptor.get) {
            return;
        }
        const value = descriptor ? !!descriptor.value : defaultValue;
        Object.defineProperty(mailbox, 'subscribed', {
            enumerable: true,
            configurable: true,
            get: () => this.subscriptions.has(mailbox.path),
            set: (subscribed: boolean) => {
                if (subscribed) {
                    this.subscriptions.add(mailbox.path);
                } else {
                    this.subscriptions.delete(mailbox.path);
                }
            }
        });
        if (typeof value === 'boolean') {
            mailbox.subscribed = value;
        }
    }

    /**
     * Sets the stored children attribute of a mailbox (RFC 3348 section 3). A \Noinferiors mailbox gets
     * neither, \Noinferiors already implies \HasNoChildren (RFC 5258 section 3.4)
     *
     * @param {Object} mailbox Mailbox object
     * @param {Boolean} hasChildren true if the mailbox has child mailboxes
     */
    setChildrenFlags(mailbox: Mailbox, hasChildren: boolean): void {
        this.removeFlag(mailbox.flags, '\\HasChildren');
        this.removeFlag(mailbox.flags, '\\HasNoChildren');
        if (mailbox.flags.indexOf('\\Noinferiors') < 0) {
            mailbox.flags.push(hasChildren ? '\\HasChildren' : '\\HasNoChildren');
        }
    }

    /**
     * Ensures that a list of flags includes selected flag
     *
     * @param {Array} flags An array of flags to check
     * @param {String} flag If the flag is missing, add it
     */
    ensureFlag(flags: string[], flag: string): void {
        if (flags.indexOf(flag) < 0) {
            flags.push(flag);
        }
    }

    /**
     * Removes a flag from a list of flags
     *
     * @param {Array} flags An array of flags to check
     * @param {String} flag If the flag is in the list, remove it
     */
    removeFlag(flags: string[], flag: string): void {
        let i;
        if (flags.indexOf(flag) >= 0) {
            for (i = flags.length - 1; i >= 0; i--) {
                if (flags[i] === flag) {
                    flags.splice(i, 1);
                }
            }
        }
    }

    /**
     * Remembers the flags of a message as flags of the mailbox. A keyword stays in the FLAGS and
     * PERMANENTFLAGS of the mailbox after the last message with it is expunged or loses it, like a
     * keyword a client defined (RFC 3501 section 2.3.2, FLAGS lists the flags applicable for the
     * mailbox, section 7.2.6)
     *
     * @param {Object} mailbox Mailbox object
     * @param {Array} flags Flags of a message
     */
    rememberFlags(mailbox: Mailbox, flags: string[]): void {
        const knownFlags = (mailbox.knownFlags = mailbox.knownFlags || []);
        flags.forEach(flag => this.ensureFlag(knownFlags, flag));
    }

    /**
     * Checks if a flag can be stored on messages of a mailbox: any flag when the mailbox allows new keywords
     * (PERMANENTFLAGS has `\*`), otherwise only a flag in the PERMANENTFLAGS list that getStatus() builds, the
     * `permanentFlags` of the mailbox and every flag its messages had. RFC 3501 section 7.1 (RFC 9051 section 7.1):
     * PERMANENTFLAGS "indicates which of the known flags the client can change permanently", STORE ignores the others
     *
     * @param {Object} mailbox Mailbox object
     * @param {String} flag Normalized flag
     * @return {Boolean} true if the flag is a permanent flag of the mailbox
     */
    isPermanentFlag(mailbox: Mailbox, flag: string): boolean {
        // the lists of permanentFlagList(), without building it: this runs for every flag STORE and APPEND set
        return (
            mailbox.allowPermanentFlags || (mailbox.permanentFlags || []).indexOf(flag) >= 0 || (!!mailbox.knownFlags && mailbox.knownFlags.indexOf(flag) >= 0)
        );
    }

    /**
     * The flags of the PERMANENTFLAGS list (without `\*`): the `permanentFlags` of the mailbox and every flag its
     * messages have or had (`knownFlags`, see rememberFlags)
     *
     * @param {Object} mailbox Mailbox object
     * @return {Array} flags, a new list
     */
    permanentFlagList(mailbox: Mailbox): string[] {
        const list = ([] as string[]).concat(mailbox.permanentFlags || []);
        (mailbox.knownFlags || []).forEach(flag => this.ensureFlag(list, flag));
        return list;
    }

    /**
     * The current time for dates the server sets itself (INTERNALDATE of a message without one, SAVEDATE). The `now`
     * option fixes it for repeatable tests: a Date, a timestamp, or a function that returns one
     *
     * @return {Date} current time
     */
    now(): Date {
        const now = this.options.now;
        const value = typeof now === 'function' ? now() : now;
        return value === undefined || value === null ? new Date() : new Date(value);
    }

    /**
     * Converts a date-time value from storage or a client to the form it is sent in
     *
     * @param {Date|String} value Date object or date-time string
     * @return {String|*} date-time string, other values are returned as they are
     */
    normalizeDateTime(value: string | Date): string;
    normalizeDateTime(value: unknown): unknown;
    normalizeDateTime(value: unknown): unknown {
        if (value instanceof Date) {
            return this.formatInternalDate(value);
        }
        if (typeof value === 'string') {
            // month names are accepted in any case but always sent as "Jan", "Feb", ...
            return value.replace(/-([a-z]{3})-/i, (m, month: string) => '-' + (MONTHS[monthIndex(month)] || month) + '-');
        }
        return value;
    }

    /**
     * Sets the UID, flags, internal date and source of a message from storage or a new one, and runs the
     * message handlers of plugins on it
     *
     * @param message Message object, completed in place
     * @param mailbox Mailbox of the message
     */
    processMessage(message: StorageMessage, mailbox: Mailbox): asserts message is Message {
        message.internaldate = this.normalizeDateTime(message.internaldate || this.now());
        message.flags = ([] as string[]).concat(message.flags || []);
        if (message.flags.indexOf('\\Recent') >= 0) {
            // \Recent is not a stored flag, it belongs to the first session that selects the mailbox
            this.removeFlag(message.flags, '\\Recent');
            message.recent = true;
        }
        this.rememberFlags(mailbox, message.flags);
        message.uid = message.uid || mailbox.uidnext++;
        if (message.uid >= mailbox.uidnext) {
            mailbox.uidnext = message.uid + 1;
        }

        // message source is kept as a binary string (one character per octet)
        if (message.raw instanceof Uint8Array) {
            message.raw = Buffer.from(message.raw).toString('binary');
        } else if (typeof message.raw !== 'string') {
            message.raw = message.raw ? String(message.raw) : '';
        }
        if (/[\u0100-\uffff]/.test(message.raw)) {
            // characters outside Latin-1 can only come from a unicode string, so encode it as UTF-8
            message.raw = Buffer.from(message.raw, 'utf-8').toString('binary');
        }

        // Allow plugins to process messages
        const processed = message as Message;
        this.messageHandlers.forEach(handler => {
            handler(this, processed, mailbox);
        });
    }

    /**
     * Appends a message to a mailbox
     *
     * @param {Object|String} mailbox Mailbox to append to
     * @param {Array} flags Flags for the message
     * @param {String|Date} internaldate Receive date-time for the message
     * @param {String} raw Message source
     * @param {Object} [ignoreConnection] To not advertise new message to selected connection
     * @param {Object} [properties] More properties of the new message, set before message handlers run
     * @return An object of the form { mailbox, message }
     */
    appendMessage(
        path: Mailbox | string,
        flags: string[],
        internaldate: string | Date | false | null | undefined,
        raw: string,
        ignoreConnection?: IMAPConnection | false | null,
        properties?: Record<string, any>
    ): { mailbox: Mailbox; message: Message } {
        const mailbox = typeof path === 'string' ? (this.getMailbox(path) as Mailbox) : path;

        // processMessage() below sets the UID. Flags the mailbox can not store are left out (APPEND, COPY: the flags
        // SHOULD be set, RFC 3501 sections 6.3.11 and 6.4.7), as STORE ignores them (RFC 3501 section 7.1, PERMANENTFLAGS)
        const message = Object.assign({}, properties, {
            flags: flags.filter(flag => this.isPermanentFlag(mailbox, flag)),
            internaldate: internaldate,
            raw: raw,
            recent: true
        }) as Message;

        mailbox.messages.push(message);
        this.processMessage(message, mailbox);

        // a session that has the mailbox selected read-write sees the new message as \Recent
        for (const connection of this.connections) {
            if (connection.selectedMailbox === mailbox && !connection.readOnly && connection.recent) {
                connection.recent.add(message);
                delete message.recent;
                break;
            }
        }

        // like expunge, before the sessions are told: APPEND, COPY, MOVE, REPLACE, SMTP and the control API all add here
        this.emit('append', mailbox, [message], this.activeConnection);

        this.notify(
            {
                tag: '*',
                attributes: [
                    mailbox.messages.length,
                    {
                        type: 'ATOM',
                        value: 'EXISTS'
                    }
                ],
                // the new message, for plugins that report more about it (e.g. NOTIFY)
                message: message
            },
            mailbox,
            ignoreConnection
        );

        return { mailbox: mailbox, message: message };
    }

    /**
     * Copies a message to a mailbox (COPY, MOVE, RENAME INBOX). The copy is a new message that
     * keeps the flags, internal date and content of the source. `copyHandlers` can carry over more
     * properties of the source, they run before the message handlers see the copy
     *
     * @param {Object} mailbox Target mailbox
     * @param {Object} source Message to copy
     * @return An object of the form { mailbox, message }
     */
    copyMessage(mailbox: Mailbox, source: Message): { mailbox: Mailbox; message: Message } {
        const properties: Record<string, any> = {};
        this.copyHandlers.forEach(handler => {
            handler(this, source, properties, mailbox);
        });
        return this.appendMessage(mailbox, ([] as string[]).concat(source.flags || []), source.internaldate, source.raw, false, properties);
    }

    /**
     * Returns the namespace a mailbox path belongs to by its prefix, INBOX not included
     *
     * @param {String} path Mailbox path, it does not have to exist
     * @return {String|Boolean} the longest matching namespace key, or false
     */
    getNamespace(path: string): string | false {
        let namespace: string | false = false;
        Object.keys(this.storage).forEach(key => {
            if (key !== 'INBOX' && path.substr(0, key.length) === key && (namespace === false || key.length > namespace.length)) {
                namespace = key;
            }
        });
        return namespace;
    }

    /**
     * Checks if messages can be added to a mailbox (APPEND, COPY, MOVE). TRYCREATE tells the client that CREATE would
     * help (RFC 3501 sections 6.3.11 and 6.4.7), also for a \\Noselect name, which CREATE turns into a mailbox (RFC 9051
     * sections 6.3.12 and 6.4.7: unless it is certain that the target can not be created)
     *
     * @param {String} path Storage name of the target mailbox
     * @return {Object|Boolean} `{ command, code, text }` of the refusal, or false if the mailbox can take messages
     */
    targetRefusal(path: string): Refusal | false {
        const mailbox = this.getMailbox(path);
        if (!mailbox) {
            return { command: 'NO', code: 'TRYCREATE', text: 'Target mailbox does not exist' };
        }
        if (mailbox.flags.indexOf('\\Noselect') >= 0) {
            return { command: 'NO', code: 'TRYCREATE', text: 'Target mailbox is not selectable' };
        }
        return false;
    }

    /**
     * Returns the namespace of a mailbox name: "INBOX" for INBOX, the namespace of the mailbox if it
     * exists (the children of INBOX belong to the personal namespace), otherwise the one of its prefix
     *
     * @param {String|Object} path Mailbox path, it does not have to exist, or a mailbox object
     * @return {String|Boolean} namespace key, or false if the name is in no namespace
     */
    getMailboxNamespace(path: string | { namespace: string | false }): string | false {
        if (path && typeof path === 'object') {
            return path.namespace;
        }
        if (path.toUpperCase() === 'INBOX') {
            return 'INBOX';
        }
        const mailbox = this.getMailbox(path);
        return mailbox ? mailbox.namespace : this.getNamespace(path);
    }

    /**
     * Checks if a mailbox name is in a personal namespace, INBOX included
     *
     * @param {String|Object} path Mailbox path, it does not have to exist, or a mailbox object
     * @return {Boolean} true for a personal mailbox
     */
    isPersonal(path: string | { namespace: string | false }): boolean {
        const key = this.getMailboxNamespace(path);
        return key === 'INBOX' || (key !== false && !!this.storage[key] && this.storage[key].type === 'personal');
    }

    /**
     * Returns the hierarchy separator of a mailbox name, from its namespace
     *
     * @param {String|Object} path Mailbox path, it does not have to exist, or a mailbox object
     * @return {String} separator
     */
    getSeparator(path: string | { namespace: string | false }): string {
        const key = this.getMailboxNamespace(path);
        const namespace = key === false ? undefined : this.storage[key];
        return (namespace && namespace.separator) || this.storage.INBOX.separator || '/';
    }

    /**
     * Returns the name one hierarchy level up from a mailbox name. A trailing separator is ignored, the
     * prefix of a namespace (e.g. "#shared" of "#shared/") is not a mailbox name
     *
     * @param {String} path Mailbox path, it does not have to exist
     * @return {String|Boolean} parent name, "INBOX" for the children of INBOX, or false at the top level
     */
    getParentPath(path: string): string | false {
        const separator = this.getSeparator(path);
        path = this.stripSeparator(path, separator);
        const index = path.lastIndexOf(separator);
        if (index <= 0) {
            return false;
        }
        const parent = path.substr(0, index);
        if (parent.toUpperCase() === 'INBOX') {
            return 'INBOX';
        }
        return this.storage[parent + separator] ? false : parent;
    }

    /**
     * Returns the mailboxes below a mailbox name, at any depth
     *
     * @param {String} path Mailbox path
     * @param {Object} [folders] Mailboxes to choose from by path, defaults to all mailboxes (folderCache)
     * @return {Array} mailbox objects
     */
    getDescendants(path: string): Mailbox[];
    getDescendants<T extends ListedMailbox>(path: string, folders: Record<string, T> | null | undefined): T[];
    getDescendants(path: string, folders?: Record<string, ListedMailbox> | null): ListedMailbox[] {
        const source = folders || this.folderCache;
        const prefix = path + this.getSeparator(path);
        return Object.keys(source)
            .filter(key => key.substr(0, prefix.length) === prefix)
            .map(key => source[key]);
    }

    /**
     * Checks if any mailbox below a mailbox name passes a test, stops at the first one that does
     *
     * @param {String} path Mailbox path
     * @param {Function} predicate `(mailbox)` returns true for a match
     * @return {Boolean} true if a mailbox below the name matches
     */
    hasDescendant(path: string, predicate: (mailbox: Mailbox) => unknown): boolean {
        const prefix = path + this.getSeparator(path);
        for (const key of Object.keys(this.folderCache)) {
            if (key.substr(0, prefix.length) === prefix && predicate(this.folderCache[key])) {
                return true;
            }
        }
        return false;
    }

    /**
     * Returns the mailbox attributes of a LIST response with computed children attributes (RFC 3348, RFC 5258
     * section 4), for extended and unsolicited LIST responses. The stored \HasChildren and \HasNoChildren are
     * replaced, a name that does not exist is \NonExistent (RFC 5258 section 3, it implies \Noselect)
     *
     * @param {Object} [mailbox] Mailbox object, can be left out for a name that does not exist
     * @param {Object} options `{ exists, subscribed, hasChildren, extra }`: false `exists` lists the name as
     *   \NonExistent, `subscribed` adds \Subscribed, `extra` lists more attributes (e.g. \NoAccess)
     * @return {Array} attribute names
     */
    listAttributes(
        mailbox: { flags?: string[] | undefined } | null | undefined,
        options: {
            exists?: boolean | undefined;
            subscribed?: boolean | undefined;
            hasChildren?: boolean | undefined;
            extra?: string[] | undefined;
        }
    ): string[] {
        const exists = options.exists !== false;
        const flags = ((mailbox && mailbox.flags) || []).filter(
            flag => flag !== '\\HasChildren' && flag !== '\\HasNoChildren' && (exists || flag !== '\\Noselect')
        );
        if (!exists) {
            flags.push('\\NonExistent');
        }
        if (options.subscribed) {
            flags.push('\\Subscribed');
        }
        flags.push(...(options.extra || []));
        // \Noinferiors implies \HasNoChildren (RFC 5258 section 3.4 and section 4 example 3)
        if (flags.indexOf('\\Noinferiors') < 0) {
            flags.push(options.hasChildren ? '\\HasChildren' : '\\HasNoChildren');
        }
        return flags;
    }

    /**
     * Lists the mailboxes that match a LIST or LSUB reference and pattern (RFC 3501 section 6.3.8)
     *
     * @param {String} reference Reference name
     * @param {String} match Mailbox name with possible wildcards
     * @param {Function} [exportName] Converts storage names to the form the client uses, so that the
     *   wildcards match whole characters, see IMAPConnection#exportMailboxName
     * @param {Object} [folders] Mailboxes to choose from by path, defaults to all mailboxes (folderCache)
     * @return {Array} Matching mailbox objects
     */
    matchFolders(reference: string | null | undefined, match: string, exportName?: ((name: string) => string) | null): Mailbox[];
    matchFolders<T extends ListedMailbox>(
        reference: string | null | undefined,
        match: string,
        exportName: ((name: string) => string) | null | undefined,
        folders: Record<string, T> | null | undefined
    ): T[];
    matchFolders(
        referenceName: string | null | undefined,
        match: string,
        exportName?: ((name: string) => string) | null,
        folders?: Record<string, ListedMailbox> | null
    ): ListedMailbox[] {
        const source = folders || this.folderCache;
        const toName = exportName || ((name: string) => name);

        // RFC 3501 section 6.3.8 (RFC 9051 section 6.3.9): "An empty ("" string) reference name argument
        // indicates that the mailbox name is interpreted as by SELECT", and without break out characters
        // "the canonical form is normally the reference name appended with the mailbox name". The pattern
        // matches full mailbox names, also in a personal namespace with a prefix such as "INBOX.". With the
        // namespace convention "#" is a break out character "and must be treated as such" (RFC 3501 section 6.3.8,
        // RFC 9051 section 6.3.9): a pattern that starts with it is a name of its own, the reference is ignored
        const lookup = match.charAt(0) === '#' ? match : (referenceName || '') + match;

        // "%" does not match the hierarchy delimiter, which is the one of the namespace a name belongs to
        const toRegExp = (separator: string, flags = '') =>
            new RegExp(
                '^' +
                    lookup
                        // escape regex symbols
                        .replace(/([\\^$+?!.():=[\]{}|,-])/g, '\\$1')
                        .replace(/[*]/g, '.*')
                        .replace(/[%]/g, '[^' + separator.replace(/([\\^$+*?!.():=[\]{}|,-])/g, '\\$1') + ']*') +
                    '$',
                flags
            );

        // RFC 3501 section 6.3.8 allows to "hide" otherwise accessible mailboxes from the wildcards: the
        // mailboxes of namespaces other than the personal one are only matched when the pattern names
        // the prefix of the namespace before any wildcard (LIST "" "user.%", LIST "#news." "*"). The pattern
        // of every namespace that is matched, null for a hidden one
        const fixedPrefix = lookup.replace(/[*%].*$/, '');
        const queries = new Map<string, RegExp | null>();
        Object.keys(this.storage).forEach(key => {
            const name = toName(key);
            const visible = key === this.referenceNamespace || fixedPrefix.substr(0, name.length) === name;
            queries.set(key, visible ? toRegExp(this.storage[key].separator) : null);
        });

        const result: ListedMailbox[] = [];

        // "The special name INBOX is included in the output from LIST, if [...] the uppercase string "INBOX"
        // matches the interpreted reference and mailbox name arguments", INBOX is case-insensitive
        if (source.INBOX && toRegExp((this.storage.INBOX && this.storage.INBOX.separator) || '/', 'i').test('INBOX')) {
            result.push(source.INBOX);
        }

        Object.keys(source).forEach(path => {
            const folder = source[path];
            const query = path !== 'INBOX' && folder.namespace !== false && folder.namespace !== 'INBOX' ? queries.get(folder.namespace) : null;
            if (!query) {
                return;
            }
            const name = toName(path);
            if (query.test(name) && (folder.flags.indexOf('\\NonExistent') < 0 || name === lookup)) {
                result.push(folder);
            }
        });

        return result;
    }

    /**
     * Returns the subscribed names with their superior hierarchy levels, for LSUB and LIST (SUBSCRIBED).
     * Names that are not mailboxes get a stand-in object with \Noselect, which LIST-EXTENDED reports as
     * \NonExistent (RFC 5258 section 3), and `subscribed` false for a level that is only listed because
     * of a subscribed name below it
     *
     * @return {Object} path to mailbox object or stand-in, usable as the `folders` of matchFolders
     */
    getSubscriptionTree(): Record<string, Mailbox | SubscriptionStandIn> {
        const tree: Record<string, Mailbox | SubscriptionStandIn> = Object.create(null);
        const add = (path: string, subscribed: boolean) => {
            tree[path] = tree[path] || this.getMailbox(path) || { path, namespace: this.getNamespace(path), flags: ['\\Noselect'], subscribed };
        };
        const names = [...this.subscriptions].filter(path => path === 'INBOX' || this.getNamespace(path) !== false);
        names.forEach(path => add(path, true));
        names.forEach(path => {
            // superior levels of the name within its namespace
            for (let parent = this.getParentPath(path); parent; parent = this.getParentPath(parent)) {
                add(parent, false);
            }
        });
        return tree;
    }

    /**
     * Retrieves an array of messages that fit in the specified range criteria
     *
     * @param {Object|String} mailbox Mailbox to look for the messages
     * @param {String} range Message range (eg. "*:4,5,7:9")
     * @param {Boolean} isUid If true, use UID values, not sequence indexes for comparison
     * @return {Array} An array of messages in the form of [[seqIndex, message]]
     */
    getMessageRange(source: Mailbox | Message[] | string, sequence: string | number | null | undefined, isUid: boolean): MessageRange {
        const range = (sequence || '').toString();
        const mailbox = typeof source === 'string' ? (this.getMailbox(source) as Mailbox) : source;

        // sequence-set from RFC 3501 and RFC 9051 section 9, numbers are nz-number values (32-bit), UIDs too
        if (!isSequenceSet(range)) {
            const err: IMAPError = new Error('Invalid sequence set');
            err.imapResponse = 'BAD';
            throw err;
        }

        const result: MessageRange = [];
        const rangeParts = range.split(',');
        const messages = Array.isArray(mailbox) ? mailbox : mailbox.messages;
        let uid;
        const totalMessages = messages.length;
        let maxUid = 0;
        const inRange = function (nr: number, ranges: string[], total: number) {
            for (let i = 0, len = ranges.length; i < len; i++) {
                const to = ranges[i].split(':');
                const first = to.shift();
                const from = Number(first === '*' ? total : first) || 1;
                const last = to.pop() || from;
                const end = Number((last === '*' && total) || last) || from;

                if (nr >= Math.min(from, end) && nr <= Math.max(from, end)) {
                    return true;
                }
            }
            return false;
        };

        messages.forEach(message => {
            if (message.uid > maxUid) {
                maxUid = message.uid;
            }
        });

        for (let i = 0, len = messages.length; i < len; i++) {
            uid = messages[i].uid || 1;
            if (inRange(isUid ? uid : i + 1, rangeParts, isUid ? maxUid : totalMessages)) {
                result.push([i + 1, messages[i]]);
            }
        }

        return result;
    }
}

/** A queued client command */
interface QueuedCommand {
    parsed: ParsedCommand;
    data: string;
    /** a command line that a script rule handles instead of the parser and the command handler */
    script?: { rule: ScriptRule; context: ScriptContext } | undefined;
    /** handler for a command that has no registered one (AUTHENTICATE with an unknown mechanism) */
    handler?: CommandHandler | undefined;
}

class IMAPConnection {
    // plugins keep their own per-session state on the connection (enabled, condstore, searchContexts ...)
    [key: string]: any;

    declare server: IMAPServer;
    declare socket: net.Socket | null;
    declare options: IMAPServerOptions;
    declare state: ConnectionState;
    /** the authenticated user, set by LOGIN and the AUTHENTICATE plugins */
    declare username: string | false | undefined;
    declare selectedMailbox: Mailbox | false | undefined;
    declare readOnly: boolean | undefined;
    /** messages that are \Recent in this session, while a mailbox is selected */
    declare recent: Set<Message> | null | undefined;
    declare everSelected: boolean | undefined;
    declare secureConnection: boolean;
    declare upgrading: boolean | undefined;
    /** takes over raw input lines from the command parser (IDLE, AUTHENTICATE) */
    declare inputHandler: ((line: string) => void) | false;
    declare transport: Transport | null;
    declare parserOptions: ParserOptions;
    declare compilerOptions: CompilerOptions;
    declare messageGlobal: boolean;
    /** notifications are sent right away instead of before the next tagged response (IDLE) */
    declare directNotifications: boolean;
    declare notificationQueue: Notification[];
    /** the plain socket that STARTTLS wrapped in TLS */
    declare tcpSocket: net.Socket | null | undefined;
    /** the number of the connection, 1 for the first one the server accepted (script rules match it) */
    declare sessionNumber: number;
    /** the tag and name of the command whose input handler reads the lines that follow (IDLE, AUTHENTICATE) */
    declare inputCommand: { tag: string; command: string } | null | undefined;

    declare _remainder: string;
    declare _command: string;
    declare _literalRemaining: number;
    declare _commandQueue: QueuedCommand[];
    declare _processing: boolean;
    declare _runningCommand: QueuedCommand | null | undefined;
    declare _notificationCallback: (event: NotifyEvent) => void;
    declare _closing: boolean | undefined;
    declare _readCount: number | undefined;
    declare _unsafeCompletedRead: number | undefined;
    declare _discardLine: string | false | undefined;
    declare _skipCommand: boolean | undefined;
    declare _earlyLiteral: boolean | undefined;
    declare _pipelinedAfter: { command: string; read: number | undefined } | undefined;
    /** output that waits behind a delay of a script rule, null when output is written right away */
    declare _outputQueue: OutputOperation[] | null;
    declare _outputTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate> | null;
    /** a piece of a chunked write with chunkDelay 0 or "tick" waits until it was handed to the system */
    declare _outputWaiting: boolean | undefined;
    /** untagged responses that `defer` rules hold back, see releaseDeferred in src/script.ts */
    declare _deferredOutput: DeferredOutput[] | null;
    /** a script rule closes the connection with a RST, see closeNow */
    declare _resetting: boolean | undefined;
    /** time of the last input or output, and the timer of the quiet events of script rules, see watchQuiet */
    declare _lastActivity: number | undefined;
    declare _quietTimer: ReturnType<typeof setTimeout> | null | undefined;
    /** the command whose tagged response is pending and the session before it ran, see commandCompleted */
    declare _commandStart: CommandStart | null | undefined;

    constructor(server: IMAPServer, socket: net.Socket) {
        this.server = server;
        this.socket = socket;
        this.options = this.server.options;

        this.state = 'Not Authenticated';
        this.sessionNumber = ++this.server.sessionCounter;
        this._outputQueue = null;
        this._outputTimer = null;
        this._deferredOutput = null;

        // a TLS socket is encrypted, and so can be an in-memory connection of server.connect()
        this.secureConnection = !!this.options.secureConnection || (socket as net.Socket & { encrypted?: boolean }).encrypted === true;

        this._remainder = '';
        this._command = '';
        this._literalRemaining = 0;

        this.inputHandler = false;

        // a layer between the socket and the IMAP protocol, such as COMPRESS=DEFLATE (RFC 4978). It has
        // the methods write(buffer), receive(chunk), end(callback) and destroy(), and passes data on with
        // connection.writeRaw() and connection.onData(), so it always sits above TLS (RFC 4978 section 3)
        this.transport = null;

        // per connection options for the imap-handler parser and compiler, plugins can change these. The
        // parser options go on top of server.parserOptions
        this.parserOptions = {};
        this.compilerOptions = {};

        // message/global parts encapsulate a message like message/rfc822 parts in BODYSTRUCTURE and in section
        // numbers. IMAP4rev2 sets it (RFC 9051 sections 6.4.5.1 and 7.5.2), IMAP4rev1 describes them as basic parts
        this.messageGlobal = false;

        this._commandQueue = [];
        this._processing = false;

        if (this.options.debug && typeof this.socket.pipe === 'function') {
            this.socket.pipe(process.stdout);
        }

        this.socket.on('data', this.receive.bind(this));
        this.socket.on('close', this.onClose.bind(this));
        this.socket.on('error', this.onError.bind(this));

        this.directNotifications = false;
        this._notificationCallback = this.onNotify.bind(this);
        this.notificationQueue = [];
        this.server.on('notify', this._notificationCallback);
        this.server.connections.add(this);
        this.emitSession('open');

        this.scriptOutput('greeting', '* OK ImapKit ready for rumble\r\n', {});
    }

    /**
     * Writes protocol output to the client, through the transport layer if there is one
     *
     * @param {Buffer|String} data Data to send, a string is sent as a binary string
     */
    write(data: Buffer | string): void {
        const buffer = typeof data === 'string' ? Buffer.from(data, 'binary') : data;
        if (this._outputQueue) {
            this._outputQueue.push({ data: buffer, transport: this.transport });
        } else {
            this.writeLayer(buffer, this.transport);
        }
    }

    /**
     * Writes output, or puts it in the output queue while earlier output waits for a delay of a script rule.
     * The transport layer is taken when the output is queued, so output from before COMPRESS is not compressed
     *
     * @param {Object} operation `{ data, delay, chunk, chunkDelay, close }`, see OutputOperation in src/script.ts
     */
    queueOutput(operation: OutputOperation): void {
        if (!this._outputQueue && !operation.delay && !operation.chunk) {
            if (operation.data) {
                this.writeLayer(operation.data, this.transport);
            }
            if (operation.close) {
                this.closeNow(operation.close);
            }
            return;
        }
        this._outputQueue = this._outputQueue || [];
        this._outputQueue.push(Object.assign({}, operation, { transport: this.transport }));
        if (!this._outputTimer && !this._outputWaiting) {
            this.flushOutput();
        }
    }

    /**
     * Writes the output queue until it is empty or a delay stops it
     */
    flushOutput(): void {
        const queue = this._outputQueue || [];
        while (queue.length) {
            const operation = queue[0] as OutputOperation;
            if (operation.delay) {
                const delay = operation.delay;
                operation.delay = 0;
                this._outputTimer = setTimeout(() => {
                    this._outputTimer = null;
                    this.flushOutput();
                }, delay);
                return;
            }
            if (operation.data && operation.chunk && operation.data.length > operation.chunk) {
                // the rest waits for chunkDelay, like a delay of its own. Without a delay each piece waits for the next
                // event loop turn, and Nagle's algorithm must not hold it back to merge it with the next one
                const piece = operation.data.subarray(0, operation.chunk);
                operation.data = operation.data.subarray(operation.chunk);
                if (!operation.chunkDelay || operation.chunkDelay === 'tick') {
                    // the next piece waits until this one was handed to the system, and one more event loop turn, so
                    // the pieces leave as separate segments without a wall clock delay (#89)
                    this.socket?.setNoDelay?.(true);
                    this._outputWaiting = true;
                    this.writeLayer(piece, operation.transport || null, () => {
                        if (this._outputWaiting && this._outputQueue === queue) {
                            this._outputTimer = nextTurn(() => {
                                this._outputTimer = null;
                                this._outputWaiting = false;
                                this.flushOutput();
                            });
                        }
                    });
                    return;
                }
                operation.delay = operation.chunkDelay;
                this.writeLayer(piece, operation.transport || null);
                continue;
            }
            if (operation.data) {
                this.writeLayer(operation.data, operation.transport || null);
            }
            queue.shift();
            if (operation.close) {
                this.closeNow(operation.close);
                return;
            }
        }
        this._outputQueue = null;
    }

    /**
     * Drops the output that waits for a delay of a script rule or for its release (`defer`)
     */
    clearOutputQueue(): void {
        if (this._outputTimer) {
            clearTimeout(this._outputTimer as ReturnType<typeof setTimeout>);
            clearImmediate(this._outputTimer as ReturnType<typeof setImmediate>);
            this._outputTimer = null;
        }
        this._outputWaiting = false;
        this._outputQueue = null;
        this._deferredOutput = null;
    }

    /**
     * Writes output through a transport layer, or to the socket
     *
     * @param {Buffer} data Output
     * @param {Object|null} transport Transport layer
     * @param {Function} [callback] Called once the data was handed to the system (a transport: on the next turn)
     */
    writeLayer(data: Buffer, transport: Transport | null, callback?: () => void): void {
        this.trace('out', data);
        if (transport) {
            transport.write(data);
            if (callback) {
                setImmediate(callback);
            }
        } else {
            this.writeRaw(data, callback);
        }
    }

    /**
     * Emits the protocol traffic of the session as `trace` events, as the IMAP layer sees it: above TLS and COMPRESS
     *
     * @param {String} direction "in" for client input, "out" for server output
     * @param {Buffer} data The octets
     */
    trace(direction: 'in' | 'out', data: Buffer): void {
        if (this.server.listenerCount('trace')) {
            this.server.emit('trace', { session: this.sessionNumber, direction, data });
        }
    }

    /**
     * Sends output through the script rule that handles its event, if there is one
     *
     * @param {String} event Event name: greeting, response or continuation
     * @param {String} output The output as a binary string
     * @param {Object} fields Context fields of the event (tag, command, description, response)
     * @param {Function} [compile] Compiles the response that a `mutate` action changed, null drops the output
     */
    scriptOutput(event: ScriptEvent, output: string, fields: Partial<ScriptContext>, compile?: (response: IMAPResponse) => string | null): void {
        const found = this.server.script.check(this, event, Object.assign({}, fields, { data: output }));
        if (!found) {
            this.write(output);
            return;
        }
        const { rule, context } = found;
        if ((rule.mutate || rule.literals) && compile && context.response) {
            let response = context.response;
            if (rule.mutate) {
                // a copy, a notification object is shared by every session
                const copy = cloneResponse(response);
                response = rule.mutate(copy, context) || copy;
            }
            const changed = compile(rule.literals ? literalResponse(response) : response);
            if (changed === null) {
                return;
            }
            context.data = changed;
        }
        sendOutput(this, rule, context, Buffer.from(context.data, 'binary'));
    }

    /**
     * Sends a continuation request, `+ text`
     *
     * @param {String} text Human readable text, can be empty (SASL)
     * @param {String} description Description for script rules
     * @param {Function} [getLine] Returns the command line received so far, for the tag and the command of a literal continuation
     */
    sendContinuation(text: string, description: string, getLine?: () => string): void {
        const output = '+ ' + text + '\r\n';
        if (!this.server.script.watches('continuation')) {
            this.write(output);
            return;
        }
        const line = getLine ? getLine() : null;
        this.scriptOutput('continuation', output, line === null ? { description } : { description, tag: getResponseTag(line), command: getLineCommand(line) });
    }

    /**
     * Writes data to the socket, below the transport layer
     *
     * @param {Buffer} data Data to send
     */
    writeRaw(data: Buffer | string, callback?: () => void): void {
        if (this.socket && !this.socket.destroyed) {
            this.socket.write(data, callback);
            this.touch();
        }
    }

    /**
     * Notes input or output for the quiet events of script rules (#88)
     */
    touch(): void {
        if (!this.server.script.watches('quiet')) {
            // nothing waits for quiet sessions, a rule added later counts from then on
            this._lastActivity = undefined;
            return;
        }
        this._lastActivity = Date.now();
        if (!this._quietTimer) {
            this.watchQuiet();
        }
    }

    /**
     * Starts waiting for the next quiet event, if a rule waits for one and the session is not waiting already. When
     * the time is up, the first rule that matches handles the event (`send`, `close`), the output it sends starts
     * the next quiet time
     *
     * @param {Number} [checked] Quiet time the rules were checked for already, only longer ones are waited for
     */
    watchQuiet(checked = 0): void {
        if (this._quietTimer || !this.socket || this._closing) {
            return;
        }
        const last = this._lastActivity || Date.now();
        this._lastActivity = last;
        // the time is measured from the last activity, a rule whose time is up already fires right away
        const next = this.server.script.nextQuiet(checked);
        if (next === null) {
            return;
        }
        this._quietTimer = setTimeout(
            () => {
                this._quietTimer = null;
                if (!this.isOpen() || this._lastActivity !== last) {
                    // there was activity in between, it started a new wait
                    return this.watchQuiet();
                }
                // a timer can fire a millisecond before Date.now() says the time is up
                const quiet = Math.max(Date.now() - last, next);
                const found = this.server.script.check(this, 'quiet', { data: '', quiet });
                if (found) {
                    handleQuiet(this, found.rule, found.context);
                }
                if (this._lastActivity === last) {
                    // nothing was sent, wait for the rules with a longer quiet time
                    this.watchQuiet(quiet);
                }
            },
            Math.max(0, next - (Date.now() - last))
        );
        // browsers have no unref
        this._quietTimer.unref?.();
    }

    /**
     * Handles data from the socket, through the transport layer if there is one
     *
     * @param {Buffer} chunk Received data
     */
    receive(chunk: Buffer): void {
        this.touch();
        if (this.transport) {
            this.transport.receive(chunk);
        } else {
            this.onData(chunk);
        }
    }

    /**
     * Closes the connection once everything sent so far, including data a transport layer still
     * holds, is written out
     */
    end(): void {
        if (this._outputQueue && this.socket) {
            // output still waits for a delay of a script rule
            this._closing = true;
            this._outputQueue.push({ close: true });
            return;
        }
        this.closeNow(true);
    }

    /**
     * Closes the connection now, after the output written so far
     *
     * @param {Boolean|String} mode true ends the connection gracefully, "reset" destroys the socket (script rules)
     */
    closeNow(mode: boolean | 'reset'): void {
        const socket = this.socket;
        if (!socket) {
            return;
        }
        this._closing = true;
        this.clearOutputQueue();
        if (mode === 'reset') {
            this.discardInput();
            // input that arrives while the reset waits is not processed, also input a transport layer still holds
            this._resetting = true;
            socket.pause();
            // a RST sent in the same tick as the last output can get lost: on macOS the client received the output but
            // never the RST (#81). Node has no signal for output that reached the peer, so the RST waits a little
            const tcpSocket = this.tcpSocket;
            setTimeout(() => {
                if (!socket.destroyed) {
                    resetSocket(socket, tcpSocket);
                }
            }, RESET_DELAY);
        } else if (this.transport) {
            this.transport.end(() => socket.end());
        } else {
            socket.end();
        }
    }

    /**
     * Sends an untagged BYE, drops unprocessed input and closes the connection (RFC 3501 section 7.1.5)
     *
     * @param {String} text Human readable explanation
     * @param {String} [description] Description for output handlers
     */
    bye(text: string, description?: string): void {
        this.sendStatus({ tag: '*' }, null, 'BYE', text, false, description || 'BYE');
        // the selected mailbox is left without expunging, queued notifications are dropped
        this.closeMailbox();
        this.state = 'Logout';
        this.discardInput();
        this.end();
    }

    /**
     * Checks if the client sent anything after the command that is running, that is not processed yet
     *
     * @return {Boolean} true if there is unprocessed input or a queued command
     */
    hasPendingInput(): boolean {
        return !!(this._remainder || this._command || this._literalRemaining || this._commandQueue.length);
    }

    /**
     * Checks if a command is running or waiting, for checks that must not run ahead of earlier commands
     *
     * @return {Boolean} true if a command is running or queued
     */
    isBusy(): boolean {
        return !!(this._processing || this._commandQueue.length);
    }

    /**
     * Checks if a command was sent together with a command that was refused for the noPipelining option (STARTTLS,
     * COMPRESS): it arrived in the same read, before the client could see the refusal
     *
     * @return {Boolean} true if the command must be refused
     */
    isPipelinedAfterRefusal(): boolean {
        return !!this._pipelinedAfter && this._pipelinedAfter.read === this._readCount;
    }

    /**
     * Refuses a command that was pipelined after a refused noPipelining command, without running it
     *
     * @param {Object} parsed Parsed command
     * @param {String} data Raw command
     */
    refusePipelined(parsed: CommandContext, data: string): void {
        this.sendStatus(parsed, data, 'BAD', 'Commands must not be pipelined after ' + this._pipelinedAfter?.command, false, 'INVALID COMMAND');
    }

    /**
     * Drops input that is not processed yet, including queued commands
     */
    discardInput(): void {
        this._commandQueue = [];
        this._remainder = '';
        this._command = '';
        this._literalRemaining = 0;
        this._skipCommand = false;
        this._earlyLiteral = false;
    }

    /**
     * Returns the connection to the Not Authenticated state and resets everything but the TLS
     * layer (RFC 8437 section 3): the selected mailbox is closed without EXPUNGE responses, and the
     * plugins clear their session state (ENABLEd extensions, CONDSTORE, COMPRESS, ...) with
     * server.resetHandlers. Call it after the response that ends the session was sent.
     */
    resetSession(): void {
        this.closeMailbox();
        this.state = 'Not Authenticated';
        this.username = false;
        this.everSelected = false;
        this.directNotifications = false;
        this.server.resetHandlers.forEach(handler => handler(this));
    }

    /**
     * Closes the selected mailbox, if there is one, and returns to the Authenticated state (CLOSE, UNSELECT, a failed
     * SELECT or EXAMINE, RFC 3501 section 6.3.1). The read-only mode, the \Recent set of the session and the
     * notifications that were not sent yet are dropped. Sends nothing, the caller answers the command
     */
    closeMailbox(): void {
        const wasSelected = !!this.selectedMailbox;
        this.state = 'Authenticated';
        this.selectedMailbox = false;
        this.readOnly = false;
        this.recent = null;
        this.notificationQueue = [];
        if (wasSelected) {
            this.emitSession('unselect');
        }
    }

    onClose(): void {
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket = null;
        }
        if (this.transport) {
            this.transport.destroy();
            this.transport = null;
        }
        this.clearOutputQueue();
        if (this._quietTimer) {
            clearTimeout(this._quietTimer);
            this._quietTimer = null;
        }
        this.server.removeListener('notify', this._notificationCallback);
        if (this.server.connections.delete(this)) {
            this.emitSession('close');
        }
    }

    onError(err: Error): void {
        if (this.options.debug) {
            console.log('Socket error event emitted, %s', Date());
            console.log(err.stack);
        }
        try {
            this.socket?.end();
        } catch (E) {
            // socket is already gone
        }
    }

    /**
     * Passes a line to the input handler (IDLE, AUTHENTICATE), unless a script rule handles it
     *
     * @param {String} line Input line without CRLF
     */
    handleInput(line: string): void {
        const inputHandler = this.inputHandler as (line: string) => void;
        const found = this.server.script.check(this, 'input', { data: line });
        if (found) {
            handleLine(this, found.rule, found.context, () => inputHandler(line));
        } else {
            inputHandler(line);
        }
    }

    onData(chunk: Buffer): void {
        let match;
        let str;

        if (this._resetting) {
            return;
        }

        if (chunk && chunk.length) {
            this.trace('in', chunk);
        }

        // everything in one read arrived before anything this read causes to be sent
        this._readCount = (this._readCount || 0) + 1;

        str = (chunk || '').toString('binary');

        if (this._discardLine) {
            // skipping the rest of a command line that was too long
            const lineEnd = str.indexOf('\n');
            if (lineEnd < 0) {
                return;
            }
            // the command was not executed, but its tag still gets an answer
            const tag = this._discardLine;
            this._discardLine = false;
            str = str.substr(lineEnd + 1);
            this.sendBad(tag, 'Command line too long', 'LINE TOO LONG');
        }

        if (this._literalRemaining) {
            str = this.readLiteral(str);
            if (this._literalRemaining) {
                return;
            }
        }

        // non-synchronizing literals are only valid when LITERAL+ or LITERAL- is advertised. A literal8 marker `~{n}`
        // (RFC 3516) is matched always, so it is refused when BINARY is not loaded
        const lineEndRegex = this.server.literalPlus
            ? /(?<marker>(?<tilde>~)?\{(?<size>\d+)(?<plus>\+)?\})?(?<cr>\r?)\n/
            : /(?<marker>(?<tilde>~)?\{(?<size>\d+)\})?(?<cr>\r?)\n/;

        this._remainder = str = this._remainder + str;
        while ((match = lineEndRegex.exec(str))) {
            const { marker, tilde, size, plus, cr } = match.groups as Record<string, string | undefined>;

            if (match.index > MAX_LINE_LENGTH) {
                // the same limit as for a line that arrives in several reads (see the end of this method), so
                // the outcome does not depend on how the input was split into reads (RFC 3501 section 7.1.3)
                const tag = getResponseTag(this._command || str);
                this.sendBad('*', 'Command line too long', 'LINE TOO LONG');
                this.sendBad(tag, 'Command line too long', 'LINE TOO LONG');
                this._remainder = str = str.substr(match.index + match[0].length);
                this._command = '';
                this._skipCommand = false;
                continue;
            }

            if (!cr) {
                // every command line ends with CRLF (RFC 3501 section 9), a bare LF is refused
                const line = this._command + str.substr(0, match.index + match[0].length - 1);
                this._remainder = str = str.substr(match.index + match[0].length);
                this._command = '';
                if (this._skipCommand) {
                    this._skipCommand = false;
                } else {
                    this.sendBad(this.inputHandler ? '*' : getResponseTag(line), 'Lines must end with CRLF', 'INVALID LINE ENDING', line);
                }
                continue;
            }

            if (!size || (this._skipCommand && !plus)) {
                // the command is complete, or it was refused already and the client waits in vain
                // for a continuation request
                const line = this._command + str.substr(0, match.index);
                this._remainder = str.substr(match.index + match[0].length);
                this._command = '';
                if (this._skipCommand) {
                    this._skipCommand = false;
                } else if (this._earlyLiteral) {
                    // the client sent literal data without waiting for the continuation request
                    this._earlyLiteral = false;
                    this.sendBad(getResponseTag(line), 'Literal data must wait for the continuation request', 'LITERAL TOO EARLY', line);
                } else if (this.inputHandler) {
                    this.handleInput(line);
                } else {
                    this.scheduleCommand(line);
                }

                if (this.upgrading) {
                    // STARTTLS was accepted, ignore any pipelined plaintext input
                    return;
                }

                // a handler may have dropped the input that followed with discardInput()
                str = this._remainder;
                continue;
            }

            const literalSize = Number(size);
            if (!this._skipCommand) {
                const line = this._command + str.substr(0, match.index);
                // the literal marker is part of the first word when it directly follows the tag
                const tag = getResponseTag(line + marker);
                const refusal = this.checkLiteral(line, literalSize, !plus, !!tilde);
                if (refusal) {
                    if (plus) {
                        // the client is going to send the literal anyway, so there is no way to recover. A BYE
                        // for a literal that is too large should carry TOOBIG (RFC 7888 section 5)
                        this.sendStatus({ tag: '*' }, line, 'BYE', refusal.text, refusal.text === LITERAL_TOO_LARGE && 'TOOBIG', 'LITERAL REFUSED');
                        this._remainder = this._command = '';
                        this.end();
                        return;
                    }
                    // refuse a synchronizing literal by not sending a continuation request
                    this.sendStatus({ tag }, line, refusal.command, refusal.text, refusal.code || false, 'LITERAL REFUSED');
                    this._remainder = str = str.substr(match.index + match[0].length);
                    this._command = '';
                    continue;
                }
                if (plus && literalSize > this.server.nonSyncLiteralLimit) {
                    // RFC 7888 sections 4 and 5: the command is refused with TOOBIG, the literal and the
                    // rest of the command are read and dropped
                    this.sendStatus(
                        { tag },
                        line,
                        'BAD',
                        'Non-synchronizing literals are limited to ' + this.server.nonSyncLiteralLimit + ' octets',
                        'TOOBIG',
                        'LITERAL TOO BIG'
                    );
                    this._skipCommand = true;
                    this._command = '';
                }
            }

            if (!plus) {
                if (str.length > match.index + match[0].length) {
                    // RFC 3501 section 4.3: the client MUST wait for the continuation request
                    // before sending the octets of a synchronizing literal
                    this._earlyLiteral = true;
                } else if (!this._earlyLiteral) {
                    // the line is needed only by script rules that watch continuations
                    const head = str.substr(0, match.index) + marker;
                    this.sendContinuation('Go ahead', 'LITERAL', () => this._command + head);
                }
            }

            this._remainder = '';
            if (!this._skipCommand) {
                this._command += str.substr(0, match.index + match[0].length);
            }
            this._literalRemaining = literalSize;

            str = this.readLiteral(str.substr(match.index + match[0].length));
            if (this._literalRemaining) {
                return;
            }
            this._remainder = str;
        }

        if (this._remainder.length > MAX_LINE_LENGTH) {
            // RFC 3501 section 7.1.3
            this.sendBad('*', 'Command line too long', 'LINE TOO LONG');
            const tag = getResponseTag(this._command || this._remainder);
            this._remainder = '';
            this._command = '';
            this._skipCommand = false;
            this._discardLine = tag;
        }
    }

    /**
     * Reads literal data that the current command is waiting for. The data of a command that was
     * refused is dropped.
     *
     * @param {String} str Received data
     * @return {String} the data that follows the literal
     */
    readLiteral(str: string): string {
        const length = Math.min(this._literalRemaining, str.length);
        if (!this._skipCommand) {
            this._command += str.substr(0, length);
        }
        this._literalRemaining -= length;
        return str.substr(length);
    }

    /**
     * Sends a BAD response to input that did not make it to a command handler
     *
     * @param {String} tag Tag to answer with, "*" for an untagged response
     * @param {String} text Human readable text
     * @param {String} description Description for output handlers
     * @param {String} [data] Raw input
     */
    sendBad(tag: string, text: string, description: string, data?: string): void {
        this.sendStatus({ tag }, data, 'BAD', text, false, description);
    }

    /**
     * Checks if a literal may be accepted for the command line received so far. Literals are
     * refused before they are read when they are too large, or when the command is unknown or
     * not allowed in the current state, so the client does not get a continuation request for
     * a command that is going to fail anyway.
     *
     * @param {String} line The command received so far (with earlier literals), up to the literal size marker
     * @param {Number} literalSize Size of the literal in octets
     * @param {Boolean} [synchronizing] true if the literal can still be refused without reading it
     * @param {Boolean} [literal8] The literal is a literal8 `~{n}`
     * @return {Object|Boolean} `{ command, code, text }` for the response that refuses the literal, or false.
     *   Responses from `server.literalFilters` have the same form
     */
    checkLiteral(line: string, literalSize: number, synchronizing?: boolean, literal8?: boolean): Refusal | false {
        const refuse = (text: string): Refusal => ({ command: 'BAD', text });
        const maxLiteralSize = this.getMaxLiteralSize();
        if (literalSize > maxLiteralSize || line.length + literalSize > maxLiteralSize + MAX_LINE_LENGTH) {
            return refuse(LITERAL_TOO_LARGE);
        }

        if (this.isPipelinedAfterRefusal()) {
            return refuse('Commands must not be pipelined after ' + this._pipelinedAfter?.command);
        }

        if (this.inputHandler) {
            // not a command, e.g. a SASL response
            return literal8 ? refuse('Literal8 is not allowed here') : false;
        }

        const command = getLineCommand(line);

        if (!COMMAND_REGEX.test(command) || !this.server.getCommandHandler(command)) {
            return refuse('Unknown command');
        }

        const options = this.server.getCommandOptions(command);
        if (options.states && options.states.indexOf(this.state) < 0) {
            return refuse(stateError(command, this.state));
        }

        // RFC 3516 section 7: literal8 is only valid where an extension allows it, like BINARY for the APPEND
        // message or METADATA for entry values (RFC 5464 section 5)
        if (literal8 && !(options.literal8 === true || (options.literal8 && Object.hasOwn(this.server.capabilities, options.literal8)))) {
            return refuse('Literal8 is not allowed in ' + command);
        }

        // plugins can refuse a synchronizing literal, e.g. a message that is too large for APPEND.
        // A non-synchronizing literal is read anyway, the command handler refuses it later
        if (synchronizing) {
            for (const filter of this.server.literalFilters) {
                const refusal = filter(this, command, line, literalSize);
                if (refusal) {
                    return refusal;
                }
            }
        }

        return false;
    }

    /**
     * Returns the largest literal the client may send in its current state. Before
     * authentication only small literals (user names, passwords) make sense.
     *
     * @return {Number} Size in bytes
     */
    getMaxLiteralSize(): number {
        if (this.state === 'Not Authenticated') {
            return MAX_PREAUTH_LITERAL_SIZE;
        }
        return Number(this.options.maxLiteralSize) || MAX_LITERAL_SIZE;
    }

    /**
     * Returns the message list of the selected mailbox as this session currently
     * sees it. When another session has expunged messages that this session has
     * not been told about yet, sequence numbers must still refer to the old list.
     *
     * @return {Array} List of messages
     */
    getSessionMessages(): Message[] {
        for (let i = 0, len = this.notificationQueue.length; i < len; i++) {
            const mailboxCopy = this.notificationQueue[i].mailboxCopy;
            if (mailboxCopy) {
                return mailboxCopy;
            }
        }
        return this.selectedMailbox ? this.selectedMailbox.messages : [];
    }

    /**
     * Resolves the sequence set argument of a command to messages of the selected mailbox, as this
     * session sees it. Plugins can replace it per connection to support other forms of sequence sets
     * (e.g. "$" of SEARCHRES)
     *
     * @param {String} range Sequence set
     * @param {Boolean} isUid If true, the set lists UIDs instead of sequence numbers
     * @return {Array} An array of messages in the form of [[seqIndex, message]]
     */
    getMessageRange(range: string | number | null | undefined, isUid: boolean): MessageRange {
        return this.server.getMessageRange(this.getSessionMessages(), range, isUid);
    }

    /**
     * Lets `server.rangeLimits` cut the messages a command operates on, after its sequence set argument was resolved.
     * A limit that returns the messages from the highest UID down sets `parsed.highestFirst`, then MOVE and UID EXPUNGE
     * send their EXPUNGE responses in that order too
     *
     * @param {Object} parsed Parsed command
     * @param {Array} range Messages of the sequence set, in the form of [[seqIndex, message]]
     * @return {Array} the messages to operate on, in the same form
     */
    limitRange(parsed: ParsedCommand, range: MessageRange): MessageRange {
        return this.server.rangeLimits.reduce((result, limit) => limit(this, parsed, result) || result, range);
    }

    /**
     * Resolves the sequence set argument of a command like getMessageRange, but refuses message sequence
     * numbers past the end of the selected mailbox, as this session sees it. RFC 3501 and RFC 9051 section 9
     * (seq-number): "The server should respond with a tagged BAD response to a command that uses a message
     * sequence number greater than the number of messages in the selected mailbox. This includes "*" if the
     * selected mailbox is empty." For the sequence set argument of FETCH, STORE, COPY and MOVE, SEARCH keys
     * use getMessageRange
     *
     * @param {String} range Sequence set
     * @param {Boolean} isUid If true, the set lists UIDs, these can point past the end
     * @return {Array} An array of messages in the form of [[seqIndex, message]], see getMessageRange
     * @throws {Error} BAD error if a sequence number is out of range
     */
    getCommandRange(range: string | number | null | undefined, isUid: boolean): MessageRange {
        const result = this.getMessageRange(range, isUid);
        if (isUid) {
            return result;
        }
        const total = this.getSessionMessages().length;
        String(range)
            .split(/[,:]/)
            .forEach(value => {
                if (value === '*' ? !total : Number(value) > total) {
                    const err: IMAPError = new Error(
                        total ? 'Message sequence number ' + value + ' is greater than the number of messages (' + total + ')' : 'The mailbox is empty'
                    );
                    err.imapResponse = 'BAD';
                    throw err;
                }
            });
        return result;
    }

    /**
     * Checks if this session has EXPUNGE notifications that it has not been told about yet
     *
     * @return {Boolean} true if an EXPUNGE response is pending
     */
    hasPendingExpunge(): boolean {
        return this.notificationQueue.some(isPendingExpunge);
    }

    /**
     * Tells the other sessions that have the selected mailbox open about changed flags, they get
     * an untagged FETCH with the new flags (RFC 3501 section 5.2)
     *
     * @param {Array} messages Messages with changed flags
     */
    notifyFlagChanges(messages: Message[]): void {
        if (this.selectedMailbox) {
            notifyFlagChanges(this.server, this.selectedMailbox, messages, this);
        }
    }

    /**
     * Sends unsolicited FETCH responses with the flags another session changed. The UID is always
     * included, RFC 9051 section 6.3.13 requires it for unsolicited FETCH responses and it is valid
     * in IMAP4rev1 as well.
     *
     * @param {Array} messages Messages with changed flags
     * @param {Map} sequence Message to the sequence number this session knows it by
     * @param {Set} [reported] Messages already reported, these are skipped and the sent ones are added
     */
    sendFlagUpdate(messages: Message[], sequence: Map<Message, number>, reported?: Set<Message>): void {
        const getFlags = this.server.fetchHandlers.FLAGS || (fetchHandlers as Record<string, FetchHandler>).FLAGS;
        messages.forEach(message => {
            if (!sequence.has(message) || message.ghost) {
                // the message is gone, its EXPUNGE response tells the rest
                return;
            }
            if (reported) {
                if (reported.has(message)) {
                    return;
                }
                reported.add(message);
            }
            this.send(
                {
                    tag: '*',
                    notification: true,
                    attributes: [
                        sequence.get(message),
                        {
                            type: 'ATOM',
                            value: 'FETCH'
                        },
                        [
                            {
                                type: 'ATOM',
                                value: 'UID'
                            },
                            message.uid,
                            {
                                type: 'ATOM',
                                value: 'FLAGS'
                            },
                            getFlags(this, message, { type: 'ATOM', value: 'FLAGS' })
                        ]
                    ]
                },
                'FLAG NOTIFICATION',
                null,
                null,
                message
            );
        });
    }

    /**
     * Checks if a message has the \Recent flag in this session
     *
     * @param {Object} message Message object
     * @return {Boolean} true if the message is recent for this session
     */
    isRecent(message: Message): boolean {
        return !!(this.recent && this.recent.has(message));
    }

    /**
     * Returns the flags of a message as seen by this session, including \Recent
     *
     * @param {Object} message Message object
     * @return {Array} List of flags
     */
    getFlags(message: Message): string[] {
        return this.isRecent(message) ? message.flags.concat('\\Recent') : message.flags;
    }

    /**
     * Checks if FETCH may set the \Seen flag in the selected mailbox (RFC 3501 section 6.4.5).
     * Plugins can override it for a connection, e.g. ACL without the "s" right
     *
     * @return {Boolean} true if \Seen may be set
     */
    canSetSeen(): boolean {
        return !this.readOnly;
    }

    /**
     * The refusal of a command that would change a mailbox selected read-only (EXAMINE, or SELECT answered with
     * [READ-ONLY], RFC 3501 sections 6.3.1 and 6.3.2): STORE, EXPUNGE, UID EXPUNGE, MOVE and REPLACE. RFC 5530 section 3:
     * CLIENTBUG, the client was told that the mailbox is read-only
     *
     * @return {Object|Boolean} `{ command, code, text }` if the selected mailbox is read-only, otherwise false
     */
    readOnlyRefusal(): Refusal | false {
        return this.readOnly ? { command: 'NO', code: 'CLIENTBUG', text: 'Mailbox is read-only' } : false;
    }

    /**
     * Sends the refusal of readOnlyRefusal() if the selected mailbox is read-only
     *
     * @param {Object} parsed Parsed command
     * @param {String} data Raw command
     * @param {String} description Description for output handlers
     * @return {Boolean} true if the command was refused
     */
    refuseReadOnly(parsed: ParsedCommand, data: string, description?: string): boolean {
        const refusal = this.readOnlyRefusal();
        if (refusal) {
            this.sendStatus(parsed, data, refusal.command, refusal.text, refusal.code, description);
        }
        return !!refusal;
    }

    /**
     * Checks if CLOSE may expunge the selected mailbox (RFC 3501 section 6.4.2). Plugins can
     * override it for a connection, e.g. ACL without the "e" right
     *
     * @return {Boolean} true if messages may be expunged
     */
    canExpunge(): boolean {
        return !this.readOnly;
    }

    onNotify(notification: NotifyEvent): void {
        if (
            notification.ignoreConnection === this ||
            (notification.filter && !notification.filter(this)) ||
            !this.server.notifyFilters.every(filter => filter(this, notification))
        ) {
            return;
        }
        const mailbox = typeof notification.mailbox === 'string' ? this.server.getMailbox(notification.mailbox) : notification.mailbox;
        if (!notification.mailbox || (this.selectedMailbox && this.selectedMailbox === mailbox)) {
            let command = notification.command;
            if (command.mailboxCopy && this.notificationQueue.some(queued => queued.mailboxCopy)) {
                // Only the oldest snapshot describes what this session currently sees,
                // so do not keep another copy of the message list around
                command = Object.assign({}, command);
                delete command.mailboxCopy;
            }
            this.queueNotification(command, notification);
        }
    }

    /**
     * Queues a notification for this session, it is sent before the next tagged response that allows it, or
     * right away while notifications are direct (IDLE). Plugins can replace it per connection to drop
     * notifications or send them at other times (e.g. NOTIFY)
     *
     * @param {Object} command Untagged response
     * @param {Object} notification The `notify` event, `{ command, mailbox, ignoreConnection, filter, origin }`
     */
    queueNotification(command: Notification, notification?: NotifyEvent): void {
        this.notificationQueue.push(command);
        if (this.directNotifications) {
            this.processNotifications();
        }
    }

    upgradeConnection(callback: () => void): void {
        this.upgrading = true;

        // Anything the client sent after STARTTLS in plaintext must not be executed after the upgrade (RFC 9051
        // section 6.2.1). STARTTLS is refused when input is waiting (the noPipelining command option), this only
        // guards against plugins that upgrade the connection otherwise
        this.discardInput();

        // STARTTLS runs on a live connection
        const socket = this.socket as net.Socket & { startTls?: (callback: () => void) => void };

        if (typeof socket.startTls === 'function') {
            // a socket without a TLS layer that can count as encrypted (MemorySocket of server.connect())
            return socket.startTls(() => {
                this.secureConnection = true;
                this.upgrading = false;
                callback();
            });
        }

        const secureContext = tls.createSecureContext(this.server.getCredentials());
        const socketOptions: tls.TLSSocketOptions = {
            secureContext: secureContext,
            isServer: true,
            server: this.server.server,

            // throws if SNICallback is missing, so we set a default callback
            SNICallback: function (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) {
                cb(null, secureContext);
            }
        };

        // the RST of a script rule goes to the TCP socket under the TLS layer, see resetSocket. Node also has it as the
        // _parent of the TLS socket, Bun does not
        this.tcpSocket = socket;

        // remove all listeners from the original socket besides the error handler
        socket.removeAllListeners();
        socket.on('error', this.onError.bind(this));

        // upgrade connection
        const secureSocket = new tls.TLSSocket(socket, socketOptions);

        const onTLSError = (err: Error) => {
            // a failed handshake leaves nothing to talk to, so drop the connection
            if (this.options.debug) {
                console.log('TLS error: %s', err.message);
            }
            secureSocket.destroy();
        };

        secureSocket.on('close', this.onClose.bind(this));
        secureSocket.on('error', onTLSError);
        secureSocket.on('clientError', onTLSError);

        secureSocket.on('secure', () => {
            this.secureConnection = true;
            this.socket = secureSocket;
            this.upgrading = false;
            secureSocket.on('data', this.receive.bind(this));
            callback();
        });
    }

    /**
     * Turns the queued notifications into the responses to send. Plugins can replace it per connection
     * to report changes in another form (e.g. VANISHED instead of EXPUNGE with QRESYNC)
     *
     * @param {Array} queue Queued notifications
     * @return {Array} Notifications to send
     */
    prepareNotifications(queue: Notification[]): Notification[] {
        return queue;
    }

    /**
     * Checks if EXPUNGE responses must wait while a command runs: during FETCH, STORE and SEARCH (RFC 3501 section
     * 7.4.1), during the commands that extensions add to this list (see the noExpunge command option), and during UID
     * SEARCH with message numbers in the search criteria (RFC 7162 section 3.2.10.2 for VANISHED, EXPUNGE may wait as
     * well, RFC 3501 only allows it during UID commands)
     *
     * @param {Object} data Parsed command
     * @return {Boolean} true if the command holds back EXPUNGE responses
     */
    holdsExpunge(data: CommandContext): boolean {
        const options = this.server.getCommandOptions(data.command);
        return options.noExpunge || (options.searchCriteria !== false && this.usesSequenceNumbers(data));
    }

    /**
     * Sends the queued notifications. During a command that holds back EXPUNGE responses (see holdsExpunge), or with
     * `beforeCommand` before a command that refers to messages by sequence number, only the notifications queued before
     * the first pending EXPUNGE go out: new messages (EXISTS) and flag changes. RFC 3501 section 5.2: "A server MUST send
     * mailbox size updates automatically if a mailbox size change is observed during the processing of a command",
     * section 7.4.1 forbids only EXPUNGE during FETCH, STORE and SEARCH. What was queued after the EXPUNGE waits with it,
     * an EXISTS sent before it would describe a list that the client can not know yet
     *
     * @param {Object} [data] Parsed command that runs, or null between commands
     * @param {Boolean} [beforeCommand] true when the command has not run yet, then a command with message sequence
     *     numbers (COPY, MOVE) also waits with the EXPUNGE responses, its numbers refer to the messages before them
     */
    processNotifications(data?: CommandContext | null, beforeCommand?: boolean): void {
        if (!this.notificationQueue.length) {
            return;
        }

        let queue = this.notificationQueue;
        // Flag updates use the sequence numbers this session knows: before the EXPUNGE responses of
        // the snapshot are sent, the snapshot, afterwards the current message list
        const snapshot = queue.find(notification => notification.mailboxCopy);
        let held: Notification[] = [];
        if (data && (this.holdsExpunge(data) || (beforeCommand && this.usesSequenceNumbers(data)))) {
            const first = queue.findIndex(isPendingExpunge);
            if (first >= 0) {
                held = queue.slice(first);
                queue = queue.slice(0, first);
            }
            if (!queue.length) {
                return;
            }
        }

        this.notificationQueue = held;
        queue = this.prepareNotifications(queue);

        const snapshotIndex = queue.findIndex(notification => notification.mailboxCopy);
        const sequenceMaps = new Map<Message[], Map<Message, number>>();
        const getSequence = (messages: Message[]) => {
            let sequence = sequenceMaps.get(messages);
            if (!sequence) {
                sequence = new Map(messages.map((message, i) => [message, i + 1]));
                sequenceMaps.set(messages, sequence);
            }
            return sequence;
        };
        const current = this.selectedMailbox ? this.selectedMailbox.messages : [];
        // a message changed several times is reported once, its FETCH response carries the current flags
        const reported = new Set<Message>();

        // before the snapshot (or with all of it still held back, then the split at the first pending expunge leaves
        // no snapshot in the queue) the session knows the old list
        const sessionList = (i: number) => (snapshot && (snapshotIndex < 0 || i < snapshotIndex) ? (snapshot.mailboxCopy as Message[]) : current);

        // the last EXISTS response of a run of EXISTS responses, and if the run announces new messages
        let lastExists = -1;
        let newMessages = false;
        queue.forEach((notification, i) => {
            if (notification.flagUpdate) {
                this.sendFlagUpdate(notification.flagUpdate, getSequence(sessionList(i)), reported);
            } else {
                this.send(notification);
            }
            if (isExists(notification)) {
                lastExists = i;
                // the EXISTS after the EXPUNGE responses of another session carries the snapshot instead of a message
                newMessages = newMessages || !!notification.message;
            }
            const next = queue[i + 1];
            if (lastExists < 0 || isExists(next) || (next && next.fetchedMessage)) {
                // not the end of a run of EXISTS responses (and the FETCH responses NOTIFY sends after them)
                return;
            }
            // RFC 3501 section 7.3.2: the RECENT response "occurs as a result of a SELECT or EXAMINE command, and if the
            // size of the mailbox changes (e.g., new messages)". One for consecutive EXISTS responses that announce new
            // messages, with the number of \Recent messages among those the client was told about. After expunges the
            // EXPUNGE responses report the change (RFC 3501 section 7.4.1). It goes after the FETCH responses that NOTIFY
            // sends for new messages, RFC 5465 section 5.2: "an unsolicited EXISTS response, followed by an unsolicited
            // FETCH response [...] The server MAY also send a RECENT response"
            if (newMessages) {
                this.sendRecent(Number(queue[lastExists].attributes[0]), getSequence(sessionList(lastExists)));
            }
            lastExists = -1;
            newMessages = false;
        });
    }

    /**
     * Sends an untagged RECENT response with the number of \Recent messages among the first `count` messages
     *
     * @param {Number} count Number of messages the client was told about
     * @param {Map} sequence Message to the sequence number this session knows it by
     */
    sendRecent(count: number, sequence: Map<Message, number>): void {
        let recent = 0;
        (this.recent || new Set<Message>()).forEach(message => {
            const seq = sequence.get(message);
            if (seq && seq <= count) {
                recent++;
            }
        });
        this.send({ tag: '*', notification: true, attributes: [recent, { type: 'ATOM', value: 'RECENT' }] }, 'RECENT NOTIFICATION');
    }

    /**
     * Compile a command object to a response string and write it to socket.
     * If the command object has a skipResponse property, the command is
     * ignored
     *
     * @param {Object} response Response IMAP command object to be compiled.
     * @param {String} description
     *   An upper-case string uniquely identifying the response for the benefit of
     *   output handlers that wish to augment/replace the given response.
     * @param {Object} parsed
     *   Original parsed IMAP command that this is in response to.
     * @param {String} data
     *   Original raw IMAP command as a binary string.
     * @param {Object} extra
     *   Response-specific payload, usually the subject of the response.  For
     *   example, the STORE command will pass the impacted message for each updated
     *   FETCH result.  (This may have other names when used, like "affected".)
     */
    send(response: IMAPResponse, description?: string, parsed?: CommandContext | null, data?: string | null, ...extra: any[]): void {
        // nothing goes out once the connection is closing (RFC 3501 section 7.1.5)
        if (!this.isOpen()) {
            return;
        }

        if (!response.notification && response.tag !== '*') {
            // arguments[2] should be the original command
            this.processNotifications(parsed);
        }

        this.server.outputHandlers.forEach(handler => {
            handler(this, response, description, parsed, data, ...extra);
        });

        if (this._commandStart && parsed && response.tag === this._commandStart.tag && parsed.tag === response.tag) {
            this.commandCompleted(String(response.command || '').toUpperCase());
        }

        // No need to display this response to user
        if (response.skipResponse) {
            return;
        }

        if (
            this.notificationQueue.length &&
            parsed &&
            response.tag === parsed.tag &&
            response.command === 'OK' &&
            this.hasPendingExpunge() &&
            this.holdsExpunge(parsed) &&
            !(Array.isArray(response.attributes) && response.attributes.some(attr => attr && attr.type === 'SECTION'))
        ) {
            // After the output handlers, they might add a response code of their own (MODIFIED of CONDSTORE).
            // FETCH, STORE, SEARCH and the like can not report the EXPUNGE of another session (RFC 3501 section 7.4.1), nor
            // can UID SEARCH with message numbers in the criteria (see holdsExpunge),
            // EXPUNGEISSUED tells the client to issue NOOP soon (RFC 5530 section 3, RFC 9051 section 7.1)
            response.attributes = [{ type: 'SECTION', section: [{ type: 'ATOM', value: 'EXPUNGEISSUED' }] }].concat(response.attributes || []);
        }

        // a { type: 'MAILBOX', value } attribute holds a storage name, sent in the form this session uses. It
        // can also be in a list, like the MAILBOX correlator of an ESEARCH response (RFC 7377 section 4)
        const isMailbox = (attr: Attribute) => attr && attr.type === 'MAILBOX';
        const hasMailbox = (list: Attribute[]): boolean => list.some((attr: Attribute) => isMailbox(attr) || (Array.isArray(attr) && hasMailbox(attr)));
        const exportList = (list: Attribute[]): Attribute[] =>
            list.map((attr: Attribute) =>
                isMailbox(attr) ? mailboxAttribute(this.exportMailboxName(attr.value)) : Array.isArray(attr) ? exportList(attr) : attr
            );
        if (Array.isArray(response.attributes) && hasMailbox(response.attributes)) {
            response = Object.assign({}, response, { attributes: exportList(response.attributes) });
        }

        // RFC 3501 section 9: TEXT-CHAR is 7-bit (CHAR = %x01-7F), so client input echoed in the
        // human readable text of a status response must not carry 8-bit or control octets
        if (STATUS_RESPONSES.has((response.command || '').toString().toUpperCase()) && Array.isArray(response.attributes)) {
            const isUnsafe = (attr: Attribute) => attr && attr.type === 'TEXT' && typeof attr.value === 'string' && /[^\x20-\x7e]/.test(attr.value);
            if (response.attributes.some(isUnsafe)) {
                response = Object.assign({}, response, {
                    attributes: response.attributes.map((attr: Attribute) =>
                        isUnsafe(attr) ? Object.assign({}, attr, { value: attr.value.replace(/[^\x20-\x7e]/g, '?') }) : attr
                    )
                });
            }
        }

        const compiled = this.compileResponse(response);
        if (compiled === null) {
            return;
        }

        if (this._deferredOutput) {
            // responses that `defer` rules hold back go before the first response of another command
            releaseDeferred(this, parsed && parsed.command && parsed.tag && parsed.tag !== '*' ? parsed.tag : null, false);
        }
        this.scriptResponse(response, compiled, description, parsed);
        if (this._deferredOutput && response.tag !== '*' && response.tag !== '+') {
            releaseDeferred(this, response.tag, true);
        }
    }

    /**
     * Sends a compiled response through the script rules that watch responses or continuations
     *
     * @param {Object} response Response object
     * @param {String} compiled The compiled response
     * @param {String} [description] Description of the response
     * @param {Object} [parsed] The command the response belongs to
     */
    scriptResponse(response: IMAPResponse, compiled: string, description?: string, parsed?: CommandContext | null): void {
        const event = response.tag === '+' ? 'continuation' : 'response';
        if (!this.server.script.watches(event)) {
            this.write(compiled);
            return;
        }
        // script rules see the response after every plugin and the core changed it. Without a command, an
        // unsolicited response belongs to the command that runs or idles
        this.scriptOutput(
            event,
            compiled,
            Object.assign(
                { description: description || null, response },
                parsed && parsed.command ? { tag: parsed.tag || null, command: String(parsed.command).toUpperCase() } : {}
            ),
            output => this.compileResponse(output)
        );
    }

    /**
     * Compiles a response for the wire
     *
     * @param {Object} response Response object
     * @return {String|null} the response with its CRLF as a binary string, or null for an untagged response that does not compile
     */
    compileResponse(response: IMAPResponse): string | null {
        let compiled;
        try {
            compiled = imapHandler.compiler(response, this.compilerOptions);
        } catch (err) {
            // the compiler refuses unsafe output, like line breaks in a TEXT value
            if (this.options.debug) {
                console.log('Failed to compile response: %s', (err as Error).message);
            }
            if (response.tag === '*') {
                return null;
            }
            compiled = response.tag + ' NO [SERVERBUG] Failed to compile response';
        }
        if (this.options.debug) {
            console.log('SEND: %s', compiled);
        }
        return compiled + '\r\n';
    }

    /**
     * Sends a tagged status response to a command
     *
     * @param {Object} parsed Parsed command
     * @param {String} data Raw command
     * @param {String} command Response type: OK, NO or BAD
     * @param {String} text Human readable text
     * @param {String|Array} [code] Response code, eg. "TRYCREATE", sent as [TRYCREATE], or a list of
     *   atoms like ["METADATA", "MAXSIZE", 1024], sent as [METADATA MAXSIZE 1024]
     * @param {String} [description] Description for output handlers, defaults to the command name,
     *   with " FAILED" appended for NO and BAD
     */
    sendStatus(
        parsed: CommandContext,
        data: string | null | undefined,
        command: string,
        text: string,
        code?: string | number | (string | number)[] | false | null,
        description?: string | null
    ): void {
        const attributes: Attribute[] = [];
        if (code) {
            attributes.push({
                type: 'SECTION',
                section: ([] as (string | number)[]).concat(code).map(value => ({
                    type: 'ATOM',
                    value: String(value)
                }))
            });
        }
        attributes.push({
            type: 'TEXT',
            value: text
        });

        if (!description) {
            description = (parsed.command || '').toString().toUpperCase() + (command === 'OK' ? '' : ' FAILED');
        }

        this.send(
            {
                tag: parsed.tag,
                command,
                attributes
            },
            description,
            parsed,
            data
        );
    }

    /**
     * Checks if a command was sent without waiting for an earlier command in a way that RFC 3501
     * section 5.5 forbids: after any command other than FETCH, STORE or SEARCH (or another command with
     * the noExpunge option, like SORT and THREAD from RFC 5256) the client must
     * wait for the completion result before it sends a command with message sequence numbers,
     * because an EXPUNGE response could change what the numbers refer to. A command was sent
     * without waiting if such a command is still queued or running, or if it completed in the
     * same read as this command arrived in.
     *
     * @param {Object} parsed Parsed command
     * @return {Boolean} true if the command is ambiguous
     */
    isAmbiguous(parsed: ParsedCommand): boolean {
        if (!this.usesSequenceNumbers(parsed)) {
            return false;
        }
        if (this._unsafeCompletedRead === this._readCount) {
            return true;
        }
        const isUnsafe = (element: QueuedCommand | null | undefined) => !!element && !this.server.getCommandOptions(element.parsed.command).noExpunge;
        return isUnsafe(this._runningCommand) || this._commandQueue.some(isUnsafe);
    }

    /**
     * Checks if a command refers to messages by sequence number (RFC 3501 section 5.5)
     *
     * @param {Object} parsed Parsed command
     * @return {Boolean} true if the command uses message sequence numbers
     */
    usesSequenceNumbers(parsed: CommandContext): boolean {
        // the notification checks ask several times per command, the answer does not change
        let cached = sequenceNumberUse.get(parsed);
        if (cached === undefined) {
            cached = this.findSequenceNumbers(parsed);
            sequenceNumberUse.set(parsed, cached);
        }
        return cached;
    }

    findSequenceNumbers(parsed: CommandContext): boolean {
        const { sequenceSet, searchCriteria } = this.server.getCommandOptions(parsed.command);
        if (sequenceSet !== false) {
            // other forms of sequence sets, like "$" of SEARCHRES (RFC 5182 section 2.3), do not use numbers
            const value = parsed.attributes && parsed.attributes[sequenceSet];
            return !value || /^[\d*]/.test(String(value.value));
        }
        if (searchCriteria !== false) {
            return hasSequenceSetKey(this.server, (parsed.attributes || []).slice(searchCriteria));
        }
        return false;
    }

    /**
     * Decodes a SASL client response. It must be valid base64 by the RFC 3501 section 9 grammar,
     * "=" stands for an empty initial response (RFC 4959 section 3).
     *
     * @param {String} str Client response
     * @return {Buffer|Boolean} Decoded value, or false if the input is not valid base64
     */
    decodeSaslResponse(str: unknown): Buffer | false {
        if (str === '=') {
            return Buffer.alloc(0);
        }
        if (typeof str !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(str)) {
            return false;
        }
        return Buffer.from(str, 'base64');
    }

    /**
     * Returns the target mailbox of APPEND, COPY or MOVE. If messages can not be added
     * to it, a tagged NO is sent and false is returned
     *
     * @param {String} path Mailbox path
     * @param {Object} parsed Parsed command
     * @param {String} data Raw command
     * @param {String} description Description for the failure response
     * @return {Object|false} Mailbox object
     */
    getTargetMailbox(path: string, parsed: ParsedCommand, data: string, description?: string): Mailbox | false {
        const refusal = this.server.targetRefusal(path);
        if (refusal) {
            this.sendStatus(parsed, data, refusal.command, refusal.text, refusal.code, description);
            return false;
        }
        // targetRefusal() found it
        return this.server.getMailbox(path) as Mailbox;
    }

    /**
     * Runs the checks of `server.appendChecks` before messages are added to a mailbox. A check
     * returns nothing if the messages may be added, or `{ code, text, soft }`: a hard failure is
     * sent as a tagged NO with the response code and false is returned, a soft one (`soft: true`)
     * only as an untagged NO warning, e.g. `* NO [OVERQUOTA] ...` (RFC 9208 section 4.3.1).
     *
     * @param {Object} mailbox Target mailbox
     * @param {Array} messages Messages to add, objects with the message source as `raw`
     * @param {Object} parsed Parsed command
     * @param {String} data Raw command
     * @param {String} description Description for the failure response
     * @param {Object} [options] `{ move, source }`, set for MOVE with the source mailbox, or `{ command, replaced }`
     *   for APPEND like commands (APPEND, REPLACE), `replaced` is the message that REPLACE removes
     * @return {Boolean} true if the messages may be added
     */
    checkAppend(
        mailbox: Mailbox,
        messages: AppendMessage[],
        parsed: ParsedCommand,
        data: string,
        description?: string,
        options?: AppendCheckOptions | null
    ): boolean {
        return this.applyChecks(
            this.server.appendChecks.map(check => check(this, mailbox, messages, options || {})),
            parsed,
            data,
            description
        );
    }

    /**
     * Reports the results of checks like `server.appendChecks`: the first hard failure as a tagged
     * NO, or soft ones as untagged NO warnings
     *
     * @param {Array} results Check results, `{ code, text, soft }` or nothing
     * @param {Object} parsed Parsed command
     * @param {String} data Raw command
     * @param {String} description Description for the failure response
     * @return {Boolean} false if the command failed
     */
    applyChecks(results: (CheckResult | false | null | undefined | void)[], parsed: ParsedCommand, data: string, description?: string): boolean {
        const found = results.filter((result): result is CheckResult => !!result);

        const failure = found.find(result => !result.soft);
        if (failure) {
            this.sendStatus(parsed, data, 'NO', failure.text, failure.code, description);
            return false;
        }

        found.forEach(result => {
            this.send(
                {
                    tag: '*',
                    command: 'NO',
                    attributes: [
                        { type: 'SECTION', section: [{ type: 'ATOM', value: result.code }] },
                        { type: 'TEXT', value: result.text }
                    ]
                },
                'CHECK WARNING',
                parsed,
                data
            );
        });
        return true;
    }

    /**
     * Converts a mailbox name from a command to the name used in storage, which is modified UTF-7
     * (RFC 3501 section 5.1.3). A plugin can replace this per connection, e.g. UTF8=ACCEPT.
     *
     * @param {String} name Mailbox name as a binary string
     * @return {String} Storage name
     * @throws {Error} BAD error if the name is not valid
     */
    importMailboxName(name: string): string {
        const error = validateMailboxName(name);
        if (error) {
            const err: IMAPError = new Error(error);
            err.imapResponse = 'BAD';
            throw err;
        }
        return name;
    }

    /**
     * Converts a mailbox name from storage to the form sent to the client. Every response that
     * includes a mailbox name must use this. A plugin can replace this per connection.
     *
     * @param {String} path Storage name
     * @return {String} Mailbox name as a binary string
     */
    exportMailboxName(path: string): string {
        return path;
    }

    /**
     * Parses a command line and queues the command, or answers it right away when it can not run
     *
     * @param {String} data Command line with its literals, without the final CRLF
     * @param {Boolean} [scripted] The line comes from a script rule with `run`, it is next in the queue
     */
    scheduleCommand(data: string, scripted?: boolean): void {
        let parsed: ParsedCommand;
        const tag = getResponseTag(data);

        // the rule is chosen when the line arrives, the state it matches is the state at that moment. The rule
        // acts when the command's turn comes, so that its output keeps the order of the responses
        const found =
            !scripted && this.server.script.watches('command') ? this.server.script.check(this, 'command', { data, tag, command: getLineCommand(data) }) : null;
        if (found) {
            this._commandQueue.push({ parsed: { tag, command: found.context.command || '' } as ParsedCommand, data, script: found });
            this.processQueue();
            return;
        }

        try {
            // server.parserOptions are the defaults of plugins, connection.parserOptions win
            parsed = imapHandler.parser(data, Object.assign({ literalPlus: this.server.literalPlus }, this.server.parserOptions, this.parserOptions));
        } catch (E) {
            const error = E as Error;
            this.send(
                {
                    tag: '*',
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [
                                {
                                    type: 'ATOM',
                                    value: 'SYNTAX'
                                }
                            ]
                        },
                        {
                            type: 'TEXT',
                            value: error.message
                        }
                    ]
                },
                'ERROR MESSAGE',
                null,
                data,
                error
            );

            this.send(
                {
                    tag: tag,
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Error parsing command'
                        }
                    ]
                },
                'ERROR RESPONSE',
                null,
                data,
                error
            );

            return;
        }

        if (this.isPipelinedAfterRefusal()) {
            this.refusePipelined(parsed, data);
            return;
        }

        // an unknown SASL mechanism is answered by its own handler, after the central checks (state, script rules)
        const fallback = /^AUTHENTICATE /i.test(parsed.command) && !this.server.getCommandHandler(parsed.command) ? unsupportedMechanism : undefined;
        if (fallback || this.server.getCommandHandler(parsed.command)) {
            if (this.isAmbiguous(parsed)) {
                this.sendStatus(parsed, data, 'BAD', 'Commands with message sequence numbers must wait for the completion of earlier commands');
                return;
            }
            const element: QueuedCommand = { parsed, data, handler: fallback };
            if (scripted) {
                // processQueue runs it once the script rule released the queue
                this._commandQueue.unshift(element);
            } else {
                this._commandQueue.push(element);
            }
            this.processQueue();
        } else {
            this.send(
                {
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Invalid command ' + parsed.command + ''
                        }
                    ]
                },
                'UNKNOWN COMMAND',
                parsed,
                data
            );
        }
    }

    /**
     * Emits the `command` event when the tagged response of a command goes out, and the `session` events "login"
     * (the command authenticated the session) and "logout" (back to Not Authenticated, UNAUTHENTICATE). Every command
     * that changes these does so before its tagged response. "select" and "unselect" come from SELECT and
     * closeMailbox(). Tests wait for these instead of polling
     *
     * @param {String} status OK, NO or BAD
     */
    commandCompleted(status: string): void {
        const start = this._commandStart as CommandStart;
        this._commandStart = null;
        const server = this.server;
        if (!server.listenerCount('command') && !server.listenerCount('session')) {
            return;
        }
        server.emit('command', { session: this.sessionNumber, tag: start.tag, command: start.command, status, user: this.username || null });

        const authenticated = (state: ConnectionState) => state === 'Authenticated' || state === 'Selected';
        if (authenticated(start.state) !== authenticated(this.state) && this.state !== 'Logout') {
            this.emitSession(authenticated(this.state) ? 'login' : 'logout');
        }
    }

    /**
     * Emits a `session` event, `{ type, session, ...fields }`
     *
     * @param {String} type Event type
     * @param {Object} [fields] More fields of the event
     */
    emitSession(type: string, fields?: Record<string, unknown>): void {
        if (this.server.listenerCount('session')) {
            this.server.emit('session', Object.assign({ type, session: this.describe() }, fields));
        }
    }

    /**
     * Describes the session without credentials or sockets, for the control API and the `session` events
     *
     * @return {Object} `{ session, user, state, mailbox, readOnly, enabled, secure, compressed, remoteAddress }`
     */
    describe(): SessionInfo {
        return {
            session: this.sessionNumber,
            user: this.username || null,
            state: this.state,
            mailbox: this.selectedMailbox ? this.selectedMailbox.path : null,
            readOnly: !!this.selectedMailbox && !!this.readOnly,
            enabled: Array.isArray(this.enabled) ? this.enabled.slice() : [],
            secure: !!this.secureConnection,
            compressed: !!this.transport,
            remoteAddress: (this.socket && this.socket.remoteAddress) || null
        };
    }

    /**
     * Checks if output can still be sent: the socket is open and the connection is not closing (BYE, LOGOUT)
     *
     * @return {Boolean} true for a live session
     */
    isOpen(): boolean {
        return !!this.socket && !this.socket.destroyed && !this._closing;
    }

    /**
     * Handles a command line with the script rule that matched it, after the rule's delay. With `run` the line
     * goes through the parser and the command handler as usual afterwards
     *
     * @param {Object} element Queued command with the rule
     * @param {Function} next Releases the queue
     */
    runScriptedCommand(element: QueuedCommand, next: () => void): void {
        const { rule, context } = element.script as NonNullable<QueuedCommand['script']>;
        const act = () => {
            if (!this.socket || this._closing) {
                return next();
            }
            handleLine(this, rule, context, () => {
                // the line is not running yet, it must not count as an earlier command (RFC 3501 section 5.5)
                this._runningCommand = null;
                this.scheduleCommand(element.data, true);
            });
            next();
        };
        if (rule.delay) {
            setTimeout(act, rule.delay);
        } else {
            act();
        }
    }

    processQueue(force?: boolean): void {
        if (!force && this._processing) {
            return;
        }

        if (!this._commandQueue.length) {
            this._processing = false;
            return;
        }

        this._processing = true;

        const element = this._commandQueue.shift() as QueuedCommand;
        const command = element.parsed.command.toUpperCase();
        this._runningCommand = element;
        const options = this.server.getCommandOptions(command);
        // the session events of the command are worked out when its tagged response goes out, see commandCompleted
        this._commandStart = { tag: element.parsed.tag, command, state: this.state };
        let done = false;
        const next = () => {
            if (done) {
                // a handler must release the queue only once
                return;
            }
            done = true;
            this._runningCommand = null;
            if (!options.noExpunge) {
                // commands with sequence numbers that arrive in the same read did not wait for this one
                this._unsafeCompletedRead = this._readCount;
            }
            if (!this._commandQueue.length) {
                this._processing = false;
            } else {
                this.processQueue(true);
            }
        };

        if (element.script) {
            this.runScriptedCommand(element, next);
            return;
        }

        if (options.states && options.states.indexOf(this.state) < 0) {
            this.sendStatus(element.parsed, element.data, 'BAD', stateError(command, this.state));
            return next();
        }

        if (element.parsed.attributes && options.noArguments) {
            this.sendStatus(element.parsed, element.data, 'BAD', command + ' does not take any arguments');
            return next();
        }

        if (options.noPipelining && this.hasPendingInput()) {
            // the layer change is not made. The commands that follow were meant to run in the new layer (under TLS, or
            // compressed), so none of them runs: they are refused like this command, see refusePipelined
            this.sendStatus(element.parsed, element.data, 'BAD', 'Commands must not be pipelined after ' + command);
            this._pipelinedAfter = { command, read: this._readCount };
            this._commandQueue.splice(0).forEach(queued => this.refusePipelined(queued.parsed, queued.data));
            return next();
        }

        // the parser reads every NIL atom as nil, but in an astring NIL is just a name (e.g. SELECT NIL)
        restoreNilAtoms(
            element.parsed,
            element.data,
            path =>
                (path.length === 1 && (options.mailboxArguments.includes(path[0] as number) || options.astringArguments.includes(path[0] as number))) ||
                (options.searchCriteria !== false && (path[0] as number) >= options.searchCriteria)
        );

        const nameError = importMailboxArguments(this, element.parsed, options.mailboxArguments);
        if (nameError) {
            this.sendStatus(element.parsed, element.data, 'BAD', nameError);
            return next();
        }

        for (const check of this.server.commandChecks) {
            const refusal = check(this, element.parsed);
            if (refusal) {
                this.sendStatus(element.parsed, element.data, refusal.command || 'BAD', refusal.text, refusal.code);
                return next();
            }
        }

        if (
            this.state === 'Selected' &&
            (command.startsWith('UID ') || options.noExpunge || options.sequenceSet !== false || options.searchCriteria !== false)
        ) {
            // A command that refers to messages runs on the message list the client was told about. Only these: CLOSE
            // must not send pending EXPUNGE responses (RFC 3501 section 6.4.2) and SELECT leaves the old mailbox. RFC 3501 section 5.2:
            // "A server MUST send mailbox size updates automatically if a mailbox size change is observed during the
            // processing of a command", so the new messages and flag changes of other sessions are reported first,
            // before the command resolves its sequence set or search criteria.
            // EXPUNGE responses may be sent during UID commands (RFC 3501 section 7.4.1), so these report the expunges of
            // other sessions first as well, then the command runs on the current mailbox, where the UIDs of the expunged
            // messages do not exist and are ignored (RFC 3501 section 6.4.8). The ghost handling of STORE, COPY and MOVE
            // (RFC 2180 section 4) only applies to their sequence number forms, these and UID SEARCH with message numbers
            // in the criteria keep the EXPUNGE responses for later, see processNotifications
            this.processNotifications(element.parsed, true);
        }

        // changes made while the handler runs are attributed to this session (the `origin` of notifications)
        this.server.withOrigin(this, () => {
            try {
                const inputHandler = this.inputHandler;
                (element.handler || (this.server.getCommandHandler(element.parsed.command) as CommandHandler))(this, element.parsed, element.data, next);
                if (this.inputHandler && this.inputHandler !== inputHandler) {
                    // the command reads the lines that follow (IDLE, AUTHENTICATE), script rules match them with it
                    this.inputCommand = { tag: element.parsed.tag, command: element.parsed.command };
                    this.emitSession('waiting', { command });
                }
            } catch (E) {
                const ex = E as IMAPError;
                const badInput = ex.imapResponse === 'BAD';
                if (!badInput && this.options.debug) {
                    console.error('Error processing command:', ex, '\n', ex.stack);
                }
                this.send(
                    {
                        tag: element.parsed.tag,
                        command: badInput ? 'BAD' : 'NO',
                        attributes: ([] as Attribute[]).concat(
                            badInput
                                ? []
                                : {
                                      type: 'SECTION',
                                      section: [
                                          {
                                              type: 'ATOM',
                                              value: 'SERVERBUG'
                                          }
                                      ]
                                  },
                            {
                                type: 'TEXT',
                                value: badInput ? ex.message : 'Server error: ' + ex.message
                            }
                        )
                    },
                    badInput ? 'INVALID COMMAND' : 'SERVER ERROR',
                    element.parsed,
                    element.data
                );
                // keep the connection usable, otherwise every later command would hang
                next();
            }
        });
    }

    /**
     * Removes messages with \Deleted flag
     *
     * @param {Object} mailbox Mailbox to check for
     * @param {Boolean} [ignoreSelf] If set to true, does not send any notices to itself
     * @param {Boolean} [ignoreExists] If set to true, does not send EXISTS notice to itself
     */
    expungeDeleted(mailbox: Mailbox, ignoreSelf?: boolean, ignoreExists?: boolean): void {
        this.expungeSpecificMessages(
            mailbox,
            (message: Message) => {
                return message.flags.indexOf('\\Deleted') >= 0;
            },
            ignoreSelf,
            ignoreExists
        );
    }

    /**
     * Given a set of messages in a mailbox (possibly via getMessageRange), remove
     * them from the mailbox and generate EXPUNGE notifications, see expungeMessages() in store-operations.ts
     *
     * @param {Object} mailbox Mailbox to check for
     * @param {Function|Array} messagesOrFilterFunc An Array of messages in the
     *     folder that should be removed or a filtering function that indicates
     *     messages to be removed by returning true.
     * @param {Boolean} [ignoreSelf] If set to true, does not send any notices to itself
     * @param {Boolean} [ignoreExists] If set to true, does not send EXISTS notice to itself
     * @param {Boolean} [highestFirst] If set to true, the EXPUNGE responses go from the highest UID to the lowest
     *     (MESSAGELIMIT, RFC 9738 section 3.1), otherwise from the lowest
     */
    expungeSpecificMessages(
        mailbox: Mailbox,
        messagesOrFilterFunc: Message[] | ((message: Message) => unknown),
        ignoreSelf?: boolean,
        ignoreExists?: boolean,
        highestFirst?: boolean
    ): void {
        expungeMessages(this.server, mailbox, messagesOrFilterFunc, {
            origin: this,
            skip: ignoreSelf ? this : null,
            skipExists: ignoreExists ? this : null,
            highestFirst: !!highestFirst
        });
    }
}

// setImmediate does not let Deno send what sockets were given, see nextTurn
const IS_DENO = 'Deno' in globalThis;

/**
 * Runs a function on the next event loop turn that also handles network I/O: setImmediate on Node and Bun, a zero
 * timer on Deno, where setImmediate runs before the sockets send what was written (#89)
 *
 * @param {Function} fn Function to run
 * @return {Object} the timer, clearOutputQueue clears it
 */
function nextTurn(fn: () => void): ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate> {
    return IS_DENO ? setTimeout(fn, 0) : setImmediate(fn);
}

/**
 * Starts listening, resolves with the port or rejects with the listen error (EADDRINUSE)
 *
 * @param {Object} server net, tls or http server
 * @param {Number} [port] Port, a free one if not set
 * @param {String} [host] Address, all addresses if not set
 * @return {Promise<Number>} the port
 */
function listenOn(server: net.Server, port?: number, host?: string): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: port || 0, host }, () => {
            server.removeListener('error', reject);
            resolve((server.address() as net.AddressInfo).port);
        });
    });
}

/**
 * Destroys a socket with a TCP RST (`close: 'reset'` of a script rule). resetAndDestroy (Node 16.17) needs a socket with
 * a TCP handle, a TLS socket throws ERR_INVALID_HANDLE_TYPE (#84), so the RST goes to the TCP socket under the TLS
 * layer: the plain socket of STARTTLS, or the parent socket of implicit TLS (Node). A runtime without resetAndDestroy,
 * or a socket that can not be reset, is destroyed without a RST
 *
 * @param {Object} socket The socket of the connection
 * @param {Object} [tcpSocket] The plain socket that STARTTLS wrapped
 */
function resetSocket(socket: net.Socket, tcpSocket?: net.Socket | null): void {
    const parent = (socket as net.Socket & { _parent?: unknown })._parent;
    const candidates = [tcpSocket, parent instanceof net.Socket ? parent : null, socket];
    for (const candidate of candidates) {
        if (candidate && !candidate.destroyed && typeof candidate.resetAndDestroy === 'function') {
            try {
                candidate.resetAndDestroy();
                break;
            } catch {
                // not a TCP handle, try the next one
            }
        }
    }
    // the TLS socket closes with the TCP socket under it, and emits close for the connection
    socket.destroy();
}

/**
 * Copies a response tree for the `mutate` action of a script rule: arrays and plain objects are copied,
 * other values (Buffers) are shared
 *
 * @param {*} value Response or a part of it
 * @return {*} Copy
 */
function cloneResponse<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map(cloneResponse) as T;
    }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const copy: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            copy[key] = cloneResponse((value as Record<string, unknown>)[key]);
        }
        return copy as T;
    }
    return value;
}

/**
 * Finds the command name in a command line that may not parse: tag SP command, and for UID and AUTHENTICATE
 * the word that follows
 *
 * @param {String} line Command line
 * @return {String} Command name in upper case, can be empty
 */
function getLineCommand(line: string): string {
    const words = line.match(/^[^ ]* ([^ ]*)(?: ([^ ]*))?/);
    let command = ((words && words[1]) || '').toUpperCase();
    if (command === 'UID' || command === 'AUTHENTICATE') {
        command += ' ' + ((words && words[2]) || '').toUpperCase();
    }
    return command;
}

/**
 * Formats a mailbox name for a response: an atom when possible, otherwise a string. NIL and names
 * like \\Foo would not read back as mailbox names, so these are strings as well
 *
 * @param {String} name Mailbox name as sent to the client
 * @return {Object} Response attribute
 */
function mailboxAttribute(name: string): { type: string; value: string } {
    return { type: ATOM_REGEX.test(name) && !/^NIL$/i.test(name) ? 'ATOM' : 'STRING', value: name };
}

/**
 * Checks the mailbox name arguments of a command and replaces them with the storage names.
 * Arguments that are not strings are left to the command handler.
 *
 * @param {Object} connection IMAP connection
 * @param {Object} parsed Parsed command
 * @param {Array} positions Argument positions that hold mailbox names
 * @return {String|Boolean} Description of the problem, or false if the names are valid
 */
function importMailboxArguments(connection: IMAPConnection, parsed: ParsedCommand, positions: number[]): string | false {
    for (const position of positions) {
        const attr = (parsed.attributes || [])[position];
        if (attr && ['STRING', 'ATOM', 'LITERAL'].indexOf(attr.type) >= 0) {
            try {
                attr.value = connection.importMailboxName(attr.value);
            } catch (err) {
                return (err as Error).message;
            }
        }
    }
    return false;
}

export { TAG_REGEX, IMAPServer, IMAPConnection };
