import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AUTH_FAILED, FritzClient} from './lib/client.js';
import {lookupPassword} from './lib/secrets.js';
import {parseRouterUrl} from './lib/protocol.js';

const LOGIN_FAILED_MESSAGE = 'Router login failed; check username and password in Preferences';

function formatRate(bytesPerSecond) {
    if (bytesPerSecond === null || bytesPerSecond === undefined)
        return '—';
    const bits = bytesPerSecond * 8;
    if (bits >= 1_000_000_000)
        return `${(bits / 1_000_000_000).toFixed(1)} Gb/s`;
    if (bits >= 1_000_000)
        return `${(bits / 1_000_000).toFixed(1)} Mb/s`;
    if (bits >= 1_000)
        return `${Math.round(bits / 1_000)} kb/s`;
    return `${Math.round(bits)} b/s`;
}

const MonitorIndicator = GObject.registerClass(
class MonitorIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Router Monitor');
        const row = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        row.add_child(new St.Icon({icon_name: 'network-wired-symbolic',
            style_class: 'system-status-icon'}));
        this.rateLabel = new St.Label({text: '↓ —  ↑ —', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this.rateLabel);
        this.add_child(row);

        this.statusItem = new PopupMenu.PopupMenuItem('Connecting…', {reactive: false});
        this.menu.addMenuItem(this.statusItem);
        this.ratesItem = new PopupMenu.PopupMenuItem('WAN rates unavailable',
            {reactive: false});
        this.menu.addMenuItem(this.ratesItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.devicesItem = new PopupMenu.PopupSubMenuMenuItem('Connected devices');
        this.menu.addMenuItem(this.devicesItem);
        this.setDevices(null);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.preferencesItem = new PopupMenu.PopupMenuItem('Preferences…');
        this.menu.addMenuItem(this.preferencesItem);
    }

    setWan(wan) {
        this.rateLabel.text = `↓ ${formatRate(wan.downBytesPerSecond)}  ` +
            `↑ ${formatRate(wan.upBytesPerSecond)}`;
        this.statusItem.label.text = `WAN link: ${wan.status}`;
        this.ratesItem.label.text = `Download ${formatRate(wan.downBytesPerSecond)}  ·  ` +
            `Upload ${formatRate(wan.upBytesPerSecond)}`;
    }

    setStatus(message) {
        this.rateLabel.text = '↓ —  ↑ —';
        this.statusItem.label.text = message;
        this.ratesItem.label.text = 'WAN rates unavailable';
    }

    setDevices(hosts, message = 'Device list unavailable') {
        this.devicesItem.menu.removeAll();
        if (hosts === null) {
            this.devicesItem.label.text = 'Connected devices';
            this.devicesItem.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                message, {reactive: false}));
            return;
        }
        this.devicesItem.label.text = `Connected devices (${hosts.length})`;
        if (hosts.length === 0) {
            this.devicesItem.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No active devices', {reactive: false}));
            return;
        }
        for (const host of hosts) {
            const link = host.speedMbps === null ? '' : ` · link ${host.speedMbps} Mb/s`;
            const detail = host.ip ? ` (${host.ip})` : '';
            this.devicesItem.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                `${host.name}${detail}${link}`, {reactive: false}));
        }
    }
});

export default class FritzMonitorExtension extends Extension {
    enable() {
        this._enabled = true;
        this._generation = 0;
        this._settings = this.getSettings();
        this._indicator = new MonitorIndicator();
        this._indicator.preferencesItem.connect('activate', () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._settingsChangedId = this._settings.connect('changed', () => this._scheduleRestart());
        this._restart();
    }

    disable() {
        this._enabled = false;
        this._generation++;
        this._stopPolling();
        this._lookupCancellable?.cancel();
        this._lookupCancellable = null;
        if (this._restartId) {
            GLib.Source.remove(this._restartId);
            this._restartId = 0;
        }
        this._client?.close();
        this._client = null;
        this._settings.disconnect(this._settingsChangedId);
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }

    _scheduleRestart() {
        if (this._restartId)
            GLib.Source.remove(this._restartId);
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._restartId = 0;
            this._restart();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _restart() {
        const generation = ++this._generation;
        this._stopPolling();
        this._client?.close();
        this._client = null;
        this._indicator.setStatus('Connecting to FRITZ!Box…');
        this._indicator.setDevices(null);

        const address = this._settings.get_string('router-address').trim();
        const username = this._settings.get_string('username').trim();
        if (!address || !username) {
            this._indicator.setStatus('Set router and username in Preferences');
            return;
        }
        let origin;
        try {
            origin = parseRouterUrl(address);
        } catch (error) {
            // A settings change restarts us; retrying the same value cannot help.
            this._indicator.setStatus(`Check router address in Preferences: ${error.message}`);
            return;
        }
        this._lookupCancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._lookupCancellable = cancellable;
        try {
            const password = await lookupPassword(origin, username, cancellable);
            if (!this._isCurrent(generation))
                return;
            if (!password) {
                this._indicator.setStatus('Save router password in Preferences');
                return;
            }
            const client = new FritzClient(address, username, password);
            this._client = client;
            await client.discover();
            if (!this._isCurrent(generation))
                return;
            this._pollWan(generation);
            this._pollHosts(generation);
            this._wanTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._pollWan(generation);
                return GLib.SOURCE_CONTINUE;
            });
            this._hostsTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
                this._pollHosts(generation);
                return GLib.SOURCE_CONTINUE;
            });
        } catch (error) {
            if (this._isCurrent(generation) && error.code === AUTH_FAILED) {
                this._indicator.setStatus(LOGIN_FAILED_MESSAGE);
            } else if (this._isCurrent(generation)) {
                this._indicator.setStatus(`Router unavailable: ${error.message}`);
                this._retryTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                    this._retryTimer = 0;
                    this._restart();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    // FRITZ!OS delays logins further after each failure, so polling with a
    // rejected password would lock the user out. Wait for new credentials.
    _stopOnLoginFailure() {
        this._generation++;
        this._stopPolling();
        // Cancels the other in-flight poll, which would be another failed login.
        this._client?.close();
        this._client = null;
        this._indicator.setStatus(LOGIN_FAILED_MESSAGE);
        this._indicator.setDevices(null);
    }

    _isCurrent(generation) {
        return this._enabled && generation === this._generation;
    }

    _stopPolling() {
        if (this._wanTimer)
            GLib.Source.remove(this._wanTimer);
        if (this._hostsTimer)
            GLib.Source.remove(this._hostsTimer);
        if (this._retryTimer)
            GLib.Source.remove(this._retryTimer);
        this._wanTimer = 0;
        this._hostsTimer = 0;
        this._retryTimer = 0;
        this._wanBusy = false;
        this._hostsBusy = false;
    }

    async _pollWan(generation) {
        if (this._wanBusy || !this._isCurrent(generation))
            return;
        this._wanBusy = true;
        try {
            const wan = await this._client.readWan();
            if (this._isCurrent(generation))
                this._indicator.setWan(wan);
        } catch (error) {
            if (!this._isCurrent(generation))
                return;
            if (error.code === AUTH_FAILED)
                this._stopOnLoginFailure();
            else
                this._indicator.setStatus(`WAN unavailable: ${error.message}`);
        } finally {
            if (this._isCurrent(generation))
                this._wanBusy = false;
        }
    }

    async _pollHosts(generation) {
        if (this._hostsBusy || !this._isCurrent(generation))
            return;
        this._hostsBusy = true;
        try {
            const hosts = await this._client.readHosts();
            if (this._isCurrent(generation))
                this._indicator.setDevices(hosts);
        } catch (error) {
            if (!this._isCurrent(generation))
                return;
            if (error.code === AUTH_FAILED)
                this._stopOnLoginFailure();
            else if (error.code === '606')
                this._indicator.setDevices(null, 'Router user lacks permission for the device list');
            else
                this._indicator.setDevices(null);
        } finally {
            if (this._isCurrent(generation))
                this._hostsBusy = false;
        }
    }
}
