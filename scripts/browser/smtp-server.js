// smtp-server in the browser bundle, there is no SMTP listener in browsers

export class SMTPServer {
    constructor() {
        throw new Error('SMTP is not available in the browser');
    }
}

export default { SMTPServer };
