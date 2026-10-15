import type { ReactNode } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';
import Playground from '@site/src/components/Playground';

export default function Live(): ReactNode {
    return (
        <Layout
            title="Try it live"
            description="Talk IMAP to a real ImapKit server running in your browser: log in, select mailboxes, fetch and search messages, and turn extensions on and off."
            noFooter
        >
            <main>
                {/* the playground reads the URL and loads the browser bundle, so it never renders on the server */}
                <BrowserOnly fallback={<div style={{ minHeight: '70vh' }} />}>{() => <Playground />}</BrowserOnly>
            </main>
        </Layout>
    );
}
