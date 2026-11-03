// node:http, node:https and node:crypto in the browser bundle: the REST API and the OAuth provider need Node

const unsupported = name => () => {
    throw new Error(name + ' is not available in the browser');
};

export const createServer = unsupported('The REST API and the OAuth provider');
export const createHash = unsupported('The REST API');
export const timingSafeEqual = unsupported('The REST API');

export default { createServer, createHash, timingSafeEqual };
