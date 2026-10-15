// The COMPRESS plugin in the browser bundle: COMPRESS=DEFLATE needs node:zlib, whose SYNC_FLUSH browsers do not have

export default function compressPlugin() {
    throw new Error('The COMPRESS plugin is not available in the browser');
}
