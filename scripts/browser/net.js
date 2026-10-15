// node:net and node:tls in the browser bundle: there are no sockets, connect with server.connect() instead

import EventEmitter from 'events';

const unsupported = name => () => {
    throw new Error(name + ' is not available in the browser, open connections with server.connect()');
};

export class Socket extends EventEmitter {}

export class TLSSocket extends Socket {
    constructor() {
        super();
        unsupported('TLS')();
    }
}

export class Server extends EventEmitter {
    listen() {
        unsupported('listen()')();
    }

    close(callback) {
        if (callback) {
            queueMicrotask(() => callback());
        }
        return this;
    }

    address() {
        return null;
    }
}

export const createServer = () => new Server();
export const createSecureContext = unsupported('TLS');

export default { Socket, TLSSocket, Server, createServer, createSecureContext };
