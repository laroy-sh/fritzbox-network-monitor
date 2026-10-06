import GLib from 'gi://GLib';

function fromHex(text) {
    return Uint8Array.from(text.match(/../g) ?? [], pair => parseInt(pair, 16));
}

function toHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hmac(key, data) {
    const hmac = GLib.Hmac.new(GLib.ChecksumType.SHA256, key);
    hmac.update(data);
    return fromHex(hmac.get_string());
}

function idle() {
    return new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

// PBKDF2-HMAC-SHA256, one 32-byte block. The router asks for tens of thousands
// of rounds, so work in slices and yield to keep the shell responsive.
export async function pbkdf2(key, salt, iterations, cancellable = null, slice = 1000) {
    let block = hmac(key, Uint8Array.from([...salt, 0, 0, 0, 1]));
    const result = block.slice();
    for (let i = 1; i < iterations; i++) {
        if (i % slice === 0) {
            await idle();
            if (cancellable?.is_cancelled())
                throw new Error('Cancelled');
        }
        block = hmac(key, block);
        for (let j = 0; j < result.length; j++)
            result[j] ^= block[j];
    }
    return result;
}

// Returns the login_sid.lua response for a parsed version 2 challenge.
// `cache` keeps the first, password-only stage, which is fixed per router.
export async function challengeResponse(password, challenge, cache, cancellable = null) {
    const key = `${challenge.iter1}$${challenge.salt1}`;
    let first = cache.get(key);
    if (!first) {
        first = await pbkdf2(new TextEncoder().encode(password), fromHex(challenge.salt1),
            challenge.iter1, cancellable);
        cache.clear();
        cache.set(key, first);
    }
    const second = await pbkdf2(first, fromHex(challenge.salt2), challenge.iter2, cancellable);
    return `${challenge.salt2}$${toHex(second)}`;
}
