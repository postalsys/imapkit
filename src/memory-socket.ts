import { EventEmitter } from 'node:events';

/**
 * One end of an in-memory connection, see `server.connect()`. It has the parts of `net.Socket` that the server and a
 * client use: `write(data, [encoding], [callback])`, `end()`, `destroy()`, `pause()`, `resume()`, `setEncoding()`,
 * the `data`, `end`, `close` and `error` events, and `encrypted`, which makes the server treat the connection like
 * one over TLS (as `tls.TLSSocket#encrypted` does). Written data reaches the other end on a later event loop turn,
 * one `data` event per write
 */
export class MemorySocket extends EventEmitter {
    /** the other end of the connection */
    declare peer: MemorySocket | null;
    declare destroyed: boolean;
    /** true if the connection counts as encrypted (implicit TLS, or after STARTTLS) */
    declare encrypted: boolean;
    declare _paused: boolean;
    declare _ending: boolean;
    declare _encoding: BufferEncoding | null;
    /** received data that waits while the socket is paused */
    declare _received: Buffer[];

    constructor() {
        super();
        this.peer = null;
        this.destroyed = false;
        this.encrypted = false;
        this._paused = false;
        this._ending = false;
        this._encoding = null;
        this._received = [];
    }

    /**
     * Sends data to the other end
     *
     * @param data Data to send, a string is encoded with `encoding` (utf8 by default)
     * @param encoding Encoding of a string, or the callback
     * @param callback Called once the other end received the data
     * @return true, there is no backpressure
     */
    write(data: Buffer | Uint8Array | string, encoding?: BufferEncoding | (() => void), callback?: () => void): boolean {
        if (typeof encoding === 'function') {
            callback = encoding;
            encoding = undefined;
        }
        if (this.destroyed || this._ending) {
            return false;
        }
        // no copy, like a real socket the data is not changed after it was written
        const chunk = typeof data === 'string' ? Buffer.from(data, encoding || 'utf8') : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        nextTurn(() => {
            this.peer?.deliver(chunk);
            callback?.();
        });
        return true;
    }

    /**
     * Ends the connection after the data written so far reached the other end, both ends close then
     *
     * @param data Data to send before the end
     */
    end(data?: Buffer | Uint8Array | string): this {
        if (data !== undefined) {
            this.write(data);
        }
        if (this.destroyed || this._ending) {
            return this;
        }
        this._ending = true;
        // queued after the writes, so the other end gets all data first
        nextTurn(() => {
            const peer = this.peer;
            if (peer && !peer.destroyed) {
                peer.emit('end');
                peer.close();
            }
            this.close();
        });
        return this;
    }

    /**
     * Closes both ends right away, data that did not reach the other end yet is lost
     *
     * @param error Error to emit on this end
     */
    destroy(error?: Error): this {
        if (this.destroyed) {
            return this;
        }
        const peer = this.peer;
        this.close(error);
        if (peer && !peer.destroyed) {
            peer.close();
        }
        return this;
    }

    /**
     * Closes the connection like a TCP RST: the other end gets an ECONNRESET error (`close: 'reset'` of script rules)
     */
    resetAndDestroy(): this {
        const peer = this.peer;
        this.destroy();
        if (peer) {
            const error: Error & { code?: string } = new Error('read ECONNRESET');
            error.code = 'ECONNRESET';
            nextTurn(() => peer.emit('error', error));
        }
        return this;
    }

    /**
     * STARTTLS without TLS: both ends count as encrypted from now on (`upgradeConnection` in src/server.ts)
     *
     * @param callback Called once the connection counts as encrypted
     */
    startTls(callback: () => void): void {
        this.encrypted = true;
        if (this.peer) {
            this.peer.encrypted = true;
        }
        callback();
    }

    pause(): this {
        this._paused = true;
        return this;
    }

    resume(): this {
        this._paused = false;
        while (this._received.length && !this._paused && !this.destroyed) {
            this.emitData(this._received.shift() as Buffer);
        }
        return this;
    }

    /**
     * Makes the `data` events carry strings instead of Buffers
     *
     * @param encoding Encoding of the strings, e.g. "utf8" or "binary"
     */
    setEncoding(encoding: BufferEncoding): this {
        this._encoding = encoding;
        return this;
    }

    deliver(chunk: Buffer): void {
        if (this.destroyed) {
            return;
        }
        if (this._paused) {
            this._received.push(chunk);
            return;
        }
        this.emitData(chunk);
    }

    private emitData(chunk: Buffer): void {
        this.emit('data', this._encoding ? chunk.toString(this._encoding) : chunk);
    }

    close(error?: Error): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this._received = [];
        nextTurn(() => {
            if (error) {
                this.emit('error', error);
            }
            this.emit('close', !!error);
        });
    }
}

/**
 * Creates the two ends of an in-memory connection
 *
 * @return `[serverSocket, clientSocket]`
 */
export function createSocketPair(): [MemorySocket, MemorySocket] {
    const serverSocket = new MemorySocket();
    const clientSocket = new MemorySocket();
    serverSocket.peer = clientSocket;
    clientSocket.peer = serverSocket;
    return [serverSocket, clientSocket];
}

// one ordered queue for both ends, so the data and events of a connection keep the order they were sent in
const queue: Array<() => void> = [];

function nextTurn(fn: () => void): void {
    queue.push(fn);
    if (queue.length === 1) {
        setImmediate(runQueue);
    }
}

function runQueue(): void {
    // what runs now may queue more, that waits for the next turn
    const batch = queue.splice(0, queue.length);
    for (const fn of batch) {
        fn();
    }
}
