import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateResponses, splitResponses } from './helpers/validate-responses.js';

describe('Response grammar guardrail', () => {
    const valid = [
        '* OK ImapKit ready\r\n',
        'A1 OK [READ-WRITE] SELECT completed\r\n',
        '* OK [PERMANENTFLAGS (\\Seen \\*)] Flags permitted\r\n',
        '* 0 EXISTS\r\n* 0 RECENT\r\n',
        '* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n',
        '* 1 FETCH (BODY[] {3}\r\nabc UID 4)\r\n',
        '* 1 FETCH (BODY[HEADER] {2}\r\nab BODY[TEXT] {0}\r\n)\r\n',
        '* 1 FETCH (BINARY[] ~{3}\r\na\x00c)\r\n',
        '* 1 FETCH (UID 1 BINARY[1.2]<5> ~{1}\r\n\x00 BINARY[3] ~{0}\r\n BINARY.SIZE[3] 0)\r\n',
        '* METADATA INBOX (/private/blob ~{1}\r\n\x00)\r\n',
        '* SEARCH\r\n* SEARCH 1 2 3\r\n* SEARCH 1 (MODSEQ 5)\r\n',
        // RFC 4466 section 2.6.2, RFC 4731 section 4
        '* ESEARCH\r\n* ESEARCH (TAG "A1")\r\n* ESEARCH (TAG "A1") UID MIN 1 MAX 3 ALL 1:3,5 COUNT 4 MODSEQ 7\r\n',
        '* ESEARCH COUNT 0\r\n* ESEARCH (TAG "A1") X-FOO (1 2)\r\n',
        '* SORT\r\n* SORT 2 3 6\r\n* SORT 2 (MODSEQ 7)\r\n',
        '* THREAD\r\n* THREAD (2)(3 6 (4 23)(44 7 96))\r\n* THREAD ((3)(5))\r\n',
        // RFC 7162 section 7
        '* VANISHED 1:3,5\r\n* VANISHED (EARLIER) 7\r\n',
        '+ idling\r\n',
        '+ \r\n',
        '* ID ("name" "imapkit")\r\n',
        '* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST () NIL INBOX\r\n* LSUB (\\Noselect) "." foo\r\n',
        '* LIST (\\NonExistent \\Subscribed) "/" "a b" ("CHILDINFO" ("SUBSCRIBED"))\r\n',
        '* STATUS INBOX (MESSAGES 3 SIZE 1338)\r\n* STATUS "a b" ()\r\n',
        '* METADATA "" (/shared/comment NIL /shared/admin "mailto:a@example.com")\r\n',
        '* METADATA INBOX (/private/comment {4}\r\na\r\nb)\r\n',
        '* METADATA INBOX /shared/comment /private/comment\r\n',
        'A1 OK [METADATA LONGENTRIES 2199] done\r\n',
        'A1 NO [METADATA MAXSIZE 1024] too big\r\nA2 NO [METADATA TOOMANY] too many\r\nA3 NO [METADATA NOPRIVATE] no private\r\n',
        '* ACL "INBOX" "testuser" "lrswipkxteacd" "bob" "lr"\r\n',
        '* ACL INBOX\r\n',
        '* LISTRIGHTS INBOX bob "" l r s w i p k x t e a c d\r\n',
        '* MYRIGHTS INBOX lr\r\n',
        // RFC 9755 section 3: UTF-8 in quoted strings once UTF8=ACCEPT is enabled
        '* ENABLED UTF8=ACCEPT\r\n* LIST () "/" "\xd0\x96\\"\\\\"\r\n',
        // RFC 5465 section 8
        'A1 NO [BADEVENT (MessageNew MessageExpunge FlagChange)] unsupported\r\n* OK [NOTIFICATIONOVERFLOW] too many\r\n',
        '* LIST (\\HasNoChildren) "/" New ("OLDNAME" ("Old"))\r\n',
        '* LIST (\\NoAccess) "/" Lookup\r\n',
        // RFC 9586 section 4: uidfetch-resp once UIDONLY is enabled, and the UIDREQUIRED response code
        '* ENABLED UIDONLY\r\n* 25996 UIDFETCH (FLAGS (\\Seen))\r\n* 25900 UIDFETCH (FLAGS () UID 25900)\r\n* VANISHED 405,407\r\n',
        '* ENABLED UIDONLY\r\n* 7 UIDFETCH (BODY[] {3}\r\nabc)\r\n* 3 EXISTS\r\n* ESEARCH (TAG "A1") UID ALL 1:3\r\n',
        'A1 BAD [UIDREQUIRED] Message numbers are not allowed\r\n',
        // RFC 9738 section 5
        'A1 OK [MESSAGELIMIT 1000 23221] FETCH completed\r\nA2 NO [MESSAGELIMIT 1000] too many\r\n* NO [MESSAGELIMIT 1000 23221] partial\r\n'
    ];

    valid.forEach(transcript => {
        it('accepts ' + JSON.stringify(transcript), async () => {
            await validateResponses(transcript);
        });
    });

    const invalid: [string, RegExp][] = [
        ['* OK ready\n', /bare LF/],
        ['* OK re\rady\r\n', /bare CR/],
        ['* OK ready', /not terminated/],
        ['* 1 FETCH (BODY[] {10}\r\nabc)\r\n', /cut short/],
        ['+\r\n', /must start with "\+ "/],
        ['A1 OK\r\n', /SP and text/],
        ['A1 OK [READ-WRITE]\r\n', /SP and text/],
        ['A1 OK [READ-WRITE\r\n', /closing|ImapFlow/],
        ['A+1 OK done\r\n', /tag OK/],
        ['A1 MAYBE done\r\n', /tag OK/],
        ['* 0 FETCH (UID 1)\r\n', /nz-number/],
        ['* 0 EXPUNGE\r\n', /nz-number/],
        ['* 1 FETCH (UID 1 FLAGS)\r\n', /pairs/],
        ['* 1 FETCH UID 1\r\n', /parenthesized/],
        ['* 1 FETCH (UID\r\n', /ImapFlow/],
        ['* SEARCH 0\r\n', /nz-numbers/],
        ['* SEARCH 1 01\r\n', /nz-numbers/],
        ['* ESEARCH (TAG A1) COUNT 1\r\n', /correlator/],
        ['* ESEARCH (TAG "A1") UID COUNT\r\n', /pairs/],
        ['* ESEARCH MIN 0\r\n', /MIN has an invalid value/],
        ['* ESEARCH ALL 1:*\r\n', /ALL has an invalid value/],
        ['* ESEARCH COUNT 1 COUNT 1\r\n', /more than once/],
        ['* ESEARCH 1 2\r\n', /tagged-ext-label/],
        ['* SORT 1 0\r\n', /nz-numbers/],
        ['* SORT (1)\r\n', /nz-numbers/],
        ['* SORT (MODSEQ 1)\r\n', /nz-numbers/],
        ['* THREAD \r\n', /thread-data/],
        ['* THREAD (1) (2)\r\n', /thread-data/],
        ['* THREAD (1 (2))\r\n', /thread-data/],
        ['* THREAD ((1))\r\n', /thread-data/],
        ['* THREAD (1 2 )\r\n', /thread-data/],
        ['* THREAD (0)\r\n', /thread-data/],
        ['* THREAD ()\r\n', /thread-data|ImapFlow/],
        ['* VANISHED 1:*\r\n', /VANISHED response/],
        ['* VANISHED (EARLIER)\r\n', /VANISHED response/],
        ['* VANISHED 0\r\n', /VANISHED response/],
        ['* FROBNICATE 1\r\n', /Unknown untagged/],
        ['* OK caf\xe9\r\n', /8-bit/],
        ['* 1 FETCH (BODY[] {3}\r\na\x00c)\r\n', /NUL/],
        ['* LIST () "/"\r\n', /flag list, a delimiter/],
        ['* LIST (Foo) "/" INBOX\r\n', /invalid mailbox attribute/],
        ['* LIST (\\Noselect \\NonExistent) "/" a\r\n', /more than one/],
        ['* LIST (\\HasChildren \\HasNoChildren) "/" a\r\n', /HasChildren together/],
        ['* LIST () "//" a\r\n', /delimiter/],
        ['* LIST () "/" a ("CHILDINFO")\r\n', /extended data/],
        ['* LSUB () "/" a ("CHILDINFO" ("SUBSCRIBED"))\r\n', /flag list, a delimiter/],
        ['* STATUS INBOX (MESSAGES)\r\n', /pairs/],
        ['* STATUS INBOX (MESSAGES x)\r\n', /numeric/],
        ['* METADATA INBOX\r\n', /mailbox name and entries/],
        ['* METADATA INBOX ()\r\n', /pairs/],
        ['* METADATA INBOX (/shared/comment)\r\n', /pairs/],
        ['* METADATA INBOX (/shared/comment value)\r\n', /invalid entry or value/],
        ['* METADATA INBOX (/shared/comment NIL) /x\r\n', /pairs/],
        ['* METADATA INBOX comment\r\n', /invalid entry list/],
        ['A1 OK [METADATA LONGENTRIES] done\r\n', /METADATA response code/],
        ['A1 NO [METADATA TOOBIG] done\r\n', /METADATA response code/],
        ['* ACL INBOX bob\r\n', /number of arguments/],
        ['* ACL INBOX bob LR\r\n', /lowercase/],
        ['* MYRIGHTS INBOX\r\n', /number of arguments/],
        ['* MYRIGHTS INBOX (lr)\r\n', /must be strings/],
        ['* LISTRIGHTS INBOX bob\r\n', /number of arguments/],
        ['* LISTRIGHTS INBOX bob "" l+\r\n', /lowercase/],
        ['* LIST () "/" "\xd0\x96"\r\n', /8-bit/],
        ['* ENABLED UTF8=ACCEPT\r\n* LIST () "/" \xd0\x96\r\n', /outside a literal or quoted string/],
        ['* ENABLED UTF8=ACCEPT\r\n* LIST () "/" "caf\xe9"\r\n', /not valid UTF-8/],
        ['* ENABLED UTF8=ACCEPT\r\nA1 OK caf\xc3\xa9\r\n', /8-bit/],
        ['* ENABLED UTF8=ACCEPT\r\nA1 OK "caf\xc3\xa9"\r\n', /text contains an 8-bit/],
        ['* 1 FETCH (BODY[] ~{3}\r\na\x00c)\r\n', /Literal8 outside/],
        ['* 1 FETCH (BINARY[1] {1}\r\na BODY[1] ~{1}\r\n\x00)\r\n', /Literal8 outside/],
        ['* LIST () "/" ~{1}\r\na\r\n', /Literal8 outside/],
        ['A1 NO [BADEVENT] unsupported\r\n', /BADEVENT/],
        ['A1 NO [BADEVENT MessageNew] unsupported\r\n', /BADEVENT/],
        ['* OK [NOTIFICATIONOVERFLOW 1] too many\r\n', /NOTIFICATIONOVERFLOW/],
        ['* LIST () "/" New ("OLDNAME" "Old")\r\n', /OLDNAME/],
        ['* LIST () "/" New ("OLDNAME" ("Old" "Older"))\r\n', /OLDNAME/],
        // RFC 9586: no message numbers once UIDONLY is enabled, no UIDFETCH before
        ['* 1 UIDFETCH (FLAGS ())\r\n', /UIDFETCH response before ENABLE UIDONLY/],
        ['* ENABLED UIDONLY\r\n* 1 FETCH (FLAGS ())\r\n', /FETCH response holds a message number/],
        ['* ENABLED UIDONLY\r\n* 1 EXPUNGE\r\n', /EXPUNGE response holds a message number/],
        ['* ENABLED UIDONLY\r\n* OK [UNSEEN 1] First unseen\r\n', /UNSEEN response code/],
        ['* ENABLED UIDONLY\r\n* ESEARCH (TAG "A1") ALL 1:3\r\n', /ESEARCH response without UID/],
        ['* ENABLED UIDONLY\r\n* 0 UIDFETCH (FLAGS ())\r\n', /requires a nz-number/],
        ['* ENABLED UIDONLY\r\n* 1 UIDFETCH (FLAGS)\r\n', /attribute and value pairs/],
        ['* ENABLED UIDONLY\r\n* 1 UIDFETCH FLAGS ()\r\n', /exactly one parenthesized list/],
        ['A1 BAD [UIDREQUIRED 1] no\r\n', /UIDREQUIRED response code/],
        // RFC 9738 section 5
        ['A1 OK [MESSAGELIMIT] done\r\n', /MESSAGELIMIT response code/],
        ['A1 OK [MESSAGELIMIT 0 5] done\r\n', /MESSAGELIMIT response code/],
        ['A1 OK [MESSAGELIMIT 10 5 6] done\r\n', /MESSAGELIMIT response code/]
    ];

    invalid.forEach(([transcript, error]) => {
        it('rejects ' + JSON.stringify(transcript), async () => {
            await assert.rejects(validateResponses(transcript), error);
        });
    });

    it('carries the UIDONLY state between chunks', async () => {
        const responses = await validateResponses('* ENABLED UIDONLY\r\nA1 OK done\r\n');
        assert.strictEqual(responses.uidonly, true);
        await validateResponses('* 4 UIDFETCH (FLAGS ())\r\n', { uidonly: true });
        await assert.rejects(validateResponses('* 4 FETCH (FLAGS ())\r\n', { uidonly: true }), /message number/);
    });

    it('keeps literals with their response', () => {
        const responses = splitResponses('* 1 FETCH (BODY[] {4}\r\na\r\nb) UID 1)\r\nA1 OK done\r\n');
        assert.strictEqual(responses.length, 2);
        assert.strictEqual(responses[0].literals[0].toString(), 'a\r\nb');
    });
});
