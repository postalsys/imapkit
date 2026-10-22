import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
    docsSidebar: [
        'intro',
        {
            type: 'category',
            label: 'Getting Started',
            collapsed: false,
            items: ['getting-started/installation', 'getting-started/quick-start', 'getting-started/command-line']
        },
        {
            type: 'category',
            label: 'Apps',
            collapsed: false,
            items: ['apps/overview', 'apps/desktop-windows']
        },
        {
            type: 'category',
            label: 'Guides',
            collapsed: false,
            items: [
                'guides/writing-client-tests',
                'guides/storage',
                'guides/authentication',
                'guides/strict-by-design',
                'guides/multiple-sessions',
                'guides/testing-from-other-languages'
            ]
        },
        {
            type: 'category',
            label: 'Fault Injection',
            items: ['faults/scripted-faults', 'faults/quirk-presets', 'faults/repeatable-tests']
        },
        {
            type: 'category',
            label: 'Control API',
            items: [
                'control-api/overview',
                'control-api/mailboxes-and-messages',
                'control-api/uidvalidity',
                'control-api/users-and-sessions',
                'control-api/events',
                'control-api/plugin-operations'
            ]
        },
        {
            type: 'category',
            label: 'REST API',
            items: ['rest-api/overview', 'rest-api/endpoints', 'rest-api/event-stream']
        },
        {
            type: 'category',
            label: 'Extensions',
            items: [
                'extensions/overview',
                'extensions/imap4rev2',
                'extensions/search-and-sort',
                'extensions/synchronization',
                'extensions/mailboxes',
                'extensions/access-control',
                'extensions/metadata-and-quota',
                'extensions/messages',
                'extensions/authentication-and-transport',
                'extensions/gmail'
            ]
        },
        {
            type: 'category',
            label: 'Reference',
            items: ['reference/server-options', 'reference/server-api', 'reference/custom-plugins', 'reference/migrating-from-4', 'reference/known-issues']
        },
        {
            type: 'category',
            label: 'Contributing',
            items: ['contributing/running-tests', 'contributing/comparing-with-dovecot']
        },
        {
            type: 'html',
            value: `
                <div class="sidebar-ecosystem">
                    <div class="sidebar-ecosystem__title">From the ImapKit team</div>
                    <a href="https://emailengine.app/?utm_source=imapkit.com&utm_medium=sidebar&utm_campaign=oss-docs">
                        <strong>EmailEngine</strong>
                        <span>Self-hosted email API for Gmail, Microsoft 365 and IMAP</span>
                    </a>
                    <a href="https://imapflow.com/">
                        <strong>ImapFlow</strong>
                        <span>Modern IMAP client for Node.js, tested against ImapKit</span>
                    </a>
                    <a href="https://nodemailer.com/">
                        <strong>Nodemailer</strong>
                        <span>The standard email sending library for Node.js</span>
                    </a>
                </div>
            `,
            defaultStyle: false
        }
    ]
};

export default sidebars;
