// node:events in the browser bundle

import EventEmitter from 'events';

export const once = EventEmitter.once;
export { EventEmitter };
export default EventEmitter;
