import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
    title: 'ImapKit',
    tagline: 'A scriptable, in-memory IMAP server for testing IMAP clients',
    favicon: 'img/logo.svg',

    future: {
        v4: true
    },

    // Served from GitHub Pages at the root of the imapkit.com domain
    url: 'https://imapkit.com',
    baseUrl: '/',

    organizationName: 'postalsys',
    projectName: 'imapkit',

    onBrokenLinks: 'throw',

    markdown: {
        mermaid: true
    },
    themes: ['@docusaurus/theme-mermaid'],

    i18n: {
        defaultLocale: 'en',
        locales: ['en']
    },

    presets: [
        [
            'classic',
            {
                docs: {
                    sidebarPath: './sidebars.ts',
                    // the site lives in the docs/ folder of the imapkit repository, the pages in docs/docs/
                    editUrl: 'https://github.com/postalsys/imapkit/tree/master/docs/'
                },
                blog: false,
                theme: {
                    customCss: './src/css/custom.css'
                }
            } satisfies Preset.Options
        ]
    ],

    themeConfig: {
        image: 'img/social-card.png',
        colorMode: {
            respectPrefersColorScheme: true
        },
        navbar: {
            title: 'ImapKit',
            logo: {
                alt: 'ImapKit Logo',
                src: 'img/logo.svg'
            },
            items: [
                {
                    type: 'docSidebar',
                    sidebarId: 'docsSidebar',
                    position: 'left',
                    label: 'Documentation'
                },
                {
                    to: '/live',
                    label: 'Try it live',
                    position: 'left'
                },
                {
                    href: 'https://github.com/postalsys/imapkit',
                    label: 'GitHub',
                    position: 'right'
                },
                {
                    href: 'https://www.npmjs.com/package/imapkit',
                    label: 'npm',
                    position: 'right'
                }
            ]
        },
        footer: {
            style: 'dark',
            links: [
                {
                    title: 'Docs',
                    items: [
                        {
                            label: 'Introduction',
                            to: '/docs/'
                        },
                        {
                            label: 'Quick Start',
                            to: '/docs/getting-started/quick-start'
                        },
                        {
                            label: 'Try it live',
                            to: '/live'
                        }
                    ]
                },
                {
                    title: 'Community',
                    items: [
                        {
                            label: 'GitHub Issues',
                            href: 'https://github.com/postalsys/imapkit/issues'
                        },
                        {
                            label: 'npm',
                            href: 'https://www.npmjs.com/package/imapkit'
                        }
                    ]
                },
                {
                    title: 'Ecosystem',
                    items: [
                        {
                            label: 'EmailEngine',
                            href: 'https://emailengine.app/?utm_source=imapkit.com&utm_medium=footer&utm_campaign=oss-docs'
                        },
                        {
                            label: 'ImapFlow',
                            href: 'https://imapflow.com/'
                        },
                        {
                            label: 'Nodemailer',
                            href: 'https://nodemailer.com/'
                        },
                        {
                            label: 'Ethereal',
                            href: 'https://ethereal.email/'
                        }
                    ]
                }
            ],
            copyright: `Copyright © ${new Date().getFullYear()} Postal Systems OÜ. Licensed under MIT.`
        },
        prism: {
            theme: prismThemes.github,
            darkTheme: prismThemes.dracula,
            additionalLanguages: ['bash']
        }
    } satisfies Preset.ThemeConfig
};

export default config;
