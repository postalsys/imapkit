// Shared types of the server, the commands and the plugins

import type { IMAPServer, IMAPConnection } from './server.js';
import type { ScriptRule } from './script.js';

export type { IMAPServer, IMAPConnection };

/**
 * A value of the parsed command or of a response, as imap-handler parses and compiles it: an
 * `{ type, value, section?, partial? }` node, a list (array), a string, a number or null (NIL).
 * Commands and plugins walk these trees freely, so the type is left open.
 */
export type Attribute = any;

/** A parsed client command, see imap-handler. Plugins add their own properties (e.g. `searchReturn`) */
export interface ParsedCommand {
    tag: string;
    command: string;
    attributes?: Attribute[] | undefined;
    [key: string]: any;
}

/**
 * The command a response answers, as `connection.send()` and `connection.sendStatus()` take it: a parsed
 * command, or only the tag for input that could not be parsed (or `{ tag: '*' }` for an untagged response)
 */
export type CommandContext = ParsedCommand | { tag: string; command?: undefined; attributes?: undefined; [key: string]: any };

/** A response written to the client through `connection.send()` */
export interface IMAPResponse {
    tag: string;
    command?: string | undefined;
    attributes?: Attribute | Attribute[] | undefined;
    /** set by an output handler to drop the response */
    skipResponse?: boolean | undefined;
    /** an unsolicited response from the notification queue, it does not flush the queue */
    notification?: boolean | undefined;
    [key: string]: any;
}

/**
 * An untagged response distributed with `server.notify()`, queued per session in
 * `connection.notificationQueue` until it can be sent
 */
export interface Notification extends IMAPResponse {
    /** the session whose command caused the change, null for changes from SMTP */
    origin?: IMAPConnection | null | undefined;
    /** the new message of an EXISTS, or the removed message of an EXPUNGE */
    message?: Message | undefined;
    /** the removed messages of a VANISHED response (QRESYNC) */
    messages?: Message[] | undefined;
    /** the message list as it was before an expunge, for sessions that were not told about it yet */
    mailboxCopy?: Message[] | undefined;
    /** messages whose flags changed, sent as unsolicited FETCH responses */
    flagUpdate?: Message[] | undefined;
}

/** The `notify` event of the server, see `server.notify()` */
export interface NotifyEvent {
    command: Notification;
    /** the mailbox the change is about, false or null for changes that are not about the selected mailbox */
    mailbox: Mailbox | string | false | null | undefined;
    /** the session that does not get the notification */
    ignoreConnection: IMAPConnection | false | null | undefined;
    /** only connections for which it returns true get the notification */
    filter: ((connection: IMAPConnection) => boolean) | false | null | undefined;
    /** the session whose command caused the change, null for changes from outside (e.g. SMTP) */
    origin: IMAPConnection | null;
    [key: string]: any;
}

/** The `mailbox` event of the server, see `server.mailboxChanged()` */
export interface MailboxChangeEvent {
    /** "create", "delete", "rename", "subscribe" or "unsubscribe" */
    type: string;
    path: string;
    oldPath: string | null;
    mailbox: Mailbox | null;
    origin: IMAPConnection | null;
    /** "create": every mailbox the change created, superior hierarchy levels first */
    created?: string[] | undefined;
}

export type Callback = (err?: any, ...args: any[]) => void;

/** Handler of an IMAP command, it must send a tagged response and then call the callback */
export type CommandHandler = (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => void;

/** Options of a command, see `server.setCommandHandler()` and command-states.ts */
export interface CommandOptions {
    states?: string[] | string | false | undefined;
    noArguments?: boolean | undefined;
    mailboxArguments?: number[] | number | undefined;
    astringArguments?: number[] | number | undefined;
    searchCriteria?: number | false | undefined;
    sequenceSet?: number | false | undefined;
    noExpunge?: boolean | undefined;
    /** also the name of the capability that allows literal8 (`'BINARY'`) */
    literal8?: boolean | string | undefined;
    noPipelining?: boolean | undefined;
    appendMessage?: boolean | undefined;
}

/** A plugin, given as a function in `options.plugins` or built in */
export interface Plugin {
    (server: IMAPServer): void;
    /** plugins that are loaded before this one, by name */
    requires?: string[] | undefined;
}

/** An error that carries the response a command fails with */
export interface IMAPError extends Error {
    code?: string | undefined;
    imapResponse?: string | undefined;
    responseCode?: Attribute;
    responseCodeArgs?: Attribute;
    [key: string]: any;
}

/** Connection states of RFC 3501 section 3, "Logout" after LOGOUT or BYE */
export type ConnectionState = 'Not Authenticated' | 'Authenticated' | 'Selected' | 'Logout';

/** A message in a mailbox, plugins keep their own properties on it (MODSEQ, X-GM-LABELS ...) */
export interface Message {
    uid: number;
    flags: string[];
    internaldate: string;
    /** the message source as a binary string (one char per octet) */
    raw: string;
    recent?: boolean | undefined;
    /** expunged by another session but not yet reported to this one */
    ghost?: boolean | undefined;
    [key: string]: any;
}

/** Resolved messages of a sequence set, `[sequence number, message]` pairs */
export type MessageRange = [number, Message][];

/** A mailbox, plugins keep their own properties on it (acl, metadata, HIGHESTMODSEQ ...) */
export interface Mailbox {
    path: string;
    namespace: string;
    uid: number;
    uidvalidity: number;
    uidnext: number;
    flags: string[];
    permanentFlags: string[];
    allowPermanentFlags: boolean;
    messages: Message[];
    /** flags that messages of the mailbox had, they stay in FLAGS and PERMANENTFLAGS, see server.rememberFlags() */
    knownFlags?: string[] | undefined;
    folders?: Record<string, Mailbox> | undefined;
    separator?: string | undefined;
    /** an accessor of `server.subscriptions`, see server.trackSubscription() */
    subscribed?: boolean | undefined;
    [key: string]: any;
}

/**
 * A name that getSubscriptionTree() lists without a mailbox: a subscribed name that is not a mailbox, or a
 * superior hierarchy level of a subscribed name
 */
export interface SubscriptionStandIn {
    path: string;
    namespace: string | false;
    flags: string[];
    subscribed: boolean;
}

/** The fields of a mailbox (or a stand-in) that LIST pattern matching needs, see server.matchFolders() */
export interface ListedMailbox {
    path: string;
    namespace: string | false;
    flags: string[];
}

/** A message as the storage option gives it, the server fills in the rest. A string is the message source */
export interface StorageMessage {
    uid?: number | undefined;
    /** a single flag can be given as a string */
    flags?: string | string[] | undefined;
    /** a Date or a date-time string, the current time if not set */
    internaldate?: string | Date | false | undefined;
    raw?: string | Uint8Array | undefined;
    recent?: boolean | undefined;
    [key: string]: any;
}

/** A mailbox as the storage option gives it, the server fills in the rest */
export interface StorageMailbox {
    uid?: number | undefined;
    uidvalidity?: number | undefined;
    uidnext?: number | undefined;
    flags?: string[] | undefined;
    permanentFlags?: string[] | undefined;
    allowPermanentFlags?: boolean | undefined;
    subscribed?: boolean | undefined;
    messages?: (StorageMessage | string)[] | undefined;
    folders?: Record<string, StorageMailbox> | undefined;
    separator?: string | undefined;
    [key: string]: any;
}

export type NamespaceType = 'personal' | 'user' | 'shared';

/** A namespace of the storage option, keyed by its prefix (`"INBOX"`, `""`, `"INBOX."`, ...) */
export interface StorageNamespace extends StorageMailbox {
    separator?: string | undefined;
    type?: NamespaceType | undefined;
}

/** A namespace in `server.storage`, with every key set by the server */
export interface Namespace {
    separator: string;
    type: NamespaceType;
    folders: Record<string, Mailbox>;
    [key: string]: any;
}

/** `server.storage`: the namespaces by prefix, and INBOX, which is a mailbox of its own */
export type ServerStorage = { INBOX: Mailbox } & Record<string, Namespace>;

/** Mailbox counters of `server.getStatus()` */
export interface MailboxStatus {
    /** number of messages by flag */
    flags: Record<string, number>;
    seen: number;
    unseen: number;
    recent: number;
    permanentFlags: string[];
}

export interface UserData {
    password?: string | undefined;
    xoauth2?:
        | {
              accessToken?: string | undefined;
              /**
               * @deprecated kept from hoodiecrow and ignored: access tokens never expire. Change the token with
               * `control.updateUser()` to test a client against an expired one
               */
              sessionTimeout?: number | undefined;
          }
        | undefined;
    [key: string]: any;
}

/** Options of `imapkit(options)` */
export interface IMAPServerOptions {
    /** the mailbox tree, keyed by namespace */
    storage?: Record<string, StorageNamespace> | undefined;
    /** plugin names (`"IDLE"`, `"LITERAL+"`, ...) or plugin functions */
    plugins?: (string | Plugin)[] | string | Plugin | undefined;
    users?: Record<string, UserData> | undefined;
    secureConnection?: boolean | undefined;
    /** starts a second IMAP listener for implicit TLS (IMAPS) with `server.start()`, its sessions share the storage
     * with the main listener. Without a host it listens on the host given to `start()` */
    tls?: { port?: number | undefined; host?: string | undefined } | undefined;
    /** starts an SMTP server with `server.start()` that appends every received message to INBOX, needs the optional
     * smtp-server package */
    smtp?: { port?: number | undefined; host?: string | undefined } | undefined;
    /** starts the REST API with `server.start()`, see src/rest.ts. A host other than a loopback address needs a token */
    rest?: { port?: number | undefined; host?: string | undefined; token?: string | undefined } | undefined;
    credentials?: { key: string | Buffer; cert: string | Buffer } | undefined;
    debug?: boolean | undefined;
    systemFlags?: string[] | undefined;
    /** largest literal accepted after login, in octets */
    maxLiteralSize?: number | undefined;
    /** script rules that make the server misbehave on purpose, see src/script.ts and README "Scripted faults" */
    script?: ScriptRule | ScriptRule[] | undefined;
    /** the current time for the dates the server sets (INTERNALDATE, SAVEDATE): a Date, a timestamp or a function */
    now?: Date | number | (() => Date | number) | undefined;
    /** quirk presets that make the server behave like a known real server, see src/quirks.ts */
    quirks?: string[] | string | undefined;
    /** seed of the random numbers of script rules with `chance`, so that a run can be repeated */
    scriptSeed?: number | undefined;
    [key: string]: any;
}

/**
 * A layer between the socket and the IMAP protocol, such as COMPRESS=DEFLATE. It passes data on with
 * `connection.writeRaw()` and `connection.onData()`
 */
export interface Transport {
    write(data: Buffer): void;
    receive(chunk: Buffer): void;
    end(callback: () => void): void;
    destroy(): void;
}

/** A response code, or a list for a code with arguments (`['MESSAGELIMIT', 1000]`) */
export type ResponseCode = string | (string | number)[];

/** The refusal of a command or a literal, sent as a tagged `command [code] text` */
export interface Refusal {
    command: string;
    code?: string | undefined;
    text: string;
}

/** A refusal of `server.commandChecks`, `command` defaults to BAD */
export interface CommandRefusal {
    command?: string | undefined;
    code?: ResponseCode | undefined;
    text: string;
}

/** A result of `server.appendChecks` (or other checks reported with `connection.applyChecks()`) */
export interface CheckResult {
    code?: ResponseCode | undefined;
    text: string;
    /** only a warning, sent as an untagged NO */
    soft?: boolean | undefined;
}

/** A message that APPEND, REPLACE, COPY or MOVE is about to add to a mailbox */
export interface AppendMessage {
    raw: string;
    flags?: string[] | undefined;
    internaldate?: string | Date | false | undefined;
    [key: string]: any;
}

/** Options of `server.appendChecks`: `{ move, source }` for COPY and MOVE, `{ command, replaced }` for APPEND and REPLACE */
export interface AppendCheckOptions {
    move?: boolean | undefined;
    source?: Mailbox | false | undefined;
    command?: string | undefined;
    replaced?: Message | null | undefined;
    [key: string]: any;
}

type BivariantCallback<T extends (...args: any[]) => any> = { bivarianceHack(...args: Parameters<T>): ReturnType<T> }['bivarianceHack'];

/**
 * `server.outputHandlers`: called with the arguments of every `connection.send()`, can change the response or set
 * `skipResponse`. Handlers may declare narrower parameter types for the responses they act on
 */
export type OutputHandler = BivariantCallback<
    (
        connection: IMAPConnection,
        response: IMAPResponse,
        description: string | undefined,
        parsed: CommandContext | null | undefined,
        data: string | null | undefined,
        ...extra: any[]
    ) => void
>;

/** `server.fetchHandlers`: the value of a FETCH item */
export interface FetchHandler {
    (connection: IMAPConnection, message: Message, query?: Attribute, ...args: any[]): any;
    /** fetching the item sets \Seen like BODY[] */
    setsSeen?: boolean | undefined;
}

/** `server.searchHandlers`: checks a message against a search key, the arguments follow the index */
export interface SearchHandler {
    (connection: IMAPConnection, message: Message, index: number, ...args: any[]): any;
    /** decides the argument types of the key instead of one string per handler parameter */
    argumentTypes?: ((list: Attribute[]) => any[]) | undefined;
}

/** `server.storeHandlers`: applies a STORE item to a message */
export interface StoreHandler {
    (connection: IMAPConnection, message: Message, values: any, index: number, parsed: ParsedCommand, data: string): any;
    /** the values are astrings (X-GM-LABELS), NIL atoms are kept and literals accepted */
    astringValues?: boolean | undefined;
}

/** `server.statusHandlers`: the value of a STATUS item */
export type StatusHandler = (connection: IMAPConnection, mailbox: Mailbox, status: MailboxStatus) => any;

/** `server.fetchFilters` and `server.storeFilters`: false leaves a message out */
export type MessageFilter = (connection: IMAPConnection, message: Message, parsed: ParsedCommand, index: number) => unknown;

/** `server.appendDataHandlers`: parses an append-data extension and returns the function that builds the message source */
export type AppendDataHandler = (connection: IMAPConnection, value: Attribute) => () => string;

export type CapabilityCheck = (connection: IMAPConnection) => boolean;
export type ConnectionHandler = (connection: IMAPConnection) => void;
export type MessageHandler = (server: IMAPServer, message: Message, mailbox: Mailbox) => void;
export type MailboxHandler = (server: IMAPServer, mailbox: Mailbox) => void;
export type CopyHandler = (server: IMAPServer, source: Message, properties: Record<string, any>, mailbox: Mailbox) => void;
export type NotifyFilter = (connection: IMAPConnection, event: NotifyEvent) => boolean;
/** `server.appendChecks`, `connection` is null for the control API (`addMessage` with `checks`) */
export type AppendCheck = (
    connection: IMAPConnection | null,
    mailbox: Mailbox,
    messages: AppendMessage[],
    options: AppendCheckOptions
) => CheckResult | false | null | undefined | void;
export type LiteralFilter = (connection: IMAPConnection, command: string, line: string, size: number) => Refusal | false | null | undefined;
export type UrlAccessCheck = (connection: IMAPConnection, mailbox: Mailbox, url: any) => { text: string } | false | null | undefined;
export type SearchAccessCheck = (connection: IMAPConnection, mailbox: Mailbox, named: boolean) => boolean;
export type CommandCheck = (connection: IMAPConnection, parsed: ParsedCommand) => CommandRefusal | false | null | undefined;
export type RangeLimit = (connection: IMAPConnection, parsed: ParsedCommand, range: MessageRange) => MessageRange | false | null | undefined;
export type SearchLimit = (connection: IMAPConnection, messages: Message[], query: any) => Message[] | false | null | undefined;
export type ClosedCheck = (connection: IMAPConnection) => boolean;
