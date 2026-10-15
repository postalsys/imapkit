import { states } from '../command-states.js';
import type { Callback, IMAPConnection, IMAPServer, ParsedCommand } from '../types.js';

/**
 * @help Adds IDLE [RFC2177] capability
 */

export default function idlePlugin(server: IMAPServer) {
    server.registerCapability('IDLE');

    server.setCommandHandler(
        'IDLE',
        (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
            const idleTimer = setTimeout(
                () => {
                    if (connection.socket && !connection.socket.destroyed) {
                        connection.send(
                            {
                                tag: '*',
                                command: 'BYE',
                                attributes: [
                                    {
                                        type: 'TEXT',
                                        value: 'IDLE terminated'
                                    }
                                ]
                            },
                            'IDLE EXPIRED',
                            parsed,
                            data
                        );
                        connection.end();
                    }
                },
                30 * 60 * 1000
            );
            // An idling client should not keep the process alive (browsers have no unref)
            idleTimer.unref?.();

            const clearIdleTimer = () => clearTimeout(idleTimer);
            const socket = connection.socket;
            if (socket) {
                socket.once('close', clearIdleTimer);
            }

            connection.directNotifications = true;

            // Temporarily redirect client input to this function
            connection.inputHandler = function (str: string) {
                clearIdleTimer();
                if (socket) {
                    socket.removeListener('close', clearIdleTimer);
                }

                // Stop listening to any other user input
                connection.inputHandler = false;

                // Notifications are sent again only while a command is in progress
                connection.directNotifications = false;

                if (str.toUpperCase() === 'DONE') {
                    connection.send(
                        {
                            tag: parsed.tag,
                            command: 'OK',
                            attributes: [
                                {
                                    type: 'TEXT',
                                    value: 'IDLE terminated'
                                }
                            ]
                        },
                        'IDLE',
                        parsed,
                        data
                    );
                } else {
                    connection.send(
                        {
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [
                                {
                                    type: 'TEXT',
                                    value: 'Invalid Idle continuation'
                                }
                            ]
                        },
                        'INVALID IDLE',
                        parsed,
                        data
                    );
                }
            };

            connection.sendContinuation('idling', 'IDLE');

            connection.processNotifications();

            return callback();
        },
        { states: states.AUTHENTICATED, noArguments: true }
    );
}
