import createServer, { TAG_REGEX, IMAPServer, IMAPConnection } from './server.js';
import { ImapKitError } from './control.js';
import { quirks } from './quirks.js';
import { storageSchema, validateStorage } from './storage-schema.js';

export { TAG_REGEX, IMAPServer, IMAPConnection, ImapKitError, quirks, storageSchema, validateStorage };

export type {
    Attribute,
    ParsedCommand,
    IMAPResponse,
    Notification,
    Callback,
    CommandHandler,
    CommandOptions,
    Plugin,
    IMAPError,
    Message,
    Mailbox,
    StorageNamespace,
    UserData,
    IMAPServerOptions
} from './types.js';
export type { ScriptRule, ScriptContext, ScriptEvent, ScriptBytes, ScriptHandle } from './script.js';
export type { Quirk } from './quirks.js';
export type { MemorySocket } from './memory-socket.js';
export type { Control, MailboxInfo, MessageInfo, SessionInfo, NewMessage, UserOptions, SessionFilter, ControlRoute, RouteRequest } from './control.js';
export type { FlagMode, UidMode, UidValidityOptions } from './store-operations.js';

// `imapkit(options)` creates a server. TAG_REGEX was a property of the CommonJS export, it and the
// classes are properties of the factory with both module formats
const imapkit = Object.assign(createServer, { TAG_REGEX, IMAPServer, IMAPConnection, ImapKitError, quirks });

export default imapkit;
