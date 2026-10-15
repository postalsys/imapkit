// node:stream in the browser bundle, the server only extends Stream as an event emitter

import EventEmitter from 'events';

export class Stream extends EventEmitter {}

export default { Stream };
