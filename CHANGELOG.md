# Changelog

## [5.2.0](https://github.com/postalsys/imapkit/compare/v5.1.0...v5.2.0) (2026-10-22)


### Features

* add append and trace events and the tls option for an implicit TLS listener ([18c1c26](https://github.com/postalsys/imapkit/commit/18c1c2605fe1836874222a6eee84e3ac6d254e56))

## [5.1.0](https://github.com/postalsys/imapkit/compare/v5.0.1...v5.1.0) (2026-10-15)


### Features

* run ImapKit in browsers with server.connect() and the imapkit/browser bundle ([a21923e](https://github.com/postalsys/imapkit/commit/a21923efbcfd7b85cbb6cd7471828d370295a261))

## [5.0.1](https://github.com/postalsys/imapkit/compare/v5.0.0...v5.0.1) (2026-10-08)


### Bug Fixes

* AUTHENTICATE checks the connection state before the mechanism ([0747678](https://github.com/postalsys/imapkit/commit/0747678d007dbee1a0d247041d24d149dc8a72b1))
* CLI startup errors and port, event streams end on graceful shutdown ([d1e4d1f](https://github.com/postalsys/imapkit/commit/d1e4d1f33115277c890f398390ef1add29deb8e6))
* CREATE-SPECIAL-USE answers BAD for USE entries that are not use-attr ([1d7d7e7](https://github.com/postalsys/imapkit/commit/1d7d7e77cb660b204c99eafb4bba60125a1b9421))
* deprecate the ignored xoauth2.sessionTimeout user option ([953e965](https://github.com/postalsys/imapkit/commit/953e9652874fbd8bc9d983579fe1a7004b5c1c28))
* end UID SEARCH with OK [EXPUNGEISSUED] when it holds back an EXPUNGE ([ed82da8](https://github.com/postalsys/imapkit/commit/ed82da84e24b93cc151183ae4d948104351e5398))
* ENVELOPE sends an obsolete source route as addr-adl ([6363543](https://github.com/postalsys/imapkit/commit/636354387f58b94c82655cec567cbaf5562b648f))
* LIST patterns match full names with a prefixed personal namespace ([371f99a](https://github.com/postalsys/imapkit/commit/371f99aba307e4e042b76b5b9a484fbc4da434b8))
* LIST treats # as a break out character that overrides the reference ([99d50c2](https://github.com/postalsys/imapkit/commit/99d50c28b6fb0a22a8c29b3d77f29f4437a1a8f9))
* METADATA and METADATA-SERVER load ENABLE ([e25c9a8](https://github.com/postalsys/imapkit/commit/e25c9a8971b4566ede897dfef67a8199bb08ed5a))
* refuse quirk presets that remove a plugin IMAP4rev2 requires ([a8b13c1](https://github.com/postalsys/imapkit/commit/a8b13c1444a54f3fe0afc25e32e51f17503a39ce))
* refuse storage internal dates that are not RFC 3501 date-time values ([04babcd](https://github.com/postalsys/imapkit/commit/04babcde6a073ed7f703c16767f1f0efb332db3c))
* report new messages and flag changes before FETCH, STORE and SEARCH responses ([41c6856](https://github.com/postalsys/imapkit/commit/41c68564afe6d3aff0b3eb28ee4f63edadf76a53))
* send RECENT after the EXISTS of new messages to IMAP4rev1 sessions ([172d6be](https://github.com/postalsys/imapkit/commit/172d6becf6e7f9e32975ed075b1febf6d92687fc))
* STORE accepts exactly the flags PERMANENTFLAGS lists ([d48a48d](https://github.com/postalsys/imapkit/commit/d48a48d1ff256fe99dd1f66180c1d2429020f6c9))

## [5.0.0](https://github.com/postalsys/imapkit/compare/v4.3.1...v5.0.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* the XTOYBIRD plugin is removed, use the control API (README "Migrating from 4.x"). smtp-server is an optional peer dependency now, install it for --smtpPort or the new smtp option.

### Features

* chance script rule option and scriptSeed, now option for repeatable tests ([c04303a](https://github.com/postalsys/imapkit/commit/c04303a0f04ffe523c78453c5a949b7f9bb80b35))
* chunkDelay 0 or 'tick' splits output on the wire without a delay ([#89](https://github.com/postalsys/imapkit/issues/89)) ([c04303a](https://github.com/postalsys/imapkit/commit/c04303a0f04ffe523c78453c5a949b7f9bb80b35))
* control API, REST API and quirk presets, XTOYBIRD removed ([c04303a](https://github.com/postalsys/imapkit/commit/c04303a0f04ffe523c78453c5a949b7f9bb80b35))
* plugin operations for ACL, QUOTA, METADATA, SPECIAL-USE and OBJECTID ([c04303a](https://github.com/postalsys/imapkit/commit/c04303a0f04ffe523c78453c5a949b7f9bb80b35))
* quiet script event for unsolicited output between commands and during IDLE ([#88](https://github.com/postalsys/imapkit/issues/88)) ([c04303a](https://github.com/postalsys/imapkit/commit/c04303a0f04ffe523c78453c5a949b7f9bb80b35))
* quirk presets (quirks option, --quirk) for Apache James, Yahoo and Microsoft 365 behavior ([#87](https://github.com/postalsys/imapkit/issues/87)) ([c04303a](https://github.com/postalsys/imapkit/commit/c04303a0f04ffe523c78453c5a949b7f9bb80b35))
* session, command and waiting events, server.start() and server.stop() ([c04303a](https://github.com/postalsys/imapkit/commit/c04303a0f04ffe523c78453c5a949b7f9bb80b35))
* the storage option is validated, the JSON Schema is exported as storageSchema ([c04303a](https://github.com/postalsys/imapkit/commit/c04303a0f04ffe523c78453c5a949b7f9bb80b35))


### Bug Fixes

* ACL and annotations are dropped and inherited on DELETE, CREATE and RENAME of the control API too ([c04303a](https://github.com/postalsys/imapkit/commit/c04303a0f04ffe523c78453c5a949b7f9bb80b35))

## [4.3.1](https://github.com/postalsys/imapkit/compare/v4.3.0...v4.3.1) (2026-10-08)


### Bug Fixes

* script rule close: 'reset' threw ERR_INVALID_HANDLE_TYPE on TLS connections ([89fb431](https://github.com/postalsys/imapkit/commit/89fb4317a2d183bf362d084d2767f888aae0f6b4)), closes [#84](https://github.com/postalsys/imapkit/issues/84)

## [4.3.0](https://github.com/postalsys/imapkit/compare/v4.2.0...v4.3.0) (2026-10-08)


### Features

* literals and defer actions for script rules ([c26ddce](https://github.com/postalsys/imapkit/commit/c26ddceeb3e91a502b4a5090579838280ddefb28)), closes [#78](https://github.com/postalsys/imapkit/issues/78) [#79](https://github.com/postalsys/imapkit/issues/79)


### Bug Fixes

* script rule close: 'reset' could lose the RST after the last output ([6b93d9b](https://github.com/postalsys/imapkit/commit/6b93d9b097245b112b80b260c7a65d08ea5c0a60)), closes [#81](https://github.com/postalsys/imapkit/issues/81)

## [4.2.0](https://github.com/postalsys/imapkit/compare/v4.1.1...v4.2.0) (2026-10-07)


### Features

* script rules that make the server misbehave on purpose ([43edc38](https://github.com/postalsys/imapkit/commit/43edc384d49b13d7c1197d06e43395b81a1d928c))

## [4.1.1](https://github.com/postalsys/imapkit/compare/v4.1.0...v4.1.1) (2026-10-07)


### Bug Fixes

* parse address groups without a display name ([9cc4aa4](https://github.com/postalsys/imapkit/commit/9cc4aa427234cd436f06b3f175d9bcb917bdfa32))
* parse address groups without a display name ([bc7a42b](https://github.com/postalsys/imapkit/commit/bc7a42b0ea0479c29facba7363a2d05c13250e68))

## [4.1.0](https://github.com/postalsys/imapkit/compare/v4.0.3...v4.1.0) (2026-10-07)


### Features

* migrate to TypeScript with ES module and CommonJS builds ([04552ba](https://github.com/postalsys/imapkit/commit/04552baa8c6d3dfac31b485fb6c2c1a79dcb71ca))
* migrate to TypeScript with ES module and CommonJS builds ([b76037e](https://github.com/postalsys/imapkit/commit/b76037e9985cb619b5fc9a11a1992864636d7d55))

## [4.0.3](https://github.com/postalsys/imapkit/compare/v4.0.2...v4.0.3) (2026-10-07)


### Bug Fixes

* drop the doubled space in the 'Invalid FETCH argument' error text ([3c896b5](https://github.com/postalsys/imapkit/commit/3c896b5b62e7aa684b0b4679d08b500616583de6))
* drop the doubled space in the 'Invalid FETCH argument' error text ([9ef4539](https://github.com/postalsys/imapkit/commit/9ef45398790e3d7ece800e809375fcad156e3476)), closes [#67](https://github.com/postalsys/imapkit/issues/67)

## [4.0.2](https://github.com/postalsys/imapkit/compare/v4.0.1...v4.0.2) (2026-10-07)


### Bug Fixes

* decode RFC 2047 encoded words in SEARCH header keys ([6891920](https://github.com/postalsys/imapkit/commit/68919201057c3965fa3e6c70010cf767c356517e))
* decode RFC 2047 encoded words in SEARCH header keys ([132707c](https://github.com/postalsys/imapkit/commit/132707c1824be88283e0ca731db938fcf5df25e1)), closes [#65](https://github.com/postalsys/imapkit/issues/65)

## [4.0.1](https://github.com/postalsys/imapkit/compare/v4.0.0...v4.0.1) (2026-10-07)


### Bug Fixes

* correct typos in the --help output ([b108887](https://github.com/postalsys/imapkit/commit/b1088878cc6d5ec0083cc872b6a38127b98ec836))
* correct typos in the --help output ([7a2e1db](https://github.com/postalsys/imapkit/commit/7a2e1dba3d0e98c0f1fda9ad6fd24f5b95d60fef))

## [4.0.0](https://github.com/postalsys/imapkit/compare/v3.3.1...v4.0.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* install imapkit instead of hoodiecrow-imap. The command is imapkit, its environment variables start with IMAPKIT_ instead of HOODIECROW_, the server greeting and SMTP banner say ImapKit, and the compare tool's Dovecot container is named imapkit-dovecot. The API, plugins, storage format and XTOYBIRD commands are unchanged.

### Features

* rename the project to ImapKit (npm package imapkit) ([6ebb093](https://github.com/postalsys/imapkit/commit/6ebb0939045f4c6a9889f9fa8ff5680e1935241a))

## [3.3.1](https://github.com/postalsys/hoodiecrow-imap/compare/v3.3.0...v3.3.1) (2026-10-07)


### Bug Fixes

* accept atom command names and only load built-in command handlers ([24279bb](https://github.com/postalsys/hoodiecrow-imap/commit/24279bbba9d8490adce6a2a381f0603d83afa2a9))
* accept atom command names and only load built-in command handlers ([ecb2d85](https://github.com/postalsys/hoodiecrow-imap/commit/ecb2d8509280d19ff3c8291fe79ab0f222cae994))

## [3.3.0](https://github.com/postalsys/hoodiecrow-imap/compare/v3.2.0...v3.3.0) (2026-10-07)


### Features

* add IMAP4rev2 plugin (RFC 9051) and RFC 5530 response codes ([b8daf1d](https://github.com/postalsys/hoodiecrow-imap/commit/b8daf1dc5327885a6bd8f31544690dff55af0a40))
* add IMAP4rev2 plugin (RFC 9051) and RFC 5530 response codes ([69415ef](https://github.com/postalsys/hoodiecrow-imap/commit/69415ef0aac58affc143223af67bb37646508b0c))
* add NOTIFY plugin (RFC 5465) ([9b0c2f5](https://github.com/postalsys/hoodiecrow-imap/commit/9b0c2f5f017be480a6254023c218c6231b337393))
* add NOTIFY plugin (RFC 5465) ([881a7a1](https://github.com/postalsys/hoodiecrow-imap/commit/881a7a1bf77dbd0f14ed7fc18805de543e3aa60f))
* add PARTIAL, CONTEXT=SEARCH, CONTEXT=SORT, ESORT and MULTISEARCH plugins ([94e923e](https://github.com/postalsys/hoodiecrow-imap/commit/94e923eab1dd5935eab48ca00cdb38276d9963a2))
* add PARTIAL, CONTEXT=SEARCH, CONTEXT=SORT, ESORT and MULTISEARCH plugins ([148a7dc](https://github.com/postalsys/hoodiecrow-imap/commit/148a7dca12b056fbe6249157bbfc8027e7b9ef61))
* add UIDONLY (RFC 9586), MESSAGELIMIT and SAVELIMIT (RFC 9738) plugins ([517bdc6](https://github.com/postalsys/hoodiecrow-imap/commit/517bdc6a3771b14e7fc7a39070dd343b28ccf6f5))
* add UIDONLY (RFC 9586), MESSAGELIMIT and SAVELIMIT (RFC 9738) plugins ([af4de8b](https://github.com/postalsys/hoodiecrow-imap/commit/af4de8bab604964ca494ebcbfbca269069a5406f))
* number64 partial ranges, LARGER and SMALLER in IMAP4rev2 sessions ([ee52da0](https://github.com/postalsys/hoodiecrow-imap/commit/ee52da0beb61567018db204523734ae11fb04ae1))
* number64 partial ranges, LARGER and SMALLER in IMAP4rev2 sessions ([82c0a13](https://github.com/postalsys/hoodiecrow-imap/commit/82c0a13f9a2b8e557f6f44bda8e5661136cecaa3))
* X-GM-THRID follows the OBJECTID THREADID when both are loaded ([7bb4916](https://github.com/postalsys/hoodiecrow-imap/commit/7bb491674dd8222094386488613574455a5776e1))


### Bug Fixes

* ACL refuses APPEND and REPLACE targets before the literal ([5737da8](https://github.com/postalsys/hoodiecrow-imap/commit/5737da88bde0b1da12e0a6c609f2460aa0da37ab))
* answer BAD for sequence numbers past the end of the mailbox ([15b0152](https://github.com/postalsys/hoodiecrow-imap/commit/15b015251504ac0ef00f1d7efc9c200e7be92340))
* answer changes to a read-only mailbox with NO [CLIENTBUG] ([3fa6d38](https://github.com/postalsys/hoodiecrow-imap/commit/3fa6d380dd1a0478187f95c5085d994225f292fe))
* CHANGEDSINCE and UNCHANGEDSINCE follow the RFC 7162 grammar ([2ae6802](https://github.com/postalsys/hoodiecrow-imap/commit/2ae680294942ee7e4b042f37bcaa3b1d0927246f))
* close the selected mailbox in one place, with CLOSED on ACL refusals ([5900768](https://github.com/postalsys/hoodiecrow-imap/commit/5900768f0ed70c7f2546cd1de74212b4ffc6b075))
* DELETE leaves a bare \Noselect placeholder and CREATE replaces it ([23367f8](https://github.com/postalsys/hoodiecrow-imap/commit/23367f8e8874d26b5b54ababfe64937ebbe5c093))
* enforce \Noinferiors in any spelling for CREATE and RENAME ([db9a7ad](https://github.com/postalsys/hoodiecrow-imap/commit/db9a7ad00053475bb32344fbc1c346d12c302c13))
* enforce \Noinferiors in any spelling, report flag changes once per message ([d724227](https://github.com/postalsys/hoodiecrow-imap/commit/d724227132616fa7c593b5c985468af8671b46ab))
* follow RFC 2180 for messages expunged by another session and DELETE of a selected mailbox ([0a4ee79](https://github.com/postalsys/hoodiecrow-imap/commit/0a4ee7958e08b2c18a3ccf090e3ebc70c9c0aa5b))
* keep keywords in FLAGS after the last message with them is gone ([63e2aa5](https://github.com/postalsys/hoodiecrow-imap/commit/63e2aa517bc9abf11274970b14fe89ae5547fc73))
* keep subscriptions as names that outlive DELETE and RENAME ([fb796f5](https://github.com/postalsys/hoodiecrow-imap/commit/fb796f51e4bf1ee180950e88b1d1910f627c019c))
* NIL is an atom in astring arguments, STORE takes astring labels ([7e210e1](https://github.com/postalsys/hoodiecrow-imap/commit/7e210e1798b05756eafd689615f439c593872f20))
* refuse APPEND to a missing mailbox before the literal is sent ([d6ad3ed](https://github.com/postalsys/hoodiecrow-imap/commit/d6ad3eddb5cd0bf385f3cd985136e5825293a267))
* refuse mailbox names with an empty hierarchy level ([df82005](https://github.com/postalsys/hoodiecrow-imap/commit/df8200518a9e5123d8c70719f561b324d557d17f))
* refuse sequence set and URL numbers above 2^32-1 ([ee8091b](https://github.com/postalsys/hoodiecrow-imap/commit/ee8091bb13c720bf3d02809405298ac165ca6f40))
* refuse STARTTLS with pipelined commands through a noPipelining option ([76fc470](https://github.com/postalsys/hoodiecrow-imap/commit/76fc47075a991fb8ad4538a3117262821c391e07))
* refuse the commands pipelined after a refused STARTTLS or COMPRESS ([8981241](https://github.com/postalsys/hoodiecrow-imap/commit/8981241b6a1c52df0c40c440469d0926afad742c))
* report a flag change of another session once per message ([5f3a9ff](https://github.com/postalsys/hoodiecrow-imap/commit/5f3a9ffc189f51e8f8588baf7824459ef7bd7850))
* RFC 2180 multi-access behavior and RFC 2683 checks ([6463734](https://github.com/postalsys/hoodiecrow-imap/commit/64637348f87953677dd3542b246ae36800cc0824))
* STATUS DELETED only after ENABLE IMAP4rev2, ENABLED lists canonical names ([680f051](https://github.com/postalsys/hoodiecrow-imap/commit/680f0514579df77888be17c80aa7e6417e484d07))
* subscriptions, DELETE placeholders, keywords, user names, sequence ranges and X-GM-EXT-1 ([ba051a2](https://github.com/postalsys/hoodiecrow-imap/commit/ba051a20ef150b36e551416340cfdbd444ba2efa))
* treat user names as unicode strings for every login method ([5a64632](https://github.com/postalsys/hoodiecrow-imap/commit/5a6463270932d5434e495d67350cdb2e1fa08f8b))
* X-GM-EXT-1 labels follow the session mailbox name form, add X-GM-RAW ([1c4c7b8](https://github.com/postalsys/hoodiecrow-imap/commit/1c4c7b85427ac20485a12230b0a1cf634f35a880))
* X-GM-RAW treats operator names like constructor: as text ([d79ba75](https://github.com/postalsys/hoodiecrow-imap/commit/d79ba7523d575d5cda99de0fb9a70eb4f99c1e30))
* XTOYBIRD only for the ACL owner when ACL is loaded ([3efb210](https://github.com/postalsys/hoodiecrow-imap/commit/3efb210abfcebc6a18a0e2fe3add7a7c3c330fb7))

## [3.2.0](https://github.com/postalsys/hoodiecrow-imap/compare/v3.1.0...v3.2.0) (2026-10-07)


### Features

* ACL rights for unsolicited METADATA responses and QUOTA ([7b7053c](https://github.com/postalsys/hoodiecrow-imap/commit/7b7053c49e64a01f8b0e4da89a3d6dc2436c7bf6))
* ACL with extended LIST, LIST-MYRIGHTS and METADATA ([0835ab5](https://github.com/postalsys/hoodiecrow-imap/commit/0835ab5732471b8f59a21456ece634cf30ad2c53))
* add ACL plugin (RFC 4314) ([247246d](https://github.com/postalsys/hoodiecrow-imap/commit/247246dfdba01d03658dcc6dbda24dc369c63bde))
* add ACL plugin (RFC 4314) ([1174446](https://github.com/postalsys/hoodiecrow-imap/commit/1174446c54e239eb7a4d1fb4f91057ae435a9b98))
* add BINARY extension (RFC 3516) ([85d79e3](https://github.com/postalsys/hoodiecrow-imap/commit/85d79e3ad219973875efcf94a99a1e98047958bd))
* add BINARY extension (RFC 3516) ([baa3eab](https://github.com/postalsys/hoodiecrow-imap/commit/baa3eab68acb1120754149717ce6f654561f674b))
* add COMPRESS=DEFLATE, LITERAL-, OAUTHBEARER and UNAUTHENTICATE plugins ([15a5dda](https://github.com/postalsys/hoodiecrow-imap/commit/15a5ddac15fb9c7e67d2e7cac6aa189db418d98f))
* add COMPRESS=DEFLATE, LITERAL-, OAUTHBEARER and UNAUTHENTICATE plugins ([ad50888](https://github.com/postalsys/hoodiecrow-imap/commit/ad5088814bed842efccdd1b65e4304e8db722838))
* add ESEARCH and SEARCHRES plugins and SEARCH MODSEQ for CONDSTORE ([42eadd5](https://github.com/postalsys/hoodiecrow-imap/commit/42eadd597d560bf75d78dc11d052d6f0d15e3067))
* add ESEARCH and SEARCHRES plugins and SEARCH MODSEQ for CONDSTORE ([332fe30](https://github.com/postalsys/hoodiecrow-imap/commit/332fe30b6fa876b4af2e66b4e653369963511cb5))
* add LIST-EXTENDED, LIST-STATUS and STATUS=SIZE plugins ([393ca86](https://github.com/postalsys/hoodiecrow-imap/commit/393ca86c1d9acd9d2cb5b0a05697c10790918943))
* add LIST-EXTENDED, LIST-STATUS and STATUS=SIZE plugins ([1db2c21](https://github.com/postalsys/hoodiecrow-imap/commit/1db2c21ec020f2638f6a3fb80f7abea2e6514d2e))
* add METADATA and METADATA-SERVER plugins (RFC 5464) ([401e818](https://github.com/postalsys/hoodiecrow-imap/commit/401e8180a82cf147eac05155840a411a48f1e4f7))
* add METADATA and METADATA-SERVER plugins (RFC 5464) ([99333dd](https://github.com/postalsys/hoodiecrow-imap/commit/99333ddaee66f8a561f1022db62bd9abecffb19c))
* add MULTIAPPEND, CATENATE, REPLACE and APPENDLIMIT plugins ([8824f4b](https://github.com/postalsys/hoodiecrow-imap/commit/8824f4b3f99d4620e88246f1e3d5731bded639e2))
* add MULTIAPPEND, CATENATE, REPLACE and APPENDLIMIT plugins ([dc49542](https://github.com/postalsys/hoodiecrow-imap/commit/dc495429cd1f95eebc868e46d46c0e7468f8858e))
* add PREVIEW plugin (RFC 8970) ([ac433d6](https://github.com/postalsys/hoodiecrow-imap/commit/ac433d6b22aab9fdfad491c4821a58102511fa84))
* add PREVIEW plugin (RFC 8970) ([b604d44](https://github.com/postalsys/hoodiecrow-imap/commit/b604d44d2ce1e9e775323a6f3c06cf5bac49d824))
* add QRESYNC plugin (RFC 7162 section 3.2) ([f6abb42](https://github.com/postalsys/hoodiecrow-imap/commit/f6abb42157133608a9dc2fe264e1b6438ae8ee62))
* add QRESYNC plugin (RFC 7162 section 3.2) ([5ad8ae9](https://github.com/postalsys/hoodiecrow-imap/commit/5ad8ae96292012db6ff68a10abe2c5e5cf8b77b7))
* add QUOTA, OBJECTID and SAVEDATE plugins ([ef6f55f](https://github.com/postalsys/hoodiecrow-imap/commit/ef6f55f91c12c1264316a7e09f69b037d24bf367))
* add QUOTA, OBJECTID and SAVEDATE plugins ([af92bc6](https://github.com/postalsys/hoodiecrow-imap/commit/af92bc6c544e1a87b63c148550a4cb1009a87847))
* add SORT, SORT=DISPLAY and THREAD plugins ([8c9eaff](https://github.com/postalsys/hoodiecrow-imap/commit/8c9eaff917c16e97cdf242e8b4147e361a90f71a))
* add SORT, SORT=DISPLAY, THREAD=ORDEREDSUBJECT and THREAD=REFERENCES plugins ([116a374](https://github.com/postalsys/hoodiecrow-imap/commit/116a3748d1aad69760145892141540039612e55c))
* add UTF8=ACCEPT plugin (RFC 9755) ([c2768fe](https://github.com/postalsys/hoodiecrow-imap/commit/c2768fe6bef369bb99c45d65618f380650f6f5a0))
* add UTF8=ACCEPT plugin (RFC 9755) ([0a8a569](https://github.com/postalsys/hoodiecrow-imap/commit/0a8a569545786f7e3d0a815a6728f52bbf0b0595))
* literal8 messages for MULTIAPPEND and REPLACE ([64b06af](https://github.com/postalsys/hoodiecrow-imap/commit/64b06af3fef62e3cb72a6cbe055c8f6a367b614a))
* literal8 values for METADATA, BINARY with CATENATE and REPLACE tests ([40375de](https://github.com/postalsys/hoodiecrow-imap/commit/40375dea0dfb996548f9323428f0f02ae3b0aed2))
* require the ACL r right for CATENATE URLs ([22429b8](https://github.com/postalsys/hoodiecrow-imap/commit/22429b840a4be50800e1015f170e4546c5724229))


### Bug Fixes

* **compare:** seed Dovecot with the original message octets ([1dd5c42](https://github.com/postalsys/hoodiecrow-imap/commit/1dd5c422cb6fe1db227293c3c01dc09787b4eecb))
* discard the SEARCHRES result on UNAUTHENTICATE (RFC 8437 section 4.1) ([56b9e3c](https://github.com/postalsys/hoodiecrow-imap/commit/56b9e3c58aeb1cf238fb6299f75f761c554d956a))
* forget the user and ACL rights on UNAUTHENTICATE ([190529a](https://github.com/postalsys/hoodiecrow-imap/commit/190529a6322e078813a7650f3c749bbed30f2ed0))
* send ACL response mailbox names in the session form ([41b13da](https://github.com/postalsys/hoodiecrow-imap/commit/41b13dac5fb769d1ce8d59b3c4fc05174ec2be6a))
* set the user name after AUTHENTICATE OAUTHBEARER ([403ec37](https://github.com/postalsys/hoodiecrow-imap/commit/403ec37d3d4c05417494294ab4570cbd62883776))
* update imap-handler to 1.2.0 and imapflow to 2.2.7 ([d111112](https://github.com/postalsys/hoodiecrow-imap/commit/d111112b888de81e21a036c004b691713079026d))
* update imap-handler to 1.2.0 and imapflow to 2.2.7 ([36f78b0](https://github.com/postalsys/hoodiecrow-imap/commit/36f78b0a43c275fcbaccf7d3dbf297daa767897e))

## [3.1.0](https://github.com/postalsys/hoodiecrow-imap/compare/v3.0.1...v3.1.0) (2026-10-07)


### Features

* support X-GM-THRID in the X-GM-EXT-1 plugin ([9724455](https://github.com/postalsys/hoodiecrow-imap/commit/9724455aa6aab12aa557fc372f26fee86bee76bb))


### Bug Fixes

* add FETCH RFC822.TEXT and stop RFC822.HEADER from setting \Seen ([14b3fa7](https://github.com/postalsys/hoodiecrow-imap/commit/14b3fa7feec101cbd7310093d529e6ff68b8f853))
* add text to status responses that only carry a response code ([7244dbb](https://github.com/postalsys/hoodiecrow-imap/commit/7244dbb84bba0b0df8282e413689bcc2ddd904e9))
* address the 2026-10-06 hoodiecrow and imap-handler review ([d0e89e2](https://github.com/postalsys/hoodiecrow-imap/commit/d0e89e28c906819754131e07641fa5b053d82341))
* advertise X-GM-EXT-1 and support .SILENT label stores ([620b52d](https://github.com/postalsys/hoodiecrow-imap/commit/620b52dfaa61bc08a8d4b866184118d20c58ebbb))
* check SEARCH strings against the declared CHARSET ([83f2180](https://github.com/postalsys/hoodiecrow-imap/commit/83f2180e9213beec6b56a742f3f35eb399ce4f10))
* enforce command states, CRLF and argument rules centrally ([98cf212](https://github.com/postalsys/hoodiecrow-imap/commit/98cf21200ce8174f01eb0fda400872dab86748f3))
* enforce the client rules of ID and ENABLE ([77b558c](https://github.com/postalsys/hoodiecrow-imap/commit/77b558c402280f03b31a2d49c6e3e55e3bc930f0))
* harden AUTHENTICATE PLAIN, XOAUTH2 and LOGIN ([5f5f901](https://github.com/postalsys/hoodiecrow-imap/commit/5f5f901b2ad1d904b2e56981d9b74270caee3737))
* harden the server core and mailbox commands ([a3d9e9a](https://github.com/postalsys/hoodiecrow-imap/commit/a3d9e9ad98bfccd03c6346299859a9fd8204fb33))
* ID client keys and NAMESPACE INBOX handling ([b1f32fb](https://github.com/postalsys/hoodiecrow-imap/commit/b1f32fba1a4d61c3bdb9f1252c4c86737cde6323))
* make ENABLE and CONDSTORE follow RFC 5161 and RFC 7162 ([1aa025c](https://github.com/postalsys/hoodiecrow-imap/commit/1aa025c7d62dda049dc4ccc30bab0ee7bbf0429f))
* MOVE checks the target mailbox and read-only state ([b01c821](https://github.com/postalsys/hoodiecrow-imap/commit/b01c821c9b3629e02b3db6cae2ede50bdd2a9d1f))
* never echo invalid tags or 8-bit octets in responses ([9c28a19](https://github.com/postalsys/hoodiecrow-imap/commit/9c28a195606652de2c1957e99b10ea786ad64a9f))
* no blank line in BODY[HEADER] of a message without body and blank line ([e4a1234](https://github.com/postalsys/hoodiecrow-imap/commit/e4a1234163431a7f2012797ba42a3151f5c48f8f))
* no SP between multipart bodies and between ENVELOPE addresses ([de221b0](https://github.com/postalsys/hoodiecrow-imap/commit/de221b053a9c8088cea894fbaefe1cf8d8ab6aef))
* notify other sessions of flag changes, include UID per RFC 7162 ([2ac1feb](https://github.com/postalsys/hoodiecrow-imap/commit/2ac1feb408119781e2bff46e9bc7ce0454c1c186))
* port WildDuck MIME parser for FETCH, ENVELOPE and BODYSTRUCTURE ([6e4b8eb](https://github.com/postalsys/hoodiecrow-imap/commit/6e4b8ebfd621f5cd35b11c99437d01fade57c0b2))
* refuse ambiguous pipelined commands (RFC 3501 section 5.5) ([78bac0d](https://github.com/postalsys/hoodiecrow-imap/commit/78bac0d1fea9458eb83e8f9ca2aebf9255bfc9b9))
* refuse literal data sent before the continuation request ([6a2ec6a](https://github.com/postalsys/hoodiecrow-imap/commit/6a2ec6a02f98f348219141fa5b8da4cde0b18a11))
* refuse STORE in a mailbox opened with EXAMINE ([57e8098](https://github.com/postalsys/hoodiecrow-imap/commit/57e8098c6804db13b5a6d165164cf9d84c43c77d))
* refuse STORE of flag keywords that are not atoms ([f0354ed](https://github.com/postalsys/hoodiecrow-imap/commit/f0354ed7f84ff6a9852638811ed3d5a398bbee30))
* require login for XTOYBIRD and stop USERADD prototype pollution ([2657db5](https://github.com/postalsys/hoodiecrow-imap/commit/2657db5a408b2f004b42ddbaefae8cb8de794ccf))
* rewrite SEARCH query parsing and matching per RFC 3501 ([b6e82cb](https://github.com/postalsys/hoodiecrow-imap/commit/b6e82cb7eaa46cbf6d54453d8de9c8a3518bd116))
* send RFC 5530 response codes for failed mailbox operations ([a22c19c](https://github.com/postalsys/hoodiecrow-imap/commit/a22c19c7117ee859eb3a7aa8fe1b033951326caf))
* share FETCH, STORE and SEARCH logic with their UID variants ([4dd1530](https://github.com/postalsys/hoodiecrow-imap/commit/4dd1530d449e8326072b67bea3fc1c546ca8fac2))
* SPECIAL-USE attributes are added to LIST attributes ([bcb03e8](https://github.com/postalsys/hoodiecrow-imap/commit/bcb03e8f05948f0c0780786052b1b77240b19801))
* stop pushing notifications after IDLE ends ([d524bfd](https://github.com/postalsys/hoodiecrow-imap/commit/d524bfdd1957991326656a752dc4322f69a05773))
* strict RFC guardrails and standards compliance test suite ([885e4de](https://github.com/postalsys/hoodiecrow-imap/commit/885e4de6f797b998574257061976be5774422273))
* UID EXPUNGE only removes messages with the \Deleted flag ([7f66a2c](https://github.com/postalsys/hoodiecrow-imap/commit/7f66a2ca5bb65b0c9009fe00aae033a952743ce2))
* update imap-handler to 1.0.1 ([005690a](https://github.com/postalsys/hoodiecrow-imap/commit/005690a23ac9db05eb6dc2868f223cca30f08609))
* update imap-handler to 1.1.0 ([f54ec34](https://github.com/postalsys/hoodiecrow-imap/commit/f54ec3493a2c9414e5c0ca582370f869e212bfc1))
* use per-session \Recent in SEARCH and FETCH, share the session snapshot lookup ([eb3f001](https://github.com/postalsys/hoodiecrow-imap/commit/eb3f0015593e243f4d8e9e6e2ad57fc404aa6df0))
* validate and dedupe plugin names at boot ([e8b6b34](https://github.com/postalsys/hoodiecrow-imap/commit/e8b6b349fc9ea564b035523bc50af20c85c234e8))
* validate APPEND flags, NO for unknown SASL mechanisms, help text ([26b4bf4](https://github.com/postalsys/hoodiecrow-imap/commit/26b4bf4430e110fa8b76897e8a894b7513264b16))
* XTOYBIRD only echoes plain user names in response text ([68622e8](https://github.com/postalsys/hoodiecrow-imap/commit/68622e83256a4eb5a5bb4949357c55cf91b47d46))

## [3.0.1](https://github.com/postalsys/hoodiecrow-imap/compare/v3.0.0...v3.0.1) (2026-10-06)


### Bug Fixes

* update imap-handler to 1.0.0 ([c105e1e](https://github.com/postalsys/hoodiecrow-imap/commit/c105e1e97df24baef90db946d979bf1e04f78779))

## [3.0.0](https://github.com/postalsys/hoodiecrow-imap/compare/v2.1.0...v3.0.0) (2026-10-06)


### ⚠ BREAKING CHANGES

* Node.js 20 or newer is required. The CLI entry point moved to bin/hoodiecrow.js and the test suite moved from tests/ to test/.

### Features

* modernize for Node.js 20+ ([a4eabde](https://github.com/postalsys/hoodiecrow-imap/commit/a4eabdefa39791262de8161b767ccf3c9959a774))
