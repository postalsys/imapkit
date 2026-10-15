// The mailbox the playground server starts with. Messages are raw RFC 5322 sources, CRLF line ends

const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

export const STORAGE = {
    INBOX: {
        messages: [
            {
                raw: crlf([
                    'From: Alice Example <alice@example.com>',
                    'To: Test User <testuser@example.com>',
                    'Subject: Welcome to ImapKit',
                    'Date: Mon, 12 Oct 2026 09:15:00 +0000',
                    'Message-ID: <welcome@example.com>',
                    '',
                    'This IMAP server runs inside your browser tab.',
                    'Nothing you do here leaves the page.'
                ]),
                flags: ['\\Seen'],
                internaldate: '12-Oct-2026 09:15:00 +0000'
            },
            {
                raw: crlf([
                    'From: Bob Example <bob@example.com>',
                    'To: Test User <testuser@example.com>',
                    'Subject: Lunch on Friday?',
                    'Date: Tue, 13 Oct 2026 11:30:00 +0000',
                    'Message-ID: <lunch@example.com>',
                    '',
                    'Noon at the usual place?'
                ]),
                flags: [],
                internaldate: '13-Oct-2026 11:30:00 +0000'
            },
            {
                raw: crlf([
                    'From: Test User <testuser@example.com>',
                    'To: Bob Example <bob@example.com>',
                    'Subject: Re: Lunch on Friday?',
                    'Date: Tue, 13 Oct 2026 12:02:00 +0000',
                    'Message-ID: <lunch-reply@example.com>',
                    'In-Reply-To: <lunch@example.com>',
                    'References: <lunch@example.com>',
                    '',
                    'Sounds good, see you there.'
                ]),
                flags: ['\\Seen', '\\Answered'],
                internaldate: '13-Oct-2026 12:02:00 +0000'
            },
            {
                raw: crlf([
                    'From: =?UTF-8?Q?Caf=C3=A9_Bot?= <cafe@example.com>',
                    'To: Test User <testuser@example.com>',
                    'Subject: =?UTF-8?Q?Your_caf=C3=A9_report?=',
                    'Date: Wed, 14 Oct 2026 16:45:00 +0000',
                    'Message-ID: <report@example.com>',
                    'MIME-Version: 1.0',
                    'Content-Type: multipart/mixed; boundary="part"',
                    '',
                    '--part',
                    'Content-Type: text/plain; charset=utf-8',
                    'Content-Transfer-Encoding: 8bit',
                    '',
                    'The weekly report is attached.',
                    '--part',
                    'Content-Type: text/csv; name="report.csv"',
                    'Content-Disposition: attachment; filename="report.csv"',
                    '',
                    'item,price',
                    'espresso,3',
                    '--part--'
                ]),
                flags: ['\\Flagged'],
                internaldate: '14-Oct-2026 16:45:00 +0000'
            },
            {
                raw: crlf([
                    'From: Newsletter <news@example.com>',
                    'To: Test User <testuser@example.com>',
                    'Subject: Ten IMAP extensions you should know',
                    'Date: Thu, 15 Oct 2026 07:00:00 +0000',
                    'Message-ID: <news@example.com>',
                    'MIME-Version: 1.0',
                    'Content-Type: multipart/alternative; boundary="alt"',
                    '',
                    '--alt',
                    'Content-Type: text/plain; charset=us-ascii',
                    '',
                    'IDLE, MOVE, CONDSTORE, QRESYNC and more.',
                    '--alt',
                    'Content-Type: text/html; charset=us-ascii',
                    '',
                    '<p><b>IDLE</b>, MOVE, CONDSTORE, QRESYNC and more.</p>',
                    '--alt--'
                ]),
                flags: [],
                internaldate: '15-Oct-2026 07:00:00 +0000'
            }
        ]
    },
    '': {
        separator: '/',
        folders: {
            Archive: { 'special-use': '\\Archive' },
            Drafts: { 'special-use': '\\Drafts' },
            Sent: {
                'special-use': '\\Sent',
                messages: [
                    {
                        raw: crlf([
                            'From: Test User <testuser@example.com>',
                            'To: Alice Example <alice@example.com>',
                            'Subject: Thanks!',
                            'Date: Mon, 12 Oct 2026 10:00:00 +0000',
                            'Message-ID: <thanks@example.com>',
                            'In-Reply-To: <welcome@example.com>',
                            'References: <welcome@example.com>',
                            '',
                            'Thanks for the welcome.'
                        ]),
                        flags: ['\\Seen'],
                        internaldate: '12-Oct-2026 10:00:00 +0000'
                    }
                ]
            },
            Trash: { 'special-use': '\\Trash' },
            Projects: {
                folders: {
                    ImapKit: {}
                }
            }
        }
    }
};

/** a short description of the storage above, for the help panel */
export const MAILBOXES = [
    { name: 'INBOX', note: '5 messages, 2 unread' },
    { name: 'Sent', note: '1 message' },
    { name: 'Archive', note: 'empty' },
    { name: 'Drafts', note: 'empty' },
    { name: 'Trash', note: 'empty' },
    { name: 'Projects/ImapKit', note: 'empty' }
];

const APPEND_MESSAGE =
    ['From: testuser@example.com', 'To: alice@example.com', 'Subject: Sent from the playground', '', 'Hello from the browser!'].join('\r\n') + '\r\n';

/** APPEND of a message, the session fills in the literal size */
export const APPEND_COMMAND = 'APPEND INBOX (\\Seen) {size}\r\n' + APPEND_MESSAGE;
