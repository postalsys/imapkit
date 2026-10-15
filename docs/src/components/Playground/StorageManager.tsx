import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import clsx from 'clsx';
import { decodeMailboxName, encodeMailboxName, fileName, formatSize, looksLikeMessage, summarize } from './mail';
import type { MessageSummary } from './mail';
import type { Control, ImapServer, MailboxInfo, MessageInfo } from './session';
import styles from './styles.module.css';

const MESSAGE_TYPE = 'application/x-imapkit-messages';
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const PREVIEW_LIMIT = 100 * 1024;

interface Row extends MessageInfo {
    summary: MessageSummary;
}

/**
 * Adds message files to a mailbox through the control API, like a delivery from outside: sessions that have the
 * mailbox selected get EXISTS. The APPEND checks (QUOTA, APPENDLIMIT) apply
 *
 * @return a notice that tells what happened
 */
export async function uploadFiles(control: Control, files: File[], target: string): Promise<string> {
    let added = 0;
    const problems: string[] = [];
    for (const file of files) {
        if (!/\.eml$/i.test(file.name) && file.type !== 'message/rfc822') {
            problems.push(file.name + ' is not an .eml file');
            continue;
        }
        if (file.size > MAX_FILE_SIZE) {
            problems.push(file.name + ' is larger than ' + formatSize(MAX_FILE_SIZE));
            continue;
        }
        let raw = new Uint8Array(await file.arrayBuffer());
        // a message saved from a mbox file starts with a "From " separator line, which is not part of the message
        const separator = /^From [^\r\n]*\r?\n/.exec(new TextDecoder().decode(raw.subarray(0, 1024)));
        if (separator) {
            raw = raw.subarray(new TextEncoder().encode(separator[0]).length);
        }
        if (!raw.length || !looksLikeMessage(raw)) {
            problems.push(file.name + ' does not look like an email message');
            continue;
        }
        const date = summarize(raw).date;
        try {
            control.addMessage(target, { raw, ...(date ? { internaldate: date } : {}) }, { checks: true });
            added++;
        } catch (err) {
            problems.push(file.name + ': ' + (err as Error).message);
        }
    }
    const name = decodeMailboxName(target);
    const done = added ? 'Added ' + (added === 1 ? 'a message' : added + ' messages') + ' to ' + name : 'Nothing was added';
    return problems.length ? done + '. ' + problems.join('. ') : done;
}

/**
 * Counts the changes of the server storage: IMAP sessions and the control API change it, a component that shows the
 * storage renders again on every change (at most once a frame)
 */
export function useServerChanges(server: ImapServer | null): number {
    const [changes, setChanges] = useState(0);
    useEffect(() => {
        if (!server) {
            return;
        }
        let frame = 0;
        const refresh = () => {
            frame ||= requestAnimationFrame(() => {
                frame = 0;
                setChanges(value => value + 1);
            });
        };
        const events = ['command', 'mailbox', 'notify', 'reset'] as const;
        events.forEach(event => server.on(event, refresh));
        return () => {
            cancelAnimationFrame(frame);
            events.forEach(event => server.off(event, refresh));
        };
    }, [server]);
    return changes;
}

/** Orders mailboxes like a folder tree: INBOX first, every mailbox right after its parent */
export function treeOrder(list: MailboxInfo[]): MailboxInfo[] {
    const key = (mailbox: MailboxInfo) => (mailbox.path === 'INBOX' ? '' : '\u0001' + mailbox.path.split(mailbox.delimiter).join('\u0000').toLowerCase());
    return list.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function specialUseOf(mailbox: MailboxInfo): string {
    if (mailbox.path === 'INBOX') {
        return 'inbox';
    }
    const known = (mailbox.specialUse || [])[0];
    if (known) {
        return known.slice(1).toLowerCase();
    }
    // without the SPECIAL-USE plugin, the names of the sample storage
    const name = mailbox.path.toLowerCase();
    return ['sent', 'drafts', 'trash', 'archive', 'junk'].includes(name) ? name : 'folder';
}

const ICONS: Record<string, ReactNode> = {
    folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
    inbox: (
        <>
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </>
    ),
    sent: (
        <>
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </>
    ),
    drafts: (
        <>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
        </>
    ),
    trash: (
        <>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </>
    ),
    archive: (
        <>
            <polyline points="21 8 21 21 3 21 3 8" />
            <rect x="1" y="3" width="22" height="5" />
            <line x1="10" y1="12" x2="14" y2="12" />
        </>
    ),
    junk: (
        <>
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
        </>
    ),
    star: <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
    upload: (
        <>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
        </>
    ),
    download: (
        <>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
        </>
    ),
    answered: (
        <>
            <polyline points="9 17 4 12 9 7" />
            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
        </>
    ),
    reset: (
        <>
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </>
    )
};

function Icon(props: { name: string; className?: string }): ReactNode {
    return (
        <svg className={clsx(styles.icon, props.className)} viewBox="0 0 24 24" aria-hidden="true">
            {ICONS[props.name] || ICONS.folder}
        </svg>
    );
}

/** A button that asks for a second click before it runs a destructive action */
function ConfirmButton(props: { label: ReactNode; confirm: string; onConfirm: () => void; disabled?: boolean; title?: string; className?: string }): ReactNode {
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!armed) {
            return;
        }
        const timer = setTimeout(() => setArmed(false), 4000);
        return () => clearTimeout(timer);
    }, [armed]);
    return (
        <button
            type="button"
            className={clsx(styles.button, props.className, armed && styles.danger)}
            disabled={props.disabled}
            title={props.title}
            onClick={() => {
                if (armed) {
                    setArmed(false);
                    props.onConfirm();
                } else {
                    setArmed(true);
                }
            }}
            onBlur={() => setArmed(false)}
        >
            {armed ? props.confirm : props.label}
        </button>
    );
}

/** True if a drag carries files from the desktop */
export function hasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
}

function download(row: Row, raw: Uint8Array): void {
    const url = URL.createObjectURL(new Blob([raw as Uint8Array<ArrayBuffer>], { type: 'message/rfc822' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName(row.summary.subject, row.uid);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatDate(date: Date | null, fallback: string): string {
    if (!date) {
        return fallback.replace(/ [+-]\d{4}$/, '');
    }
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function StorageManager(props: {
    server: ImapServer;
    folder: string;
    onFolder: (path: string) => void;
    onUpload: (files: File[], target: string) => void;
    notify: (text: string) => void;
}): ReactNode {
    const { server, folder, onFolder, notify } = props;
    const control = server.control;
    const [version, setVersion] = useState(0);
    const [selection, setSelection] = useState<Set<number>>(new Set());
    const [anchor, setAnchor] = useState<number | null>(null);
    const [form, setForm] = useState<{ mode: 'create' | 'rename'; value: string } | null>(null);
    const [dropTarget, setDropTarget] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    // the row the arrow keys move from
    const cursor = useRef<number | null>(null);
    // summaries of message sources, a stored message never changes
    const summaries = useRef(new Map<string, MessageSummary>());

    const changes = useServerChanges(server);

    const mailboxes = useMemo(() => treeOrder(control.listMailboxes()), [control, version, changes]);
    const current = mailboxes.find(mailbox => mailbox.path === folder);

    useEffect(() => {
        // the folder was deleted or renamed, by an IMAP session or here
        if (!current && folder !== 'INBOX') {
            onFolder('INBOX');
        }
    }, [current, folder, onFolder]);

    useEffect(() => {
        setSelection(new Set());
        setAnchor(null);
        setForm(null);
    }, [folder]);

    const rows: Row[] = useMemo(() => {
        if (!current?.selectable) {
            return [];
        }
        return control.listMessages(current.path).map(message => {
            const key = current.uidvalidity + '/' + current.path + '/' + message.uid;
            let summary = summaries.current.get(key);
            if (!summary) {
                summary = summarize(control.getMessage(current.path, message.uid).raw as Uint8Array);
                summaries.current.set(key, summary);
            }
            return { ...message, summary };
        });
    }, [control, current, version, changes]);

    // messages removed elsewhere leave the selection
    const selected = rows.filter(row => selection.has(row.uid));
    const single = selected.length === 1 ? selected[0] : null;

    const run = (action: () => void, done?: string) => {
        try {
            action();
            // the list follows in the same render as the notice, the server events refresh it a frame later
            setVersion(value => value + 1);
            if (done) {
                notify(done);
            }
            return true;
        } catch (err) {
            notify((err as Error).message);
            return false;
        }
    };

    const select = (event: MouseEvent | KeyboardEvent, uid: number) => {
        cursor.current = uid;
        const next = new Set(event.metaKey || event.ctrlKey ? selection : []);
        if (event.shiftKey && anchor !== null) {
            const from = rows.findIndex(row => row.uid === anchor);
            const to = rows.findIndex(row => row.uid === uid);
            rows.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(row => next.add(row.uid));
        } else if ((event.metaKey || event.ctrlKey) && next.has(uid)) {
            next.delete(uid);
        } else {
            next.add(uid);
            setAnchor(uid);
        }
        setSelection(next);
    };

    const toggle = (uid: number) => {
        const next = new Set(selection);
        if (next.has(uid)) {
            next.delete(uid);
        } else {
            next.add(uid);
        }
        setAnchor(uid);
        setSelection(next);
    };

    const uids = selected.map(row => row.uid);
    const allSeen = selected.every(row => row.flags.includes('\\Seen'));
    const allFlagged = selected.every(row => row.flags.includes('\\Flagged'));
    const path = current?.path || folder;
    const name = decodeMailboxName(path);
    const count = (n: number) => (n === 1 ? 'a message' : n + ' messages');

    const setFlag = (flag: string, add: boolean) => run(() => control.setFlags(path, uids, [flag], add ? 'add' : 'remove'));
    const remove = () => run(() => control.expungeMessages(path, uids), 'Deleted ' + count(uids.length));
    const transfer = (source: string, list: number[], target: string, copy: boolean) => {
        if (source === target) {
            return;
        }
        const label = (copy ? 'Copied ' : 'Moved ') + count(list.length) + ' to ' + decodeMailboxName(target);
        run(() => (copy ? control.copyMessages(source, list, target) : control.moveMessages(source, list, target)), label);
    };

    const submitForm = () => {
        if (!form) {
            return;
        }
        const value = form.value.trim().replace(/\/+$/, '');
        if (!value) {
            return;
        }
        const target = encodeMailboxName(value);
        if (form.mode === 'create') {
            if (run(() => control.createMailbox(target, { subscribed: true }), 'Created ' + value)) {
                setForm(null);
                onFolder(target);
            }
        } else if (target === path) {
            setForm(null);
        } else if (run(() => control.renameMailbox(path, target), 'Renamed ' + name + ' to ' + value)) {
            setForm(null);
            // renaming INBOX moves its messages and leaves an empty INBOX
            onFolder(target);
        }
    };

    const onListKey = (event: KeyboardEvent) => {
        if (!rows.length) {
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const index = rows.findIndex(row => row.uid === cursor.current);
            const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
            select(event, next.uid);
            listRef.current?.querySelector('[data-uid="' + next.uid + '"]')?.scrollIntoView({ block: 'nearest' });
        } else if ((event.key === 'Delete' || event.key === 'Backspace') && uids.length) {
            event.preventDefault();
            remove();
        } else if (event.key === 'a' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            setSelection(new Set(rows.map(row => row.uid)));
        } else if (event.key === 'Escape') {
            setSelection(new Set());
        }
    };

    const folderDrag = (target: MailboxInfo) => ({
        onDragOver: (event: DragEvent) => {
            const messages = event.dataTransfer.types.includes(MESSAGE_TYPE);
            if (!target.selectable || (!messages && !hasFiles(event))) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = messages && !event.altKey ? 'move' : 'copy';
            setDropTarget(target.path);
        },
        onDragLeave: () => setDropTarget(current => (current === target.path ? null : current)),
        onDrop: (event: DragEvent) => {
            setDropTarget(null);
            if (!target.selectable) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const data = event.dataTransfer.getData(MESSAGE_TYPE);
            if (data) {
                const moved = JSON.parse(data) as { path: string; uids: number[] };
                transfer(moved.path, moved.uids, target.path, event.altKey);
            } else if (event.dataTransfer.files.length) {
                props.onUpload(Array.from(event.dataTransfer.files), target.path);
            }
        }
    });

    return (
        <div className={styles.storage}>
            <div className={styles.storageToolbar}>
                {form ? (
                    <form
                        className={styles.folderForm}
                        onSubmit={event => {
                            event.preventDefault();
                            submitForm();
                        }}
                    >
                        <label htmlFor="pg-folder-name">{form.mode === 'create' ? 'New folder' : 'Rename ' + name + ' to'}</label>
                        <input
                            id="pg-folder-name"
                            className={styles.filter}
                            value={form.value}
                            autoFocus
                            spellCheck={false}
                            autoComplete="off"
                            placeholder="Projects/Ideas"
                            onChange={event => setForm({ ...form, value: event.target.value })}
                            onKeyDown={event => event.key === 'Escape' && setForm(null)}
                        />
                        <button type="submit" className={clsx(styles.button, styles.primary)} disabled={!form.value.trim()}>
                            {form.mode === 'create' ? 'Create' : 'Rename'}
                        </button>
                        <button type="button" className={styles.button} onClick={() => setForm(null)}>
                            Cancel
                        </button>
                        <span className={styles.footerNote}>Use / for subfolders</span>
                    </form>
                ) : (
                    <>
                        <button
                            type="button"
                            className={clsx(styles.button, styles.primary)}
                            onClick={() => fileInput.current?.click()}
                            disabled={!current?.selectable}
                        >
                            <Icon name="upload" />
                            Upload .eml
                        </button>
                        <input
                            ref={fileInput}
                            type="file"
                            accept=".eml,message/rfc822"
                            multiple
                            hidden
                            onChange={event => {
                                const files = Array.from(event.target.files || []);
                                event.target.value = '';
                                if (files.length) {
                                    props.onUpload(files, path);
                                }
                            }}
                        />
                        <span className={styles.toolbarGap} />
                        <button
                            type="button"
                            className={styles.button}
                            onClick={() => setForm({ mode: 'create', value: path === 'INBOX' ? '' : name + (current?.delimiter || '/') })}
                        >
                            New folder
                        </button>
                        <button type="button" className={styles.button} onClick={() => setForm({ mode: 'rename', value: name })} disabled={!current}>
                            Rename
                        </button>
                        <ConfirmButton
                            label="Delete folder"
                            confirm={'Delete ' + name + '?'}
                            disabled={!current || path === 'INBOX'}
                            title={path === 'INBOX' ? 'INBOX can not be deleted' : 'Sessions that have it selected are disconnected'}
                            onConfirm={() => run(() => control.deleteMailbox(path), 'Deleted ' + name)}
                        />
                        <ConfirmButton
                            className={styles.resetButton}
                            label={
                                <>
                                    <Icon name="reset" />
                                    Reset storage
                                </>
                            }
                            confirm="Reset and disconnect sessions?"
                            title="Restore the sample mailboxes. Open sessions get BYE"
                            onConfirm={() => {
                                if (run(() => control.reset())) {
                                    summaries.current.clear();
                                    onFolder('INBOX');
                                    notify('Storage restored. Sessions got BYE, press Enter in a terminal to reconnect');
                                }
                            }}
                        />
                    </>
                )}
            </div>

            <div className={clsx(styles.storageBody, single && styles.withPreview)}>
                <nav className={styles.tree} aria-label="Folders">
                    {mailboxes.map(mailbox => {
                        const parts = mailbox.path.split(mailbox.delimiter);
                        return (
                            <button
                                type="button"
                                key={mailbox.path}
                                className={clsx(
                                    styles.treeItem,
                                    mailbox.path === folder && styles.treeItemActive,
                                    dropTarget === mailbox.path && styles.treeItemDrop,
                                    !mailbox.selectable && styles.treeItemNoselect
                                )}
                                style={{ paddingLeft: 8 + (parts.length - 1) * 14 }}
                                aria-current={mailbox.path === folder ? 'true' : undefined}
                                title={decodeMailboxName(mailbox.path) + (mailbox.selectable ? '' : ' (\\Noselect, holds only folders)')}
                                onClick={() => onFolder(mailbox.path)}
                                {...folderDrag(mailbox)}
                            >
                                <Icon name={specialUseOf(mailbox)} />
                                <span className={styles.treeName}>{decodeMailboxName(parts[parts.length - 1])}</span>
                                {mailbox.unseen > 0 && <span className={styles.unseen}>{mailbox.unseen}</span>}
                            </button>
                        );
                    })}
                </nav>

                <div className={styles.messages}>
                    <div className={styles.messagesHeader}>
                        <strong>{name}</strong>
                        <span className={styles.muted}>
                            {current?.selectable ? count(rows.length) + (current.unseen ? ', ' + current.unseen + ' unread' : '') : 'Holds only folders'}
                        </span>
                        {selected.length > 0 && (
                            <span className={styles.selectionActions}>
                                <span className={styles.muted}>{selected.length} selected</span>
                                <button type="button" className={styles.smallButton} onClick={() => setFlag('\\Seen', !allSeen)}>
                                    {allSeen ? 'Mark unread' : 'Mark read'}
                                </button>
                                <button type="button" className={styles.smallButton} onClick={() => setFlag('\\Flagged', !allFlagged)}>
                                    {allFlagged ? 'Unflag' : 'Flag'}
                                </button>
                                <select
                                    className={styles.smallButton}
                                    value=""
                                    aria-label="Move to folder"
                                    onChange={event => event.target.value && transfer(path, uids, event.target.value, false)}
                                >
                                    <option value="">Move to…</option>
                                    {mailboxes
                                        .filter(mailbox => mailbox.selectable && mailbox.path !== path)
                                        .map(mailbox => (
                                            <option key={mailbox.path} value={mailbox.path}>
                                                {decodeMailboxName(mailbox.path)}
                                            </option>
                                        ))}
                                </select>
                                <button
                                    type="button"
                                    className={clsx(styles.smallButton, styles.dangerText)}
                                    onClick={remove}
                                    title="Expunge, sessions get EXPUNGE"
                                >
                                    Delete
                                </button>
                            </span>
                        )}
                    </div>
                    <div
                        ref={listRef}
                        className={styles.messageList}
                        role="listbox"
                        aria-multiselectable="true"
                        aria-label={'Messages in ' + name}
                        tabIndex={0}
                        onKeyDown={onListKey}
                    >
                        {rows.map(row => {
                            const seen = row.flags.includes('\\Seen');
                            const isSelected = selection.has(row.uid);
                            return (
                                <div
                                    key={row.uid}
                                    data-uid={row.uid}
                                    role="option"
                                    aria-selected={isSelected}
                                    className={clsx(
                                        styles.messageRow,
                                        !seen && styles.unread,
                                        isSelected && styles.messageSelected,
                                        row.flags.includes('\\Deleted') && styles.deleted
                                    )}
                                    draggable
                                    onDragStart={event => {
                                        const list = isSelected ? uids : [row.uid];
                                        if (!isSelected) {
                                            setSelection(new Set(list));
                                        }
                                        event.dataTransfer.setData(MESSAGE_TYPE, JSON.stringify({ path, uids: list }));
                                        event.dataTransfer.effectAllowed = 'copyMove';
                                    }}
                                    onClick={event => select(event, row.uid)}
                                >
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        aria-label={'Select message ' + row.uid}
                                        onClick={event => event.stopPropagation()}
                                        onChange={() => toggle(row.uid)}
                                    />
                                    <button
                                        type="button"
                                        className={clsx(styles.star, row.flags.includes('\\Flagged') && styles.starOn)}
                                        aria-label={row.flags.includes('\\Flagged') ? 'Unflag' : 'Flag'}
                                        aria-pressed={row.flags.includes('\\Flagged')}
                                        onClick={event => {
                                            event.stopPropagation();
                                            run(() => control.setFlags(path, [row.uid], ['\\Flagged'], row.flags.includes('\\Flagged') ? 'remove' : 'add'));
                                        }}
                                    >
                                        <Icon name="star" />
                                    </button>
                                    <span className={styles.from}>
                                        {row.flags.includes('\\Answered') && <Icon name="answered" className={styles.answered} />}
                                        {row.summary.from || '(no sender)'}
                                    </span>
                                    <span className={styles.subject}>
                                        {row.summary.subject || '(no subject)'}
                                        {row.flags
                                            .filter(flag => !flag.startsWith('\\'))
                                            .map(flag => (
                                                <span key={flag} className={styles.keyword}>
                                                    {flag}
                                                </span>
                                            ))}
                                    </span>
                                    <span className={styles.date}>{formatDate(row.summary.date, row.internaldate)}</span>
                                    <span className={styles.size}>{formatSize(row.size)}</span>
                                    <span className={styles.uid}>UID {row.uid}</span>
                                </div>
                            );
                        })}
                        {current?.selectable && !rows.length && (
                            <div className={styles.empty}>
                                <Icon name="upload" />
                                <p>
                                    No messages in {name}. Drop .eml files here, or{' '}
                                    <button type="button" className={styles.linkButton} onClick={() => fileInput.current?.click()}>
                                        choose files
                                    </button>
                                    .
                                </p>
                            </div>
                        )}
                    </div>
                    <p className={styles.storageNote}>
                        Changes here reach open IMAP sessions like changes made by another client: EXISTS, EXPUNGE and FETCH responses. Drag messages to a
                        folder to move them, hold Alt to copy.
                    </p>
                </div>

                {single && <MessagePreview key={path + '/' + single.uid} control={control} path={path} row={single} onClose={() => setSelection(new Set())} />}
            </div>
        </div>
    );
}

function MessagePreview(props: { control: Control; path: string; row: Row; onClose: () => void }): ReactNode {
    const { row } = props;
    const raw = useMemo(() => {
        try {
            return props.control.getMessage(props.path, row.uid).raw as Uint8Array;
        } catch {
            // expunged by a session a moment ago, the list catches up on the next frame
            return null;
        }
    }, [props.control, props.path, row.uid]);
    const source = useMemo(() => (raw ? new TextDecoder().decode(raw.subarray(0, PREVIEW_LIMIT)) : ''), [raw]);
    if (!raw) {
        return null;
    }
    return (
        <aside className={styles.preview} aria-label="Message">
            <div className={styles.previewHeader}>
                <h3>{row.summary.subject || '(no subject)'}</h3>
                <button type="button" className={styles.closeButton} onClick={props.onClose} aria-label="Close message">
                    ×
                </button>
            </div>
            <dl className={styles.previewFields}>
                <dt>From</dt>
                <dd>{row.summary.from || '(none)'}</dd>
                <dt>To</dt>
                <dd>{row.summary.to || '(none)'}</dd>
                <dt>Date</dt>
                <dd>{formatDate(row.summary.date, row.internaldate)}</dd>
                <dt>Flags</dt>
                <dd>
                    <code>{row.flags.length ? row.flags.join(' ') : '()'}</code>
                </dd>
                <dt>UID</dt>
                <dd>
                    <code>{row.uid}</code> · {formatSize(row.size)} · internal date <code>{row.internaldate}</code>
                </dd>
            </dl>
            <div className={styles.previewActions}>
                <button type="button" className={styles.smallButton} onClick={() => download(row, raw)}>
                    <Icon name="download" />
                    Download .eml
                </button>
            </div>
            <pre className={styles.source}>
                {source}
                {raw.length > PREVIEW_LIMIT && '\n… ' + formatSize(raw.length - PREVIEW_LIMIT) + ' more, download the file to see it all'}
            </pre>
        </aside>
    );
}
