import Secret from 'gi://Secret?version=1';

const SCHEMA = new Secret.Schema('local.codex.fritzbox-monitor', Secret.SchemaFlags.NONE, {
    router: Secret.SchemaAttributeType.STRING,
    username: Secret.SchemaAttributeType.STRING,
});

function attributes(router, username) {
    return {router, username};
}

export function lookupPassword(router, username, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, attributes(router, username), cancellable,
            (_source, result) => {
                try {
                    resolve(Secret.password_lookup_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

export function storePassword(router, username, password) {
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, attributes(router, username),
            Secret.COLLECTION_DEFAULT, `Router Monitor: ${router}`,
            password, null, (_source, result) => {
                try {
                    resolve(Secret.password_store_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}

export function clearPassword(router, username) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, attributes(router, username), null,
            (_source, result) => {
                try {
                    resolve(Secret.password_clear_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
    });
}
