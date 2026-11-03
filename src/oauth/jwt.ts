/**
 * Signs the ID tokens of the OAuth provider: RS256 JSON Web Tokens (RFC 7519, RFC 7515) and the JWK Set of the
 * public key (RFC 7517), with the RFC 7638 thumbprint as the key ID
 */

import crypto from 'node:crypto';

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** An RSA signing key with its public JWK */
export interface SigningKey {
    privateKey: crypto.KeyObject;
    jwk: Record<string, string>;
    kid: string;
}

/**
 * Loads or makes the signing key
 *
 * @param {String|Buffer} [pem] PKCS#8 or PKCS#1 private key in PEM, a new 2048 bit key if not set (see defaultSigningKey())
 * @return {Object} the key, its public JWK and key ID
 * @throws {Error} for a key that is not RSA
 */
export function loadSigningKey(pem?: string | Buffer): SigningKey {
    const privateKey = pem ? crypto.createPrivateKey(pem) : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    if (privateKey.asymmetricKeyType !== 'rsa') {
        throw new Error('oauth.signingKey must be an RSA private key, ID tokens are signed with RS256');
    }
    const { n, e } = crypto.createPublicKey(privateKey).export({ format: 'jwk' }) as { n: string; e: string };
    // RFC 7638 section 3.2: the required members in lexicographic order, no white space
    const kid = base64url(
        crypto
            .createHash('sha256')
            .update(JSON.stringify({ e, kty: 'RSA', n }))
            .digest()
    );
    return { privateKey, kid, jwk: { kty: 'RSA', use: 'sig', alg: 'RS256', kid, n, e } };
}

// the key of every provider without a signingKey option, made once: a 2048 bit RSA key takes a moment
let defaultKey: SigningKey | null = null;

/**
 * The shared signing key of the providers without the signingKey option, made when the first one needs it
 *
 * @return {Object} signing key
 */
export function defaultSigningKey(): SigningKey {
    if (!defaultKey) {
        defaultKey = loadSigningKey();
    }
    return defaultKey;
}

/**
 * Signs a JWT with RS256
 *
 * @param {Object} key Signing key
 * @param {Object} claims JWT claims
 * @return {String} compact serialization
 */
export function signJwt(key: SigningKey, claims: Record<string, unknown>): string {
    const input = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid })) + '.' + base64url(JSON.stringify(claims));
    return input + '.' + base64url(crypto.sign('sha256', Buffer.from(input), key.privateKey));
}
