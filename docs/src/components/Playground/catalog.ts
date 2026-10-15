// The extensions the playground offers, grouped like the pages under docs/extensions. `name` is the plugin name the
// server takes, `label` the capability the client sees. COMPRESS is left out: it needs node:zlib and the browser
// bundle refuses it

export interface Extension {
    name: string;
    /** the capability, when it is not spelled like the plugin name */
    label?: string;
    rfc?: string;
    summary: string;
    doc: string;
}

export interface ExtensionGroup {
    title: string;
    extensions: Extension[];
}

export const GROUPS: ExtensionGroup[] = [
    {
        title: 'Synchronization',
        extensions: [
            { name: 'IDLE', rfc: '2177', summary: 'Push notifications while the client waits', doc: 'synchronization#idle' },
            { name: 'ENABLE', rfc: '5161', summary: 'Turn on extensions per session', doc: 'synchronization#enable' },
            { name: 'CONDSTORE', rfc: '7162', summary: 'Mod-sequences for changed flags', doc: 'synchronization#condstore' },
            { name: 'QRESYNC', rfc: '7162', summary: 'Quick resync with VANISHED responses', doc: 'synchronization#qresync' },
            { name: 'OBJECTID', rfc: '8474', summary: 'Stable EMAILID, THREADID and MAILBOXID', doc: 'synchronization#objectid' },
            { name: 'NOTIFY', rfc: '5465', summary: 'Events from other mailboxes', doc: 'synchronization#notify' },
            { name: 'UIDONLY', rfc: '9586', summary: 'No message sequence numbers', doc: 'synchronization#uidonly' }
        ]
    },
    {
        title: 'Mailboxes',
        extensions: [
            { name: 'NAMESPACE', rfc: '2342', summary: 'Personal, other and shared namespaces', doc: 'mailboxes#namespace' },
            { name: 'LIST-EXTENDED', rfc: '5258', summary: 'LIST selection and return options', doc: 'mailboxes#list-extended' },
            { name: 'LIST-STATUS', rfc: '5819', summary: 'STATUS of every listed mailbox', doc: 'mailboxes#list-status' },
            { name: 'SPECIAL-USE', rfc: '6154', summary: '\\Sent, \\Trash, \\Archive and friends', doc: 'mailboxes#special-use' },
            {
                name: 'CREATE-SPECIAL-USE',
                rfc: '6154',
                summary: 'CREATE with a special-use attribute',
                doc: 'mailboxes#create-special-use'
            },
            { name: 'STATUS-SIZE', label: 'STATUS=SIZE', rfc: '8438', summary: 'Mailbox size in STATUS', doc: 'mailboxes#statussize' },
            { name: 'UNSELECT', rfc: '3691', summary: 'Close a mailbox without expunging', doc: 'mailboxes#unselect' }
        ]
    },
    {
        title: 'Messages',
        extensions: [
            { name: 'MOVE', rfc: '6851', summary: 'Move messages between mailboxes', doc: 'messages#move' },
            { name: 'UIDPLUS', rfc: '4315', summary: 'APPENDUID, COPYUID and UID EXPUNGE', doc: 'messages#uidplus' },
            { name: 'MULTIAPPEND', rfc: '3502', summary: 'Several messages in one APPEND', doc: 'messages#multiappend' },
            { name: 'CATENATE', rfc: '4469', summary: 'Build a message from parts of others', doc: 'messages#catenate' },
            { name: 'REPLACE', rfc: '8508', summary: 'Replace a message in one step', doc: 'messages#replace' },
            { name: 'APPENDLIMIT', rfc: '7889', summary: 'Largest message APPEND takes', doc: 'messages#appendlimit' },
            { name: 'BINARY', rfc: '3516', summary: 'Decoded body parts', doc: 'messages#binary' },
            { name: 'PREVIEW', rfc: '8970', summary: 'Short text previews of messages', doc: 'messages#preview' },
            { name: 'SAVEDATE', rfc: '8514', summary: 'When a message was saved', doc: 'messages#savedate' },
            { name: 'MESSAGELIMIT', rfc: '9738', summary: 'Cap messages per command', doc: 'messages#messagelimit-and-savelimit' },
            { name: 'SAVELIMIT', rfc: '9738', summary: 'Cap saved search results', doc: 'messages#messagelimit-and-savelimit' },
            { name: 'UTF8-ACCEPT', label: 'UTF8=ACCEPT', rfc: '9755', summary: 'UTF-8 in headers and names', doc: 'messages#utf8accept' },
            { name: 'LITERALPLUS', label: 'LITERAL+', rfc: '7888', summary: 'Literals without waiting for +', doc: 'messages#literal-and-literal-' },
            { name: 'LITERALMINUS', label: 'LITERAL-', rfc: '7888', summary: 'Small non-synchronizing literals', doc: 'messages#literal-and-literal-' }
        ]
    },
    {
        title: 'Search and sort',
        extensions: [
            { name: 'ESEARCH', rfc: '4731', summary: 'MIN, MAX, COUNT and ALL results', doc: 'search-and-sort#esearch' },
            { name: 'SEARCHRES', rfc: '5182', summary: 'Reuse a result as $', doc: 'search-and-sort#searchres' },
            { name: 'SORT', rfc: '5256', summary: 'Server side sorting', doc: 'search-and-sort#sort' },
            { name: 'SORT-DISPLAY', label: 'SORT=DISPLAY', rfc: '5957', summary: 'Sort by display names', doc: 'search-and-sort#sortdisplay' },
            { name: 'ESORT', rfc: '5267', summary: 'ESEARCH style SORT results', doc: 'search-and-sort#esort' },
            {
                name: 'THREAD-REFERENCES',
                label: 'THREAD=REFERENCES',
                rfc: '5256',
                summary: 'Threads from References headers',
                doc: 'search-and-sort#thread'
            },
            {
                name: 'THREAD-ORDEREDSUBJECT',
                label: 'THREAD=ORDEREDSUBJECT',
                rfc: '5256',
                summary: 'Threads by subject',
                doc: 'search-and-sort#thread'
            },
            {
                name: 'CONTEXT-SEARCH',
                label: 'CONTEXT=SEARCH',
                rfc: '5267',
                summary: 'Live updating search results',
                doc: 'search-and-sort#contextsearch-and-contextsort'
            },
            {
                name: 'CONTEXT-SORT',
                label: 'CONTEXT=SORT',
                rfc: '5267',
                summary: 'Live updating sort results',
                doc: 'search-and-sort#contextsearch-and-contextsort'
            },
            { name: 'PARTIAL', rfc: '9394', summary: 'Paged search results', doc: 'search-and-sort#partial' },
            { name: 'MULTISEARCH', rfc: '7377', summary: 'Search several mailboxes', doc: 'search-and-sort#multisearch' }
        ]
    },
    {
        title: 'Authentication and session',
        extensions: [
            { name: 'AUTH-PLAIN', label: 'AUTH=PLAIN', rfc: '4616', summary: 'SASL PLAIN login', doc: 'authentication-and-transport#authplain' },
            { name: 'SASL-IR', rfc: '4959', summary: 'Initial response in AUTHENTICATE', doc: 'authentication-and-transport#sasl-ir' },
            { name: 'XOAUTH2', label: 'AUTH=XOAUTH2', summary: 'Google style OAuth 2.0 login', doc: 'authentication-and-transport#xoauth2' },
            { name: 'OAUTHBEARER', label: 'AUTH=OAUTHBEARER', rfc: '7628', summary: 'OAuth 2.0 bearer login', doc: 'authentication-and-transport#oauthbearer' },
            {
                name: 'LOGINDISABLED',
                rfc: '3501',
                summary: 'No LOGIN on plaintext connections',
                doc: 'authentication-and-transport#logindisabled'
            },
            { name: 'STARTTLS', rfc: '3501', summary: 'Upgrade a plaintext connection', doc: 'authentication-and-transport#starttls' },
            {
                name: 'UNAUTHENTICATE',
                rfc: '8437',
                summary: 'Log out without disconnecting',
                doc: 'authentication-and-transport#unauthenticate'
            },
            { name: 'ID', rfc: '2971', summary: 'Client and server identification', doc: 'authentication-and-transport#id' }
        ]
    },
    {
        title: 'Metadata, quota and access',
        extensions: [
            { name: 'METADATA', rfc: '5464', summary: 'Annotations on mailboxes', doc: 'metadata-and-quota#metadata' },
            { name: 'METADATA-SERVER', rfc: '5464', summary: 'Server annotations only', doc: 'metadata-and-quota#metadata-server' },
            { name: 'QUOTA', rfc: '9208', summary: 'Storage and message quotas', doc: 'metadata-and-quota#quota' },
            { name: 'ACL', rfc: '4314', summary: 'Access rights per mailbox', doc: 'access-control' }
        ]
    },
    {
        title: 'Protocol versions and vendors',
        extensions: [
            { name: 'IMAP4REV2', label: 'IMAP4rev2', rfc: '9051', summary: 'The current IMAP version, via ENABLE', doc: 'imap4rev2' },
            { name: 'X-GM-EXT-1', summary: 'Gmail labels, message and thread IDs', doc: 'gmail' }
        ]
    }
];

export const ALL_EXTENSIONS: Extension[] = GROUPS.flatMap(group => group.extensions);

export const labelOf = (name: string): string => ALL_EXTENSIONS.find(extension => extension.name === name)?.label || name;

// plugins that load other plugins, see docs/extensions/overview "Plugins that load other plugins"
export const IMPLIES: Record<string, string[]> = {
    IMAP4REV2: [
        'ENABLE',
        'NAMESPACE',
        'UNSELECT',
        'UIDPLUS',
        'ESEARCH',
        'SEARCHRES',
        'IDLE',
        'SASL-IR',
        'LIST-EXTENDED',
        'LIST-STATUS',
        'MOVE',
        'BINARY',
        'SPECIAL-USE',
        'STATUS-SIZE',
        'AUTH-PLAIN',
        'LITERALMINUS'
    ],
    QRESYNC: ['ENABLE', 'CONDSTORE'],
    UIDONLY: ['ENABLE'],
    'UTF8-ACCEPT': ['ENABLE'],
    METADATA: ['ENABLE'],
    'METADATA-SERVER': ['ENABLE'],
    SEARCHRES: ['ESEARCH'],
    PARTIAL: ['ESEARCH'],
    MULTISEARCH: ['ESEARCH'],
    'CONTEXT-SEARCH': ['ESEARCH'],
    ESORT: ['SORT', 'ESEARCH'],
    'CONTEXT-SORT': ['ESORT', 'SORT', 'ESEARCH', 'CONTEXT-SEARCH'],
    'SORT-DISPLAY': ['SORT'],
    'LIST-STATUS': ['LIST-EXTENDED']
};

// extensions that can not be loaded together (docs/extensions/overview "Combinations that throw")
export const CONFLICTS: Record<string, string> = {
    LITERALPLUS: 'LITERALMINUS',
    LITERALMINUS: 'LITERALPLUS',
    MESSAGELIMIT: 'SAVELIMIT',
    SAVELIMIT: 'MESSAGELIMIT'
};

export interface Preset {
    id: string;
    label: string;
    description: string;
    extensions: string[];
}

export const RECOMMENDED = [
    'IDLE',
    'ENABLE',
    'CONDSTORE',
    'NAMESPACE',
    'LIST-EXTENDED',
    'LIST-STATUS',
    'SPECIAL-USE',
    'UNSELECT',
    'MOVE',
    'UIDPLUS',
    'LITERALPLUS',
    'ESEARCH',
    'SORT',
    'THREAD-REFERENCES',
    'ID'
];

export const PRESETS: Preset[] = [
    { id: 'recommended', label: 'Modern server', description: 'What most IMAP servers offer today', extensions: RECOMMENDED },
    { id: 'imap4rev2', label: 'IMAP4rev2', description: 'RFC 9051 and everything it folds in', extensions: ['IMAP4REV2'] },
    {
        id: 'gmail',
        label: 'Gmail-like',
        description: 'Close to what imap.gmail.com advertises',
        extensions: [...RECOMMENDED, 'X-GM-EXT-1', 'XOAUTH2', 'AUTH-PLAIN']
    },
    { id: 'minimal', label: 'Bare IMAP4rev1', description: 'RFC 3501 only, no extensions', extensions: [] },
    {
        id: 'everything',
        label: 'Everything',
        description: 'Every extension that can run together',
        extensions: ALL_EXTENSIONS.map(extension => extension.name).filter(name => name !== 'LITERALMINUS' && name !== 'SAVELIMIT' && name !== 'LOGINDISABLED')
    }
];

/**
 * Extends a selection with what its extensions load, as `{ name: loaded by }`
 */
export function impliedBy(selected: Set<string>): Map<string, string> {
    const implied = new Map<string, string>();
    for (const name of selected) {
        for (const other of IMPLIES[name] || []) {
            // IMAP4rev2 loads LITERAL- only without LITERAL+
            if (other === 'LITERALMINUS' && selected.has('LITERALPLUS')) {
                continue;
            }
            if (!selected.has(other) && !implied.has(other)) {
                implied.set(other, name);
            }
        }
    }
    return implied;
}
