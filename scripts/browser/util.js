// node:util in the browser bundle

// enough for the values it compares: parsed command arguments (plain objects, arrays, strings, numbers)
export function isDeepStrictEqual(a, b) {
    if (Object.is(a, b)) {
        return true;
    }
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
        return false;
    }
    if (a instanceof Map || a instanceof Set) {
        return isDeepStrictEqual(Array.from(a), Array.from(b));
    }
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && isDeepStrictEqual(a[key], b[key]));
}

export default { isDeepStrictEqual };
