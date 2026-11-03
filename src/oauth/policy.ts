/**
 * Consent policies and outcomes of the OAuth provider, see README "OAuth 2.0 and OpenID Connect". A policy says
 * what the authorization endpoint does with a sign-in: show the consent page (`prompt`), redirect with a code
 * (`approve`), redirect with `access_denied` (`deny`), or redirect with another error. A queued decision can also
 * break the redirect on purpose (`wrong-state`, `wrong-iss`, `no-redirect`) to test how a client copes.
 */

import { ImapKitError } from '../store-operations.js';

/** An error outcome: the authorization response carries this error code and description */
export interface ErrorOutcome {
    error: string;
    description?: string | undefined;
}

/** What a user, a client or the server default answers */
export type ConsentPolicy = 'prompt' | 'approve' | 'deny' | ErrorOutcome;

/** Outcomes that break the redirect on purpose, only for queued decisions and the consent page */
export type FaultOutcome = 'wrong-state' | 'wrong-iss' | 'no-redirect';

/** Every outcome of a sign-in */
export type Outcome = ConsentPolicy | FaultOutcome;

// RFC 6749 section 4.1.2.1: error and error_description are %x20-21 / %x23-5B / %x5D-7E
const ERROR_TEXT = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

/**
 * Makes a text fit for error_description, other characters become spaces
 *
 * @param {String} text Description
 * @return {String} the description
 */
export const errorText = (text: string): string => text.replace(/[^\x20\x21\x23-\x5b\x5d-\x7e]/g, ' ');

/**
 * Checks an OAuth error code
 *
 * @param {*} value Error code
 * @return {Boolean} true for a non-empty string of the allowed characters
 */
export const isErrorCode = (value: unknown): value is string => typeof value === 'string' && value !== '' && ERROR_TEXT.test(value);

const POLICIES = ['prompt', 'approve', 'deny'];
const FAULTS = ['wrong-state', 'wrong-iss', 'no-redirect'];

/**
 * Checks a consent policy or an outcome
 *
 * @param {*} value Policy from the options or the control API
 * @param {String} what Name of the setting, for the error message
 * @param {Boolean} [faults] true allows the fault outcomes too
 * @return {String|Object} the policy, an error outcome is copied
 * @throws {ImapKitError} INVALID for anything else
 */
export function checkOutcome(value: unknown, what: string, faults = false): Outcome {
    if (typeof value === 'string' && (POLICIES.includes(value) || (faults && FAULTS.includes(value)))) {
        return value as Outcome;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const { error, description } = value as Record<string, unknown>;
        if (isErrorCode(error)) {
            if (description !== undefined && (typeof description !== 'string' || !ERROR_TEXT.test(description))) {
                throw new ImapKitError(what + ': description must be printable ASCII without " and \\ (RFC 6749 section 4.1.2.1)', 'INVALID');
            }
            return description === undefined ? { error } : { error, description };
        }
    }
    const allowed = POLICIES.concat(faults ? FAULTS : []).map(name => '"' + name + '"');
    throw new ImapKitError(what + ' must be ' + allowed.join(', ') + ' or { error, description }, e.g. { error: "access_denied" }', 'INVALID');
}

/**
 * Describes an outcome for events and pages
 *
 * @param {String|Object} outcome Outcome
 * @return {String} e.g. "approve" or "error invalid_scope"
 */
export function describeOutcome(outcome: Outcome): string {
    return typeof outcome === 'string' ? outcome : 'error ' + outcome.error;
}
