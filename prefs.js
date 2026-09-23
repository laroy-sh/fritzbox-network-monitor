import Adw from 'gi://Adw?version=1';
import Gtk from 'gi://Gtk?version=4.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {clearPassword, storePassword} from './lib/secrets.js';
import {parseRouterUrl} from './lib/protocol.js';

export default class FritzMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Router Monitor', icon_name: 'network-wired-symbolic'});
        const group = new Adw.PreferencesGroup({title: 'FRITZ!Box',
            description: 'Connect from this computer over your local network.'});
        page.add(group);

        // Applied explicitly so the panel does not reconnect on every keystroke.
        const address = new Adw.EntryRow({title: 'Router host or local URL',
            text: settings.get_string('router-address'), show_apply_button: true});
        group.add(address);

        const username = new Adw.EntryRow({title: 'Username',
            text: settings.get_string('username'), show_apply_button: true});
        group.add(username);

        const password = new Adw.PasswordEntryRow({title: 'Password'});
        group.add(password);

        const save = new Gtk.Button({label: 'Save password', valign: Gtk.Align.CENTER});
        const saveRow = new Adw.ActionRow({title: 'GNOME keyring',
            subtitle: 'The password is stored separately from extension settings.'});
        saveRow.add_suffix(save);
        group.add(saveRow);

        const clear = new Gtk.Button({label: 'Remove password', valign: Gtk.Align.CENTER});
        const clearRow = new Adw.ActionRow({title: 'Forget credentials'});
        clearRow.add_suffix(clear);
        group.add(clearRow);

        const status = new Adw.ActionRow({title: 'Status', subtitle: 'Ready to configure'});
        group.add(status);

        const key = () => ({router: address.text.trim(), user: username.text.trim()});
        const refresh = () => settings.set_uint('credentials-revision',
            settings.get_uint('credentials-revision') + 1);
        const validKey = () => {
            const {router, user} = key();
            const origin = parseRouterUrl(router);
            if (!user)
                throw new Error('Enter a username first');
            return {router: origin, user};
        };
        // Keyring entries are keyed by address and username, so saving or
        // removing a password also applies what is typed in those rows.
        const applyKey = () => {
            const {router, user} = key();
            settings.set_string('router-address', router);
            settings.set_string('username', user);
        };

        address.connect('apply', () => {
            try {
                parseRouterUrl(address.text);
                settings.set_string('router-address', key().router);
                status.subtitle = 'Router address saved';
            } catch (error) {
                status.subtitle = error.message;
            }
        });
        username.connect('apply', () => {
            settings.set_string('username', key().user);
            status.subtitle = 'Username saved';
        });

        save.connect('clicked', async () => {
            try {
                const {router, user} = validKey();
                if (!password.text)
                    throw new Error('Enter a password first');
                save.sensitive = false;
                await storePassword(router, user, password.text);
                password.text = '';
                applyKey();
                status.subtitle = 'Password saved in GNOME keyring';
                refresh();
            } catch (error) {
                status.subtitle = `Could not save password: ${error.message}`;
            } finally {
                save.sensitive = true;
            }
        });

        clear.connect('clicked', async () => {
            try {
                const {router, user} = validKey();
                clear.sensitive = false;
                const removed = await clearPassword(router, user);
                applyKey();
                status.subtitle = removed ? 'Password removed' : 'No saved password found';
                refresh();
            } catch (error) {
                status.subtitle = `Could not remove password: ${error.message}`;
            } finally {
                clear.sensitive = true;
            }
        });

        window.add(page);
    }
}
