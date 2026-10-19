import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import { ALL_EXTENSIONS, CONFLICTS, GROUPS, PRESETS, RECOMMENDED, impliedBy, labelOf } from './catalog';
import { COMMANDS, TerminalSession } from './session';
import type { ImapKitFactory, ImapServer } from './session';
import { APPEND_COMMAND, STORAGE } from './storage';
import StorageManager, { hasFiles, treeOrder, uploadFiles, useServerChanges } from './StorageManager';
import { decodeMailboxName } from './mail';
import styles from './styles.module.css';

const MAX_SESSIONS = 4;
const KNOWN = new Set(ALL_EXTENSIONS.map(extension => extension.name));

interface Config {
    extensions: string[];
    secure: boolean;
    autoTag: boolean;
}

interface Suggestion {
    label: string;
    command: string;
    hint?: string;
}

function sameSet(list: string[], set: Set<string>): boolean {
    return list.length === set.size && list.every(name => set.has(name));
}

/** Reads the setup from the URL: ?ext=IDLE,MOVE (or ext=none), &tls=0, &tags=0 (&sessions=2 opens more sessions) */
function readConfig(): Config {
    const params = new URLSearchParams(window.location.search);
    let extensions = RECOMMENDED;
    const ext = params.get('ext');
    if (ext !== null) {
        extensions =
            ext === 'none'
                ? []
                : ext
                      .split(',')
                      .map(name => name.trim().toUpperCase())
                      .filter(name => KNOWN.has(name));
    }
    return { extensions, secure: params.get('tls') !== '0', autoTag: params.get('tags') !== '0' };
}

/** Puts the setup into the URL, so the address bar is a link to the same setup. The defaults stay out */
function writeConfig(config: Config): void {
    const params = new URLSearchParams(window.location.search);
    if (sameSet(RECOMMENDED, new Set(config.extensions))) {
        params.delete('ext');
    } else {
        params.set('ext', config.extensions.length ? config.extensions.join(',') : 'none');
    }
    if (config.secure) {
        params.delete('tls');
    } else {
        params.set('tls', '0');
    }
    if (config.autoTag) {
        params.delete('tags');
    } else {
        params.set('tags', '0');
    }
    // commas stay readable in the address bar
    const query = params.toString().replace(/%2C/gi, ',');
    window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
}

/** What makes sense to try next, for the state of a session */
function suggestionsFor(session: TerminalSession, loaded: Set<string>): Suggestion[] {
    if (session.closed) {
        return [];
    }
    if (session.awaitingContinuation) {
        return session.idling ? [{ label: 'DONE', command: 'DONE', hint: 'End IDLE' }] : [];
    }
    const list: Suggestion[] = [];
    const add = (command: string, hint?: string, label?: string) => list.push({ command, hint, label: label || command });
    const { state } = session.info;
    if (state === 'Not Authenticated') {
        if (!session.info.secure && loaded.has('STARTTLS')) {
            add('STARTTLS', 'Turn on encryption first');
        }
        add('LOGIN testuser testpass', 'Log in as the test user');
        add('CAPABILITY', 'What does the server support?');
        if (loaded.has('AUTH-PLAIN')) {
            add('AUTHENTICATE PLAIN AHRlc3R1c2VyAHRlc3RwYXNz', 'SASL PLAIN with an initial response');
        }
        if (loaded.has('ID')) {
            add('ID ("name" "playground")', 'Tell the server who you are');
        }
    } else if (state === 'Authenticated') {
        add('LIST "" "*"', 'Every mailbox');
        add('SELECT INBOX', 'Open INBOX');
        add('EXAMINE INBOX', 'Open INBOX read-only');
        add('STATUS INBOX (MESSAGES UNSEEN UIDNEXT)', 'Counts without selecting');
        if (loaded.has('NAMESPACE')) {
            add('NAMESPACE');
        }
        if (loaded.has('SPECIAL-USE') && loaded.has('LIST-EXTENDED')) {
            add('LIST (SPECIAL-USE) "" "*"', 'Only the special-use mailboxes');
        }
        if (loaded.has('LIST-STATUS')) {
            add('LIST "" "%" RETURN (STATUS (MESSAGES UNSEEN))', 'LIST with STATUS');
        }
        if (loaded.has('ENABLE') && loaded.has('QRESYNC')) {
            add('ENABLE QRESYNC');
        } else if (loaded.has('ENABLE') && loaded.has('CONDSTORE')) {
            add('ENABLE CONDSTORE');
        }
        if (loaded.has('ENABLE') && loaded.has('IMAP4REV2')) {
            add('ENABLE IMAP4rev2', 'Switch the session to IMAP4rev2');
        }
        add('CREATE Projects/Ideas', 'New mailbox');
        if (loaded.has('QUOTA')) {
            add('GETQUOTAROOT INBOX');
        }
        add('LOGOUT');
    } else if (state === 'Selected') {
        add('FETCH 1:* (FLAGS ENVELOPE)', 'Who sent what');
        add('FETCH 4 BODYSTRUCTURE', 'The MIME tree of a message');
        add('UID FETCH 1 BODY.PEEK[]', 'A whole message, without setting \\Seen');
        add('SEARCH UNSEEN', 'Unread messages');
        add('STORE 2 +FLAGS (\\Seen)', 'Mark a message read');
        if (!session.info.readOnly) {
            add(APPEND_COMMAND, 'Upload a message with a literal', 'APPEND INBOX {…}');
        }
        if (loaded.has('IDLE')) {
            add('IDLE', 'Wait for changes, then open a second session');
        }
        if (loaded.has('MOVE')) {
            add('MOVE 1 Archive', 'Move a message');
        } else {
            add('COPY 1 Archive', 'Copy a message');
        }
        if (loaded.has('SORT')) {
            add('SORT (REVERSE DATE) UTF-8 ALL', 'Newest first');
        }
        if (loaded.has('THREAD-REFERENCES')) {
            add('THREAD REFERENCES UTF-8 ALL', 'Conversations');
        }
        if (loaded.has('ESEARCH')) {
            add('SEARCH RETURN (MIN MAX COUNT) ALL', 'ESEARCH result options');
        }
        if (loaded.has('PREVIEW')) {
            add('FETCH 1:* (PREVIEW)', 'Message previews');
        }
        if (loaded.has('CONDSTORE') || loaded.has('QRESYNC')) {
            add('FETCH 1:* (MODSEQ FLAGS)', 'Mod-sequences');
        }
        add('STORE 1 +FLAGS (\\Deleted)', 'Flag for deletion');
        add('EXPUNGE', 'Remove \\Deleted messages');
        add('CLOSE', 'Leave the mailbox');
        add('LOGOUT');
    }
    return list;
}

const SHARED_NOTE = ' shares the mailbox with the other sessions. Changes made in one show up in the others.';

/** Opens a session to the server with the connection settings of a setup, and prints the notes at its top */
function connectSession(server: ImapServer, config: Config, onChange: () => void, ...notes: string[]): TerminalSession {
    const session = new TerminalSession(server, { secure: config.secure, autoTag: config.autoTag }, onChange);
    notes.forEach(note => session.note(note.replace('$N', String(session.number))));
    return session;
}

function loadBundle(url: string): Promise<ImapKitFactory> {
    // a plain ES module from static/, kept out of the webpack build
    return import(/* webpackIgnore: true */ url).then((mod: { default: ImapKitFactory }) => mod.default);
}

export default function Playground(): ReactNode {
    const bundleUrl = useBaseUrl('/live/imapkit.js');
    const [factory, setFactory] = useState<ImapKitFactory | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [config, setConfig] = useState<Config>(() => readConfig());
    const [server, setServer] = useState<ImapServer | null>(null);
    const [serverError, setServerError] = useState<string | null>(null);
    const [sessions, setSessions] = useState<TerminalSession[]>([]);
    const [focusedNumber, setFocusedNumber] = useState(0);
    const [panel, setPanel] = useState<'setup' | 'help' | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const [tab, setTab] = useState<'terminal' | 'storage'>('terminal');
    // the folder of the storage tab, where uploads go
    const [folder, setFolder] = useState('INBOX');
    const [fileDrag, setFileDrag] = useState(false);
    const dragDepth = useRef(0);
    const [, setTick] = useState(0);
    const rerender = useCallback(() => setTick(tick => tick + 1), []);
    // the server and its sessions for event handlers, which outlive a render
    const serverRef = useRef<ImapServer | null>(null);
    const sessionsRef = useRef<TerminalSession[]>([]);
    sessionsRef.current = sessions;

    useEffect(() => {
        loadBundle(bundleUrl).then(
            imapkit => setFactory(() => imapkit),
            err => setLoadError(err.message)
        );
    }, [bundleUrl]);

    const loaded = useMemo(() => {
        const set = new Set(config.extensions);
        for (const name of impliedBy(set).keys()) {
            set.add(name);
        }
        return set;
    }, [config.extensions]);

    /** Starts a fresh server for a setup and opens sessions to it */
    const start = useCallback(
        (next: Config, notice?: string, count = 1) => {
            if (!factory) {
                return;
            }
            sessionsRef.current.forEach(session => session.destroy());
            serverRef.current?.close(() => false);
            serverRef.current = null;
            setSessions([]);
            let created: ImapServer;
            try {
                created = factory({ plugins: next.extensions, storage: STORAGE });
            } catch (err) {
                setServer(null);
                setServerError((err as Error).message);
                return;
            }
            setServerError(null);
            // the session events keep the status bar of each pane up to date
            created.on('session', event => {
                sessionsRef.current.find(session => session.server === created && session.number === event.session.session)?.update(event.session);
            });
            serverRef.current = created;
            setServer(created);
            const first = connectSession(
                created,
                next,
                rerender,
                ...(notice ? [notice] : []),
                'Connected to an ImapKit server running in this tab (' +
                    (next.secure ? 'encrypted, as over TLS' : 'plaintext') +
                    '). Nothing leaves your browser.',
                'Type an IMAP command, or pick one below. Each line starts with the next tag, edit or delete it like any other text. Start with: LOGIN testuser testpass'
            );
            const opened = [first];
            while (opened.length < count) {
                opened.push(connectSession(created, next, rerender, 'Session $N' + SHARED_NOTE));
            }
            setSessions(opened);
            setFocusedNumber(first.number);
        },
        [factory, rerender]
    );

    useEffect(() => {
        if (factory) {
            // the server starts once the bundle is there, later changes go through apply()
            const count = Number(new URLSearchParams(window.location.search).get('sessions')) || 1;
            start(config, undefined, Math.max(1, Math.min(MAX_SESSIONS, count)));
        }
    }, [factory]);

    useEffect(() => {
        if (!toast) {
            return;
        }
        const timer = setTimeout(() => setToast(null), Math.max(2200, toast.length * 60));
        return () => clearTimeout(timer);
    }, [toast]);

    const apply = (next: Config) => {
        setConfig(next);
        writeConfig(next);
        setPanel(null);
        start(next, 'Server restarted with ' + (next.extensions.length ? next.extensions.length + ' extensions' : 'no extensions') + ' and fresh sample data.');
    };

    const openSession = () => {
        if (!server || sessions.length >= MAX_SESSIONS) {
            return;
        }
        const session = connectSession(server, config, rerender, 'Session $N' + SHARED_NOTE);
        setSessions(current => [...current, session]);
        setFocusedNumber(session.number);
    };

    const reconnect = (old: TerminalSession) => {
        if (!server) {
            return;
        }
        const session = connectSession(server, config, rerender, 'Reconnected as session $N.');
        setSessions(current => current.map(item => (item === old ? session : item)));
        setFocusedNumber(session.number);
    };

    const closeSession = (session: TerminalSession) => {
        session.destroy();
        const rest = sessions.filter(item => item !== session);
        setSessions(rest);
        if (rest.length && session.number === focusedNumber) {
            setFocusedNumber(rest[rest.length - 1].number);
        }
    };

    const copyTranscript = () => {
        const text = sessions.map(session => (sessions.length > 1 ? '# Session ' + session.number + '\n' : '') + session.transcript()).join('\n');
        navigator.clipboard.writeText(text).then(
            () => setToast('Transcript copied'),
            () => setToast('Could not copy, select the text instead')
        );
    };

    const upload = (files: File[], target: string) => {
        if (!server) {
            return;
        }
        uploadFiles(server.control, files, target).then(setToast, (err: Error) => setToast(err.message));
    };

    // .eml files dropped anywhere on the page go to the folder of the storage tab, a folder in the tree takes its own
    const dragHandlers = {
        onDragEnter: (event: DragEvent) => {
            if (hasFiles(event) && server) {
                dragDepth.current++;
                setFileDrag(true);
            }
        },
        onDragLeave: (event: DragEvent) => {
            if (hasFiles(event) && --dragDepth.current <= 0) {
                dragDepth.current = 0;
                setFileDrag(false);
            }
        },
        onDragOver: (event: DragEvent) => {
            if (hasFiles(event) && server) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
            }
        },
        onDrop: (event: DragEvent) => {
            dragDepth.current = 0;
            setFileDrag(false);
            if (hasFiles(event) && server) {
                event.preventDefault();
                upload(Array.from(event.dataTransfer.files), folder);
            }
        }
    };

    const openFolder = (path: string) => {
        setFolder(path);
        setTab('storage');
        setPanel(null);
    };

    const focused = sessions.find(session => session.number === focusedNumber) || sessions[0];
    const suggestions = focused ? suggestionsFor(focused, loaded) : [];
    const ready = !!factory && !!server;

    return (
        <div className={clsx(styles.app, fileDrag && styles.fileDrag)} {...dragHandlers}>
            <div className={styles.toolbar}>
                <div className={styles.titleBlock}>
                    <h1 className={styles.title}>Try ImapKit live</h1>
                    <p className={styles.subtitle}>A real IMAP server, running in your browser. Type commands and see what the server answers.</p>
                </div>
                <div className={styles.actions}>
                    <button type="button" className={styles.button} onClick={() => setPanel('setup')} disabled={!factory} aria-haspopup="dialog">
                        <span>Extensions</span>
                        <span className={styles.count}>{loaded.size}</span>
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        onClick={openSession}
                        disabled={!ready || sessions.length >= MAX_SESSIONS}
                        title={sessions.length >= MAX_SESSIONS ? 'Up to ' + MAX_SESSIONS + ' sessions' : 'Open another connection to the same server'}
                    >
                        New session
                    </button>
                    <button
                        type="button"
                        className={styles.button}
                        onClick={() => start(config, 'Server restarted with fresh sample data.')}
                        disabled={!factory}
                        title="Start over with fresh sample data"
                    >
                        Restart server
                    </button>
                    <button type="button" className={styles.button} onClick={copyTranscript} disabled={!sessions.length}>
                        Copy transcript
                    </button>
                    <button type="button" className={clsx(styles.button, styles.helpButton)} onClick={() => setPanel('help')} aria-haspopup="dialog">
                        Help
                    </button>
                </div>
            </div>

            <div className={styles.body}>
                <div className={styles.main}>
                    {loadError && (
                        <div className={styles.banner} role="alert">
                            The in-browser server could not be loaded ({loadError}). Reload the page to try again.
                        </div>
                    )}
                    {serverError && (
                        <div className={styles.banner} role="alert">
                            The server did not start: {serverError}{' '}
                            <button type="button" className={styles.linkButton} onClick={() => setPanel('setup')}>
                                Change extensions
                            </button>
                        </div>
                    )}
                    {!factory && !loadError && <div className={clsx(styles.pane, styles.loading)}>Starting the server…</div>}
                    {server && (
                        <div className={styles.tabs} role="tablist" aria-label="View">
                            <button
                                type="button"
                                role="tab"
                                id="pg-tab-terminal"
                                aria-selected={tab === 'terminal'}
                                aria-controls="pg-panel-terminal"
                                className={clsx(styles.tab, tab === 'terminal' && styles.tabActive)}
                                onClick={() => setTab('terminal')}
                            >
                                Terminal
                                <span className={styles.tabMeta}>{sessions.length === 1 ? '1 session' : sessions.length + ' sessions'}</span>
                            </button>
                            <button
                                type="button"
                                role="tab"
                                id="pg-tab-storage"
                                aria-selected={tab === 'storage'}
                                aria-controls="pg-panel-storage"
                                className={clsx(styles.tab, tab === 'storage' && styles.tabActive)}
                                onClick={() => setTab('storage')}
                            >
                                Mail storage
                                <span className={styles.tabMeta}>folders and .eml files</span>
                            </button>
                        </div>
                    )}
                    {server && tab === 'storage' && (
                        <div id="pg-panel-storage" role="tabpanel" aria-labelledby="pg-tab-storage">
                            <StorageManager server={server} folder={folder} onFolder={setFolder} onUpload={upload} notify={setToast} />
                        </div>
                    )}
                    {/* the terminals stay mounted on the storage tab, the sessions keep running */}
                    <div id="pg-panel-terminal" role="tabpanel" aria-labelledby="pg-tab-terminal" className={styles.terminalPanel} hidden={tab !== 'terminal'}>
                        <div className={clsx(styles.panes, sessions.length > 1 && styles.split)}>
                            {sessions.map(session => (
                                <TerminalPane
                                    key={session.id}
                                    session={session}
                                    focused={session === focused}
                                    multiple={sessions.length > 1}
                                    onFocus={() => setFocusedNumber(session.number)}
                                    onReconnect={() => reconnect(session)}
                                    onClose={() => closeSession(session)}
                                />
                            ))}
                        </div>
                        {suggestions.length > 0 && (
                            <div className={styles.suggestions} aria-label="Suggested commands">
                                <span className={styles.suggestionsLabel}>{sessions.length > 1 ? 'Try in session ' + focused.number : 'Try'}</span>
                                <div className={styles.chips}>
                                    {suggestions.map((suggestion, index) => (
                                        <button
                                            type="button"
                                            key={suggestion.command}
                                            className={clsx(styles.chip, index === 0 && focused.info.state === 'Not Authenticated' && styles.chipPrimary)}
                                            title={(suggestion.hint ? suggestion.hint + ': ' : '') + suggestion.command.split('\r\n')[0]}
                                            onClick={() => {
                                                focused.runCommand(suggestion.command);
                                                focused.focusInput?.();
                                            }}
                                        >
                                            {suggestion.label}
                                        </button>
                                    ))}
                                    {focused.idling && sessions.length === 1 && (
                                        <button type="button" className={clsx(styles.chip, styles.chipAction)} onClick={openSession}>
                                            Open a second session to make changes
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                <aside className={styles.aside}>
                    <HelpContent server={server} onOpen={openFolder} />
                </aside>
            </div>

            {panel === 'setup' && <SetupPanel config={config} onApply={apply} onClose={() => setPanel(null)} />}
            {panel === 'help' && (
                <Drawer title="Help" onClose={() => setPanel(null)}>
                    <HelpContent server={server} onOpen={openFolder} />
                </Drawer>
            )}
            {fileDrag && (
                <div className={styles.dropHint} aria-hidden="true">
                    Drop .eml files to add them to {decodeMailboxName(folder)}
                    {tab === 'storage' ? ', or on a folder' : ''}
                </div>
            )}
            {toast && (
                <div className={styles.toast} role="status">
                    {toast}
                </div>
            )}
        </div>
    );
}

function TerminalPane(props: {
    session: TerminalSession;
    focused: boolean;
    multiple: boolean;
    onFocus: () => void;
    onReconnect: () => void;
    onClose: () => void;
}): ReactNode {
    const { session, focused, multiple } = props;
    const outputRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    // the line starts with the next tag, an ordinary part of the text that can be edited or deleted
    const prefill = prefillFor(session);
    const [value, setValue] = useState(session.draft || prefill);
    const lastPrefill = useRef(prefill);
    const historyIndex = useRef(-1);
    // what was typed before stepping into the history
    const stash = useRef('');

    session.focusInput = () => inputRef.current?.focus();

    useEffect(() => {
        if (outputRef.current) {
            session.attach(outputRef.current);
        }
    }, [session]);

    useEffect(() => {
        // phones open the keyboard on focus, there the user taps the prompt
        if (focused && !window.matchMedia('(pointer: coarse)').matches) {
            inputRef.current?.focus({ preventScroll: true });
        }
    }, [focused, session]);

    useEffect(() => {
        // typing on an untouched line goes after the tag, a textarea starts with the caret at the beginning
        const input = inputRef.current;
        if (input && value === prefill) {
            input.setSelectionRange(value.length, value.length);
        }
    }, [value, prefill]);

    useEffect(() => {
        const input = inputRef.current;
        if (input) {
            input.style.height = 'auto';
            input.style.height = input.scrollHeight + 'px';
        }
        session.draft = value;
    }, [value, session]);

    useEffect(() => {
        // an untouched line follows the prompt: the next tag, nothing while the server waits for a continuation
        if (prefill !== lastPrefill.current) {
            setValue(current => (current === lastPrefill.current ? prefill : current));
            lastPrefill.current = prefill;
        }
    }, [prefill]);

    const resetLine = (next = prefillFor(session)) => {
        lastPrefill.current = next;
        historyIndex.current = -1;
        setValue(next);
    };

    // a line from the history gets the next tag in place of the one it was sent with
    const recall = (line: string) => (prefill ? line.replace(/^A\d+ /, prefill) : line);

    const submit = () => {
        if (session.closed) {
            props.onReconnect();
            return;
        }
        if (!value.trim() || (value === prefill && !session.awaitingContinuation)) {
            return;
        }
        session.run(value);
        resetLine();
        session.scrollToBottom();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        const multiline = value.includes('\n');
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
        } else if (event.key === 'ArrowUp' && !multiline && session.history.length) {
            event.preventDefault();
            if (historyIndex.current < 0) {
                stash.current = value;
            }
            historyIndex.current = historyIndex.current < 0 ? session.history.length - 1 : Math.max(0, historyIndex.current - 1);
            setValue(recall(session.history[historyIndex.current]));
        } else if (event.key === 'ArrowDown' && !multiline && historyIndex.current >= 0) {
            event.preventDefault();
            historyIndex.current++;
            if (historyIndex.current >= session.history.length) {
                historyIndex.current = -1;
                setValue(stash.current);
            } else {
                setValue(recall(session.history[historyIndex.current]));
            }
        } else if (event.key === 'Tab' && !event.shiftKey && !session.awaitingContinuation) {
            // completes the command name after the tag, or the first word of a line without one
            const [, tag = '', word = ''] = /^(\S+ +)?(\S+)$/.exec(value) || [];
            const matches = word ? COMMANDS.filter(command => command.startsWith(word.toUpperCase())) : [];
            if (matches.length) {
                event.preventDefault();
                setValue(tag + (matches.length === 1 ? matches[0] + ' ' : commonPrefix(matches)));
            }
        } else if (event.key === 'l' && event.ctrlKey) {
            event.preventDefault();
            session.clear();
        } else if (event.key === 'c' && event.ctrlKey && !window.getSelection()?.toString()) {
            event.preventDefault();
            resetLine();
        }
    };

    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        // a pasted line with its own tag replaces the untouched prefilled one, no "A1 A1 LOGIN"
        const text = event.clipboardData.getData('text');
        const input = event.currentTarget;
        if (prefill && value === prefill && input.selectionStart === prefill.length && /^\S+ +[A-Za-z]/.test(text)) {
            const [tag, command = ''] = text.trim().split(/\s+/);
            if (!COMMANDS.includes(tag.toUpperCase()) && COMMANDS.includes(command.toUpperCase())) {
                event.preventDefault();
                setValue(text.replace(/\r?\n$/, ''));
            }
        }
    };

    const focusPrompt = () => {
        props.onFocus();
        // a click that selected text keeps the selection
        if (!window.getSelection()?.toString()) {
            inputRef.current?.focus({ preventScroll: true });
        }
    };

    const info = session.info;
    const placeholder = session.closed
        ? 'Press Enter to reconnect'
        : session.awaitingContinuation
          ? session.idling
              ? 'Type DONE to stop idling'
              : 'The server waits for continuation data'
          : info.state === 'Not Authenticated'
            ? 'LOGIN testuser testpass'
            : 'Type a command, Tab completes';
    // the first word of a command line is its tag, whatever it is: a deleted tag shows that the command became the tag
    const [, tagText = '', rest = value] = !session.closed && !session.awaitingContinuation ? /^(\S+)([\s\S]*)$/.exec(value) || [] : [];

    return (
        <section className={clsx(styles.pane, focused && multiple && styles.focusedPane)} aria-label={'Session ' + session.number}>
            <header className={styles.statusBar}>
                <span className={clsx(styles.dot, session.closed ? styles.dotClosed : styles.dotOpen)} aria-hidden="true" />
                <span className={styles.sessionName}>Session {session.number}</span>
                <span className={styles.status}>
                    {session.closed ? (
                        'Disconnected'
                    ) : (
                        <>
                            <span>{info.state}</span>
                            {info.user && <span>{info.user}</span>}
                            {info.mailbox && <span>{info.mailbox + (info.readOnly ? ' (read-only)' : '')}</span>}
                            {session.idling && <span className={styles.idling}>idling</span>}
                        </>
                    )}
                </span>
                <span className={styles.secure} title={info.secure ? 'The session counts as encrypted' : 'Plaintext session'}>
                    {info.secure ? 'TLS' : 'plain'}
                </span>
                {multiple && (
                    <button type="button" className={styles.closeButton} onClick={props.onClose} aria-label={'Close session ' + session.number}>
                        ×
                    </button>
                )}
            </header>
            <div className={styles.screen} onClick={focusPrompt}>
                <div className={styles.output} ref={outputRef} role="log" aria-live="polite" />
                <div className={styles.promptRow}>
                    <span className={clsx(styles.prompt, session.awaitingContinuation && styles.promptContinue)} aria-hidden="true">
                        {session.closed ? '⏎' : session.awaitingContinuation ? '+' : '›'}
                    </span>
                    <div className={styles.inputWrap}>
                        {/* the text of the line, drawn under the transparent textarea to color the tag */}
                        <div className={styles.inputMirror} aria-hidden="true">
                            {tagText && <span className={styles.inputTag}>{tagText}</span>}
                            {rest}
                            {value && value === prefill && <span className={styles.inputHint}>{placeholder}</span>}
                            {'\n'}
                        </div>
                        <textarea
                            ref={inputRef}
                            className={styles.input}
                            rows={1}
                            value={value}
                            placeholder={placeholder}
                            aria-label={'Command for session ' + session.number}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoComplete="off"
                            autoCorrect="off"
                            onChange={event => {
                                setValue(event.target.value);
                                historyIndex.current = -1;
                            }}
                            onKeyDown={onKeyDown}
                            onPaste={onPaste}
                            onFocus={props.onFocus}
                        />
                    </div>
                </div>
            </div>
        </section>
    );
}

/** what an untouched command line holds: the next tag, nothing without auto tags or while the server waits */
function prefillFor(session: TerminalSession): string {
    return session.options.autoTag && !session.closed && !session.awaitingContinuation ? session.nextTag + ' ' : '';
}

function commonPrefix(words: string[]): string {
    let prefix = words[0];
    for (const word of words) {
        while (!word.startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
        }
    }
    return prefix;
}

function Drawer(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }): ReactNode {
    const ref = useRef<HTMLDivElement>(null);
    const { onClose } = props;

    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        ref.current?.querySelector<HTMLElement>('button, input')?.focus();
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            previous?.focus?.();
        };
    }, [onClose]);

    return (
        <div className={styles.overlay} onMouseDown={event => event.target === event.currentTarget && onClose()}>
            <div className={styles.drawer} role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
                <div className={styles.drawerHeader}>
                    <h2>{props.title}</h2>
                    <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
                        ×
                    </button>
                </div>
                <div className={styles.drawerBody}>{props.children}</div>
                {props.footer && <div className={styles.drawerFooter}>{props.footer}</div>}
            </div>
        </div>
    );
}

function SetupPanel(props: { config: Config; onApply: (config: Config) => void; onClose: () => void }): ReactNode {
    const [selected, setSelected] = useState(() => new Set(props.config.extensions));
    const [secure, setSecure] = useState(props.config.secure);
    const [autoTag, setAutoTag] = useState(props.config.autoTag);
    const [filter, setFilter] = useState('');
    const docsBase = useBaseUrl('/docs/extensions/');

    const implied = impliedBy(selected);
    const query = filter.trim().toLowerCase();
    const changed = secure !== props.config.secure || autoTag !== props.config.autoTag || !sameSet(props.config.extensions, selected);

    const toggle = (name: string) => {
        const next = new Set(selected);
        if (next.has(name)) {
            next.delete(name);
        } else {
            next.add(name);
        }
        setSelected(next);
    };

    const activePreset = PRESETS.find(preset => sameSet(preset.extensions, selected));

    return (
        <Drawer
            title="Server setup"
            onClose={props.onClose}
            footer={
                <>
                    <span className={styles.footerNote}>Applying restarts the server with fresh sample data.</span>
                    <button type="button" className={styles.button} onClick={props.onClose}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className={clsx(styles.button, styles.primary)}
                        disabled={!changed}
                        onClick={() =>
                            props.onApply({
                                extensions: ALL_EXTENSIONS.map(extension => extension.name).filter(name => selected.has(name)),
                                secure,
                                autoTag
                            })
                        }
                    >
                        Apply and restart
                    </button>
                </>
            }
        >
            <section className={styles.section}>
                <h3>Start from</h3>
                <div className={styles.presets}>
                    {PRESETS.map(preset => (
                        <button
                            type="button"
                            key={preset.id}
                            className={clsx(styles.preset, activePreset === preset && styles.presetActive)}
                            aria-pressed={activePreset === preset}
                            onClick={() => setSelected(new Set(preset.extensions))}
                        >
                            <strong>{preset.label}</strong>
                            <span>{preset.description}</span>
                        </button>
                    ))}
                </div>
            </section>

            <section className={styles.section}>
                <h3>Connection</h3>
                <label className={styles.option}>
                    <input type="radio" name="tls" checked={secure} onChange={() => setSecure(true)} />
                    <span>
                        <strong>Encrypted</strong>
                        <span>Sessions start as if connected over TLS (port 993)</span>
                    </span>
                </label>
                <label className={styles.option}>
                    <input type="radio" name="tls" checked={!secure} onChange={() => setSecure(false)} />
                    <span>
                        <strong>Plaintext</strong>
                        <span>Sessions start unencrypted (port 143), add STARTTLS and LOGINDISABLED to try the upgrade</span>
                    </span>
                </label>
                <label className={styles.option}>
                    <input type="checkbox" checked={autoTag} onChange={event => setAutoTag(event.target.checked)} />
                    <span>
                        <strong>Prefill tags</strong>
                        <span>Each line starts with the next tag (A1, A2 ...), which you can edit or delete. Turn off to type every tag yourself</span>
                    </span>
                </label>
            </section>

            <section className={styles.section}>
                <div className={styles.extensionsHeader}>
                    <h3>
                        Extensions <span className={styles.muted}>{selected.size + implied.size} loaded</span>
                    </h3>
                    <input
                        type="search"
                        className={styles.filter}
                        placeholder="Filter, e.g. sort or 9051"
                        value={filter}
                        onChange={event => setFilter(event.target.value)}
                        aria-label="Filter extensions"
                    />
                </div>
                {GROUPS.map(group => {
                    const extensions = group.extensions.filter(
                        extension =>
                            !query ||
                            labelOf(extension.name).toLowerCase().includes(query) ||
                            extension.summary.toLowerCase().includes(query) ||
                            (extension.rfc || '').includes(query)
                    );
                    if (!extensions.length) {
                        return null;
                    }
                    return (
                        <fieldset key={group.title} className={styles.group}>
                            <legend>{group.title}</legend>
                            {extensions.map(extension => {
                                const loadedBy = implied.get(extension.name);
                                const conflict = CONFLICTS[extension.name];
                                const blocked = !selected.has(extension.name) && !!conflict && (selected.has(conflict) || implied.has(conflict));
                                const reason = loadedBy
                                    ? 'Loaded by ' + labelOf(loadedBy)
                                    : blocked
                                      ? 'Can not be combined with ' + labelOf(conflict)
                                      : extension.summary;
                                return (
                                    <label key={extension.name} className={clsx(styles.extension, (loadedBy || blocked) && styles.extensionLocked)}>
                                        <input
                                            type="checkbox"
                                            checked={selected.has(extension.name) || !!loadedBy}
                                            disabled={!!loadedBy || blocked}
                                            onChange={() => toggle(extension.name)}
                                        />
                                        <span className={styles.extensionText}>
                                            <code>{labelOf(extension.name)}</code>
                                            <span>{reason}</span>
                                        </span>
                                        <span className={styles.extensionLinks}>
                                            {extension.rfc && (
                                                <a href={'https://www.rfc-editor.org/rfc/rfc' + extension.rfc} target="_blank" rel="noreferrer">
                                                    RFC {extension.rfc}
                                                </a>
                                            )}
                                            <a href={docsBase + extension.doc}>Docs</a>
                                        </span>
                                    </label>
                                );
                            })}
                        </fieldset>
                    );
                })}
            </section>
        </Drawer>
    );
}

/** The mailboxes of the running server, kept up to date */
function MailboxSummary(props: { server: ImapServer; onOpen: (path: string) => void }): ReactNode {
    const changes = useServerChanges(props.server);
    const mailboxes = useMemo(() => treeOrder(props.server.control.listMailboxes()), [props.server, changes]);
    return (
        <ul className={styles.mailboxes}>
            {mailboxes.map(mailbox => (
                <li key={mailbox.path}>
                    <button type="button" className={styles.mailboxLink} onClick={() => props.onOpen(mailbox.path)} title="Open on the Mail storage tab">
                        <code>{decodeMailboxName(mailbox.path)}</code>
                    </button>
                    <span>
                        {!mailbox.selectable
                            ? 'folders only'
                            : !mailbox.messages
                              ? 'empty'
                              : (mailbox.messages === 1 ? '1 message' : mailbox.messages + ' messages') +
                                (mailbox.unseen ? ', ' + mailbox.unseen + ' unread' : '')}
                    </span>
                </li>
            ))}
        </ul>
    );
}

function HelpContent(props: { server: ImapServer | null; onOpen: (path: string) => void }): ReactNode {
    return (
        <div className={styles.help}>
            <section>
                <h3>Log in</h3>
                <p>
                    <code>LOGIN testuser testpass</code>
                </p>
            </section>
            <section>
                <h3>Mailboxes</h3>
                {props.server ? <MailboxSummary server={props.server} onOpen={props.onOpen} /> : <p className={styles.muted}>Starting the server…</p>}
            </section>
            <section>
                <h3>Keys</h3>
                <dl className={styles.keys}>
                    <dt>Enter</dt>
                    <dd>Send the command</dd>
                    <dt>Shift+Enter</dt>
                    <dd>New line, for literals</dd>
                    <dt>↑ ↓</dt>
                    <dd>Command history</dd>
                    <dt>Tab</dt>
                    <dd>Complete a command name</dd>
                    <dt>Ctrl+L</dt>
                    <dd>Clear the screen</dd>
                    <dt>Ctrl+C</dt>
                    <dd>Start a fresh line with the next tag</dd>
                </dl>
            </section>
            <section>
                <h3>Good to know</h3>
                <ul className={styles.tips}>
                    <li>
                        Each line starts with the next tag. It is plain text: edit it, or delete it to see how the server treats an untagged line. Lines go out
                        as typed.
                    </li>
                    <li>
                        End a line with <code>{'{size}'}</code> and put the message on the next lines (Shift+Enter), the octet count is filled in.
                    </li>
                    <li>Open a second session and run IDLE in one of them to watch changes arrive.</li>
                    <li>The Mail storage tab shows the mailboxes as folders and .eml files. Upload messages there, or drop .eml files anywhere on the page.</li>
                    <li>ImapKit is strict: input that breaks the RFC gets BAD, on purpose.</li>
                </ul>
            </section>
            <p className={styles.helpLinks}>
                <Link to="/docs/getting-started/quick-start">Use ImapKit in your tests →</Link>
            </p>
        </div>
    );
}
