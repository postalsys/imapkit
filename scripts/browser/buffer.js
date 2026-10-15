// node:buffer in the browser bundle

import { Buffer } from 'buffer';

// Node 18.14 has buffer.isUtf8
export function isUtf8(input) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(input);
        return true;
    } catch {
        return false;
    }
}

export { Buffer };
export default { Buffer, isUtf8 };
