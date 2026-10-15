// Globals that the bundle uses and browsers do not have, injected by esbuild (scripts/build.js)

import { Buffer } from 'buffer';

export { Buffer };

// setImmediate runs a function on the next event loop turn, after I/O. A MessageChannel message is the closest browsers
// have, a zero timer would wait 4 ms once timers nest. The handles are objects, so clearTimeout() of one is a no-op
// (clearOutputQueue in src/server.ts clears a timer with both clearTimeout and clearImmediate)
const pending = [];
let channel = null;

function runNext() {
    const handle = pending.shift();
    if (!pending.length) {
        // Node and Deno keep running while a port is open and referenced, browsers have no unref
        channel?.port1.unref?.();
    }
    if (handle && !handle.cleared) {
        handle.fn(...handle.args);
    }
}

export function setImmediate(fn, ...args) {
    if (typeof globalThis.setImmediate === 'function') {
        return globalThis.setImmediate(fn, ...args);
    }
    const handle = { fn, args, cleared: false };
    pending.push(handle);
    if (typeof MessageChannel === 'function') {
        if (!channel) {
            channel = new MessageChannel();
            channel.port1.onmessage = runNext;
        }
        channel.port1.ref?.();
        channel.port2.postMessage(null);
    } else {
        setTimeout(runNext, 0);
    }
    return handle;
}

export function clearImmediate(handle) {
    if (typeof globalThis.clearImmediate === 'function') {
        return globalThis.clearImmediate(handle);
    }
    if (handle && typeof handle === 'object') {
        handle.cleared = true;
    }
}

export const process = globalThis.process || {
    env: {},
    nextTick: (fn, ...args) => queueMicrotask(() => fn(...args))
};
