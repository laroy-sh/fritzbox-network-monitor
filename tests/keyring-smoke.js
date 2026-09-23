import {lookupPassword} from '../lib/secrets.js';

await lookupPassword('192.168.178.1', 'codex-nonexistent-test-user');
print('GNOME keyring lookup succeeded');
