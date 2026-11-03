/**
 * The pages of the OAuth provider: the consent page, error and info pages, and the index page at `/`. They are a
 * test tool's pages and say so (a striped "test server" ribbon, ImapKit's own mark, no password field), so that
 * nobody takes them for a real provider's sign-in. They run no script and load nothing, src/oauth/http.ts sends
 * them with a strict Content-Security-Policy.
 */

import type { Check, OAuthClient, PageData, PendingRequest } from './provider.js';
import { describeOutcome } from './policy.js';
import type { ConsentPolicy } from './policy.js';
import { isLoopback } from '../rest.js';

/** A user on the consent page */
export interface PageUser {
    name: string;
    displayName: string | undefined;
    consent: ConsentPolicy | undefined;
}

const escapeHtml = (value: unknown): string =>
    String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

const policyText = (policy: ConsentPolicy | null | undefined): string => (policy ? describeOutcome(policy) : 'server default');

const STYLE = `
:root{color-scheme:light dark;--bg:#eef1f6;--card:#fff;--text:#1b2430;--muted:#5d6877;--line:#d9dfe8;--accent:#2457c5;--accent-text:#fff;--accent-soft:#e8eefc;--ok:#1a7f37;--ok-soft:#e6f4ea;--warn:#8a5a00;--warn-soft:#fff4d6;--bad:#b42318;--bad-soft:#fdecea;--code:#f0f2f5;--focus:#2457c5}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--text:#e4e9f0;--muted:#9aa6b6;--line:#2b3440;--accent:#6e9bff;--accent-text:#0d1117;--accent-soft:#1b2640;--ok:#4cc06b;--ok-soft:#14281b;--warn:#e3b341;--warn-soft:#2d2411;--bad:#ff7b6e;--bad-soft:#331a18;--code:#1f252e;--focus:#8db0ff}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center;align-items:flex-start;padding:32px 16px}
main{width:100%;max-width:480px;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(16,32,64,.10)}
main.wide{max-width:760px}
.ribbon{background:repeating-linear-gradient(-45deg,#f5c542,#f5c542 10px,#efb429 10px,#efb429 20px);color:#3b2a00;font-weight:700;font-size:12px;letter-spacing:.05em;text-align:center;padding:5px 8px}
.body{padding:24px 26px 22px}
.brand{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;margin:0 0 16px}
.logo{width:26px;height:26px;border-radius:7px;background:linear-gradient(#3a6fd8,#1d4597);color:#fff;font-weight:800;font-size:12px;display:grid;place-items:center;flex:none}
h1{font-size:20px;line-height:1.3;margin:0 0 6px}
h2{font-size:14px;margin:20px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.small{font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
code{background:var(--code);padding:1px 5px;border-radius:4px}
fieldset{border:0;margin:0 0 14px;padding:0}
legend{font-weight:600;margin:0 0 8px;padding:0}
.acct{display:flex;align-items:center;gap:11px;padding:9px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:6px;cursor:pointer}
.acct:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.acct input{accent-color:var(--accent);width:16px;height:16px;margin:0;flex:none}
.av{width:30px;height:30px;border-radius:50%;color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
.who{min-width:0;flex:1}
.nm{font-weight:600;line-height:1.25;overflow-wrap:anywhere}
.em{font-size:12.5px;color:var(--muted);overflow-wrap:anywhere}
.tag{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap}
.tag.ok{background:var(--ok-soft);color:var(--ok)}.tag.warn{background:var(--warn-soft);color:var(--warn)}.tag.bad{background:var(--bad-soft);color:var(--bad)}.tag.info{background:var(--accent-soft);color:var(--accent)}.tag.note{background:var(--code);color:var(--muted)}
ul.scopes{list-style:none;padding:0;margin:0 0 12px;border:1px solid var(--line);border-radius:10px}
ul.scopes li{display:flex;gap:10px;padding:8px 12px;border-top:1px solid var(--line);align-items:baseline}
ul.scopes li:first-child{border-top:0}
.ck{color:var(--ok);font-weight:700}
.raw{margin-left:auto;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);text-align:right;overflow-wrap:anywhere}
.redir{font-size:13px;color:var(--muted);margin:0 0 16px;overflow-wrap:anywhere}
.btns{display:flex;flex-direction:row-reverse;gap:10px;margin:0 0 12px}
button{flex:1;font:inherit;font-weight:600;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer;text-align:center;text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button:hover{filter:brightness(1.05)}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible,.acct:has(input:focus-visible){outline:2px solid var(--focus);outline-offset:2px}
.remember{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--muted);margin:0 0 4px}
.remember input{accent-color:var(--accent)}
details{border-top:1px solid var(--line);padding:10px 0 0;margin-top:12px;font-size:13.5px}
summary{cursor:pointer;color:var(--accent);font-weight:600}
ul.checks{list-style:none;padding:0;margin:10px 0 6px}
ul.checks li{display:flex;gap:8px;padding:3px 0;align-items:baseline}
.kv{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);overflow-wrap:anywhere;margin:6px 0 0}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0}
select,input[type=text]{font:inherit;font-size:13.5px;padding:7px 9px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--text);flex:1;min-width:0}
.row button{flex:none}
.mark{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-size:22px;font-weight:700;margin:0 0 14px}
.mark.error{background:var(--bad-soft);color:var(--bad)}.mark.info{background:var(--accent-soft);color:var(--accent)}
pre{background:var(--code);border-radius:8px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin:0 0 6px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
footer{border-top:1px solid var(--line);padding:12px 26px;font-size:12.5px;color:var(--muted)}
@media (max-width:480px){body{padding:0}main{border-radius:0;border-left:0;border-right:0}.body{padding:20px 16px}footer{padding:12px 16px}}
`;

const AVATAR_COLORS = ['#7c5cf6', '#0e9f6e', '#d9480f', '#1c7ed6', '#c2255c', '#5c7cfa', '#2b8a3e'];

function avatar(name: string): string {
    let hash = 0;
    for (const char of name) {
        hash = (hash * 31 + (char.codePointAt(0) || 0)) >>> 0;
    }
    const letter = (name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
    return '<span class="av" aria-hidden="true" style="background:' + AVATAR_COLORS[hash % AVATAR_COLORS.length] + '">' + escapeHtml(letter) + '</span>';
}

function layout(title: string, body: string, options: { wide?: boolean; footer?: string } = {}): string {
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta name="robots" content="noindex"><title>' +
        escapeHtml(title) +
        ' - ImapKit</title><style>' +
        STYLE +
        '</style></head><body><main' +
        (options.wide ? ' class="wide"' : '') +
        '><div class="ribbon" role="note">IMAPKIT TEST SERVER · NOT A REAL SIGN-IN</div><div class="body">' +
        body +
        '</div>' +
        (options.footer ? '<footer>' + options.footer + '</footer>' : '') +
        '</main></body></html>'
    );
}

function brand(issuer: string): string {
    let host = issuer;
    try {
        host = new URL(issuer).host;
    } catch {
        // the issuer is always a URL once the server listens
    }
    return '<div class="brand"><span class="logo" aria-hidden="true">IK</span><span>ImapKit sign-in · ' + escapeHtml(host) + '</span></div>';
}

// the levels are the tag classes
const checkTag = (check: Check): string => '<span class="tag ' + check.level + '">' + check.level + '</span>';

/** The outcomes of the "Other outcomes" section of the consent page */
const OTHER_OUTCOMES: [string, string][] = [
    ['error:access_denied', 'Return access_denied'],
    ['error:invalid_scope', 'Return invalid_scope'],
    ['error:server_error', 'Return server_error'],
    ['error:temporarily_unavailable', 'Return temporarily_unavailable'],
    ['error:consent_required', 'Return consent_required'],
    ['error:login_required', 'Return login_required'],
    ['wrong-state', 'Approve, but redirect with a wrong state'],
    ['wrong-iss', 'Approve, but redirect with a wrong iss'],
    ['no-redirect', 'Do not redirect (let the client time out)']
];

/**
 * The consent page: pick an account, Allow or Deny
 *
 * @param {Object} data `{ request, users, scopes, issuer }`
 * @return {String} HTML
 */
export function consentPage(data: { request: PendingRequest; users: PageUser[]; scopes: Record<string, string>; issuer: string }): string {
    const { request, users, scopes, issuer } = data;
    const client = request.client;
    const selected = request.hintUser || (users[0] && users[0].name);
    const checks = request.checks.slice();
    if (selected && !selected.includes('@')) {
        checks.push({
            level: 'note',
            text: 'user name ' + JSON.stringify(selected) + ' has no @: clients that take the email claim as an address may refuse it'
        });
    }
    if (request.prompt.length) {
        checks.push({
            level: 'note',
            text: 'prompt=' + request.prompt.join(' ') + ': the consent page is shown because the policy is prompt (' + request.source + ')'
        });
    }
    if (request.ignored.length) {
        checks.push({ level: 'note', text: 'ignored parameters: ' + request.ignored.join(', ') });
    }
    const passed = checks.filter(check => check.level === 'ok').length;
    const flagged = checks.length - passed;
    const hasWarning = checks.some(check => check.level === 'warn');

    let target = request.redirectUri;
    let loopback = false;
    try {
        const url = new URL(request.redirectUri);
        target = url.origin !== 'null' ? url.origin + url.pathname : request.redirectUri;
        loopback = url.protocol === 'http:' && isLoopback(url.hostname);
    } catch {
        // checked when the request came in
    }

    const accounts = users.length
        ? users
              .map(user => {
                  const badges = [
                      user.name === request.hintUser ? '<span class="tag info">login_hint</span>' : '',
                      user.consent
                          ? '<span class="tag ' + (user.consent === 'approve' ? 'ok' : 'bad') + '">auto: ' + escapeHtml(policyText(user.consent)) + '</span>'
                          : ''
                  ].join('');
                  return (
                      '<label class="acct"><input type="radio" name="user" value="' +
                      escapeHtml(user.name) +
                      '"' +
                      (user.name === selected ? ' checked' : '') +
                      ' required>' +
                      avatar(user.displayName || user.name) +
                      '<span class="who"><span class="nm">' +
                      escapeHtml(user.displayName || user.name) +
                      '</span>' +
                      (user.displayName ? '<br><span class="em">' + escapeHtml(user.name) + '</span>' : '') +
                      '</span>' +
                      badges +
                      '</label>'
                  );
              })
              .join('')
        : '<p class="muted">This server has no users, so only Deny is possible.</p>';

    const scopeItems = request.scope
        .map(
            scope =>
                '<li><span class="ck" aria-hidden="true">✓</span><span>' +
                escapeHtml(scopes[scope] || scope) +
                '</span><span class="raw">' +
                escapeHtml(scope) +
                '</span></li>'
        )
        .join('');

    const params = [
        'client_id=' + client.id,
        'response_type=code',
        'scope=' + request.scope.join(' '),
        request.codeChallengeMethod ? 'code_challenge_method=' + request.codeChallengeMethod : '',
        request.prompt.length ? 'prompt=' + request.prompt.join(' ') : '',
        request.loginHint !== undefined ? 'login_hint=' + request.loginHint : ''
    ].filter(Boolean);

    const body =
        brand(issuer) +
        '<h1>' +
        escapeHtml(client.name) +
        ' wants to access your mailbox</h1>' +
        '<p class="muted small">Choose the account to sign in as. No password needed.' +
        (client.name !== client.id ? ' Client ID <code>' + escapeHtml(client.id) + '</code>.' : '') +
        '</p>' +
        '<form method="post" action="/authorize/decision"><input type="hidden" name="request" value="' +
        escapeHtml(request.id) +
        '">' +
        '<fieldset><legend>Account</legend>' +
        accounts +
        '</fieldset>' +
        '<fieldset><legend>It will be able to</legend><ul class="scopes">' +
        scopeItems +
        '</ul></fieldset>' +
        '<p class="redir">Returns to <strong>' +
        escapeHtml(target) +
        '</strong> ' +
        (loopback ? '<span class="tag ok">loopback</span>' : '') +
        '</p>' +
        '<div class="btns">' +
        (users.length ? '<button class="primary" type="submit" name="action" value="allow">Allow</button>' : '') +
        '<button type="submit" name="action" value="deny" formnovalidate>Deny</button></div>' +
        '<label class="remember"><input type="checkbox" name="remember" value="on"> Remember my choice for this app until the server restarts</label>' +
        '<details' +
        (hasWarning ? ' open' : '') +
        '><summary>Request details (' +
        passed +
        ' passed' +
        (flagged ? ', ' + flagged + ' to look at' : '') +
        ')</summary><ul class="checks">' +
        checks.map(check => '<li>' + checkTag(check) + '<span>' + escapeHtml(check.text) + '</span></li>').join('') +
        '</ul><p class="kv">' +
        escapeHtml(params.join(' · ')) +
        '</p><p class="kv">redirect_uri=' +
        escapeHtml(request.redirectUri) +
        '</p></details>' +
        '<details><summary>Other outcomes</summary><p class="muted small" style="margin:8px 0 0">Answer this sign-in with an error or a broken redirect, to test how the client handles it.</p>' +
        '<div class="row"><select id="outcome" name="outcome" aria-label="Outcome">' +
        OTHER_OUTCOMES.map(([value, label]) => '<option value="' + value + '">' + escapeHtml(label) + '</option>').join('') +
        '</select></div><div class="row"><input type="text" name="description" aria-label="error_description" placeholder="error_description (optional)" maxlength="300">' +
        '<button type="submit" name="action" value="outcome" formnovalidate>Send</button></div></details>' +
        '</form>';
    return layout('Sign in to ' + client.name, body, {
        footer: 'Decision source if not answered here: ' + escapeHtml(request.source) + '. This request stays open for 10 minutes.'
    });
}

/**
 * An error or info page, instead of a redirect
 *
 * @param {Object} page Page data
 * @param {String} issuer Issuer URL
 * @return {String} HTML
 */
export function messagePage(page: PageData, issuer: string): string {
    const body =
        brand(issuer) +
        '<div class="mark ' +
        page.tone +
        '" aria-hidden="true">' +
        (page.tone === 'error' ? '!' : 'i') +
        '</div><h1>' +
        escapeHtml(page.title) +
        '</h1><p class="muted">' +
        escapeHtml(page.message) +
        '</p>' +
        (page.details || []).map(detail => '<pre>' + escapeHtml(detail) + '</pre>').join('');
    return layout(page.title, body, {
        footer: page.tone === 'error' ? 'The client was not redirected: there was no safe place to send the answer to.' : 'You can close this tab.'
    });
}

/**
 * The index page at `/`: issuer, clients and endpoints
 *
 * @param {Object} data `{ issuer, consent, clients, users, mailScope }`
 * @return {String} HTML
 */
export function indexPage(data: { issuer: string; consent: ConsentPolicy; clients: OAuthClient[]; users: PageUser[]; mailScope: string }): string {
    const { issuer, clients, users } = data;
    const endpoints = ['/.well-known/openid-configuration', '/authorize', '/token', '/userinfo', '/jwks', '/revoke'];
    const body =
        brand(issuer) +
        '<h1>ImapKit OAuth 2.0 / OpenID Connect provider</h1>' +
        '<p class="muted">A test identity provider for mail clients. Tokens it issues log in to this ImapKit server over IMAP (XOAUTH2, OAUTHBEARER) and SMTP (AUTH XOAUTH2) with the <code>' +
        escapeHtml(data.mailScope) +
        '</code> scope. Default consent policy: <strong>' +
        escapeHtml(policyText(data.consent)) +
        '</strong>.</p>' +
        '<h2>Issuer</h2><pre>' +
        escapeHtml(issuer) +
        '</pre>' +
        '<h2>Clients</h2><table><thead><tr><th>Client ID</th><th>Name</th><th>Type</th><th>Consent</th></tr></thead><tbody>' +
        clients
            .map(
                client =>
                    '<tr><td><code>' +
                    escapeHtml(client.id) +
                    '</code></td><td>' +
                    escapeHtml(client.name) +
                    '</td><td>' +
                    (client.secret === null ? 'public' : 'confidential') +
                    '</td><td>' +
                    escapeHtml(policyText(client.consent)) +
                    '</td></tr>'
            )
            .join('') +
        '</tbody></table>' +
        '<h2>Users</h2><p class="small">' +
        (users.length ? users.map(user => '<code>' + escapeHtml(user.name) + '</code>').join(' ') : 'none') +
        '</p><h2>Endpoints</h2><p class="small">' +
        endpoints.map(path => '<code>' + escapeHtml(path) + '</code>').join(' ') +
        '</p>';
    return layout('OAuth provider', body, { wide: true, footer: 'Documentation: https://imapkit.com/docs/guides/oauth' });
}
