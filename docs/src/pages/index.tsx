import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import CodeBlock from '@theme/CodeBlock';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Heading from '@theme/Heading';

import styles from './index.module.css';

const EXAMPLE = `import imapkit from 'imapkit';

const server = imapkit({ plugins: ['IDLE', 'CONDSTORE', 'QRESYNC'] });
const port = await server.start();

// ... connect your IMAP client to 127.0.0.1:port as testuser / testpass

// change the server while the client is connected
server.control.addMessage('INBOX', { raw: 'Subject: hello\\r\\n\\r\\nHi!\\r\\n' });
server.control.resetUidValidity('INBOX', { uids: 'shuffle', seed: 1 });

// and make it misbehave like real servers do
server.script.add({ on: 'command', command: 'SELECT', times: 1, send: '$TAG NO [UNAVAILABLE] Try again\\r\\n' });

await server.stop();`;

function HomepageHeader() {
    const { siteConfig } = useDocusaurusContext();
    return (
        <header className={clsx('hero hero--primary', styles.heroBanner)}>
            <div className={clsx('container', styles.heroGrid)}>
                <div className={styles.heroText}>
                    <Heading as="h1" className="hero__title">
                        {siteConfig.title}
                    </Heading>
                    <p className="hero__subtitle">{siteConfig.tagline}</p>
                    <div className={styles.buttons}>
                        <Link className="button button--secondary button--lg" to="/docs/getting-started/quick-start">
                            Quick Start
                        </Link>
                        <Link className={clsx('button button--outline button--lg', styles.outlineButton)} to="/live">
                            Try it live
                        </Link>
                    </div>
                    <code className={styles.install}>npm install --save-dev imapkit</code>
                </div>
                <img
                    className={styles.heroImage}
                    src={useBaseUrl('/img/hero.svg')}
                    alt="A test drives the ImapKit server, which pushes changes to IMAP clients"
                />
            </div>
        </header>
    );
}

function CodeSection() {
    return (
        <section className={styles.codeSection}>
            <div className="container">
                <div className="row">
                    <div className="col col--5">
                        <Heading as="h2">A real IMAP server inside your test</Heading>
                        <p>
                            ImapKit runs in the same process as your test suite, starts in milliseconds and keeps nothing on disk. Every test gets a fresh
                            server with exactly the mailboxes, messages, users and extensions it needs.
                        </p>
                        <p>
                            Your client talks real IMAP over a real socket, while the test changes the server underneath it and checks that the client keeps up.
                        </p>
                        <Link to="/docs/guides/writing-client-tests">Writing client tests →</Link>
                    </div>
                    <div className="col col--7">
                        <CodeBlock language="javascript" title="client.test.js">
                            {EXAMPLE}
                        </CodeBlock>
                    </div>
                </div>
            </div>
        </section>
    );
}

function EmailEngineBanner() {
    return (
        <section className={styles.banner}>
            <div className="container">
                <div className={styles.bannerInner}>
                    <Heading as="h3">Need a production email integration, not a mock server?</Heading>
                    <p>
                        <a
                            href="https://emailengine.app/?utm_source=imapkit.com&utm_medium=homepage&utm_campaign=oss-docs"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            <strong>EmailEngine</strong>
                        </a>{' '}
                        is a self-hosted email API by the team behind ImapKit and <a href="https://imapflow.com/">ImapFlow</a>. It turns Gmail, Microsoft 365
                        and IMAP accounts into REST endpoints, with managed OAuth2 and webhooks for incoming mail.
                    </p>
                </div>
            </div>
        </section>
    );
}

export default function Home(): ReactNode {
    return (
        <Layout
            title="In-memory IMAP server for testing IMAP clients"
            description="ImapKit is a scriptable, in-memory IMAP4rev1 and IMAP4rev2 server with 50+ extensions, a control API and scripted faults for testing IMAP clients."
        >
            <HomepageHeader />
            <main>
                <HomepageFeatures />
                <CodeSection />
                <EmailEngineBanner />
            </main>
        </Layout>
    );
}
