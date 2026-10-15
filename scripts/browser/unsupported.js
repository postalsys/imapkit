// node:http and node:crypto in the browser bundle: the REST API needs Node

const unsupported = name => () => {
    throw new Error(name + ' is not available in the browser');
};

export const createServer = unsupported('The REST API');
export const createHash = unsupported('The REST API');
export const timingSafeEqual = unsupported('The REST API');

export default { createServer, createHash, timingSafeEqual };
