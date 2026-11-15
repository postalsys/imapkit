import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('Delete', () => {
    const ctx = setupServer(() => ({
        storage: {
            '': {
                folders: {
                    testfold: {
                        uidnext: 234,
                        folders: {
                            sub: {
                                uidnext: 567
                            }
                        }
                    }
                }
            },
            '#news.': {
                type: 'shared',
                separator: '.'
            },
            '#juke?': {
                type: 'shared',
                separator: '?'
            }
        }
    }));

    it('Delete success', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 DELETE testfold/sub', 'C1 LIST "" "*"', 'A3 DELETE testfold', 'C2 LIST "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('Delete parent', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A3 DELETE testfold',
            'C1 LIST "" "*"',
            'A4 DELETE testfold',
            'C2 LIST "" "*"',
            'A4 DELETE testfold/sub',
            'C2 LIST "" "*"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\nA4 NO') >= 0);
            done();
        });
    });
});

describe('DELETE of a mailbox with children', () => {
    const ctx = setupServer(() => ({
        plugins: ['OBJECTID', 'SPECIAL-USE', 'METADATA', 'CONDSTORE'],
        storage: {
            INBOX: {},
            '': {
                folders: {
                    Old: {
                        uidvalidity: 5,
                        uidnext: 10,
                        MAILBOXID: 'OLDBOX',
                        'special-use': '\\Archive',
                        messages: [{ raw: 'Subject: a\r\n\r\na', uid: 9, flags: ['$Seen'] }],
                        folders: {
                            Child: {}
                        }
                    },
                    Level: {
                        flags: ['\\Noselect'],
                        folders: {
                            Child: {}
                        }
                    }
                }
            }
        }
    }));

    const run = (commands: string[], callback: (resp: string) => void) =>
        ctx.run(['A1 LOGIN testuser testpass', ...commands, 'ZZ LOGOUT'], resp => callback(resp.toString('binary')));

    // RFC 3501 section 6.3.4: the name acquires \Noselect, nothing else of the mailbox is left
    it('keeps only the hierarchy level', (t, done) => {
        run(['A2 SETMETADATA Old (/private/comment "old")', 'A3 DELETE Old', 'A4 LIST "" "Old"'], resp => {
            assert.match(resp, /^A3 OK/m);
            assert.match(resp, /^\* LIST \(\\Noselect \\HasChildren\) "\/" "Old"\r$/m);
            const placeholder = ctx.server.getMailbox('Old')!;
            for (const key of ['MAILBOXID', 'special-use', 'metadata', 'HIGHESTMODSEQ']) {
                assert.ok(!(key in placeholder), key + ' survived DELETE');
            }
            assert.deepStrictEqual(placeholder.messages, []);
            assert.deepStrictEqual(Object.keys(placeholder.folders!), ['Child']);
            done();
        });
    });

    // RFC 3501 section 6.3.3, RFC 8474 section 4: a mailbox created again is a new mailbox
    it('creates a new mailbox in place of the hierarchy level', (t, done) => {
        run(
            [
                'A2 DELETE Old',
                'A3 CREATE Old',
                'A4 STATUS Old (UIDVALIDITY UIDNEXT MESSAGES MAILBOXID)',
                'A5 LIST "" "Old*"',
                'A6 GETMETADATA Old /private/comment'
            ],
            resp => {
                const status = resp.match(/^\* STATUS Old \(UIDVALIDITY (\d+) UIDNEXT (\d+) MESSAGES (\d+) MAILBOXID \((\w+)\)\)\r$/m);
                assert.ok(status, resp);
                assert.ok(Number(status[1]) > 5, resp);
                assert.strictEqual(status[3], '0');
                assert.notStrictEqual(status[4], 'OLDBOX');
                // no special-use attribute, and the child is still there
                assert.match(resp, /^\* LIST \(\\HasChildren\) "\/" "Old"\r$/m);
                assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "Old\/Child"\r$/m);
                assert.match(resp, /^\* METADATA Old \(\/private\/comment NIL\)\r$/m);
                done();
            }
        );
    });

    // RFC 3501 section 6.3.3: a \Noselect level already is the superior name a new child needs
    it('does not turn a \\Noselect level into a mailbox when a child is created', (t, done) => {
        run(['A2 CREATE Level/New', 'A3 LIST "" "Level*"', 'A4 SELECT Level'], resp => {
            assert.match(resp, /^\* LIST \(\\Noselect \\HasChildren\) "\/" "Level"\r$/m);
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "Level\/New"\r$/m);
            assert.match(resp, /^A4 NO \[NONEXISTENT\]/m);
            done();
        });
    });
});

describe('DELETE of a mailbox inside INBOX', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {},
            '': {
                folders: {}
            }
        }
    }));

    it('a child of INBOX is gone from LIST once deleted, and INBOX has no children again', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 CREATE INBOX/Receipts',
            'A3 DELETE INBOX/Receipts',
            'A4 LIST "" "*"',
            'A5 CREATE Other',
            'A6 LIST "" "*"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0, resp);
            assert.ok(resp.indexOf('\nA3 OK') >= 0, resp);
            assert.ok(!/LIST \([^)]*\) "\/" "?INBOX\/Receipts"?/.test(resp.slice(resp.indexOf('A3 OK'))), resp);
            assert.ok(/LIST \(\\HasNoChildren\) "\/" "?INBOX"?/i.test(resp.slice(resp.indexOf('A3 OK'))), resp);
            done();
        });
    });
});
