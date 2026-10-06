import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {
    isLocalHost, parseActions, parseCommonLink, parseDescription, parseHost,
    parseDeviceLog, parseHostCount, parseHostList, parseHostSpeed, parseOnlineMonitor,
    parseRouterUrl, parseSoap, serviceUrl, soapBody,
} from './protocol.js';

const WAN = 'WANCommonInterfaceConfig';
const HOSTS = 'Hosts';
const DEVICE_INFO = 'DeviceInfo';

export const AUTH_FAILED = 'AUTH_FAILED';

function sortHosts(hosts) {
    return hosts.sort((a, b) => a.name.localeCompare(b.name));
}

export class FritzClient {
    constructor(address, username, password) {
        this.origin = parseRouterUrl(address);
        this.username = username;
        this.password = password;
        this.session = new Soup.Session({timeout: 8});
        this.cancellable = new Gio.Cancellable();
        this.services = new Map();
        this.actions = new Map();
        this.ready = false;
    }

    close() {
        this.cancellable.cancel();
        this.session.abort();
        this.password = null;
    }

    async discover() {
        await this._resolveLocalAddress();
        const description = await this._get(`${this.origin}/tr64desc.xml`);
        const all = parseDescription(description);
        for (const [type, service] of all) {
            const key = [WAN, HOSTS, DEVICE_INFO].find(name => type.endsWith(`:${name}:1`));
            if (!key)
                continue;
            const actions = parseActions(await this._get(serviceUrl(this.origin, service.scpd)));
            this.services.set(key, service);
            this.actions.set(key, actions);
        }
        this.ready = true;
        if (!this.has(WAN, 'GetCommonLinkProperties') &&
            !this.has(WAN, 'X_AVM-DE_GetOnlineMonitor'))
            throw new Error('This router has no supported WAN monitoring action');
    }

    has(service, action) {
        return this.actions.get(service)?.has(action) ?? false;
    }

    async _resolveLocalAddress() {
        if (this._resolved)
            return;
        const match = /^(https?):\/\/(\[[^\]]+\]|[^:]+):([0-9]+)$/.exec(this.origin);
        const [, scheme, host, port] = match;
        if (host.startsWith('[') || /^[0-9.]+$/.test(host)) {
            this._resolved = true;
            return;
        }
        const resolver = Gio.Resolver.get_default();
        const addresses = await new Promise((resolve, reject) => {
            resolver.lookup_by_name_async(host, this.cancellable, (_source, result) => {
                try {
                    resolve(resolver.lookup_by_name_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        });
        const local = addresses.map(address => address.to_string())
            .map(text => text.includes(':') ? `[${text}]` : text)
            .filter(literal => isLocalHost(literal.toLowerCase()));
        if (!local.length)
            throw new Error(`${host} does not resolve to a local address; enter the router IP`);
        // Plain HTTP is pinned to the checked address. HTTPS keeps the name so
        // the router certificate, issued for that name, still verifies.
        if (scheme === 'http')
            this.origin = `${scheme}://${local[0]}:${port}`;
        this._resolved = true;
    }

    async readWan() {
        if (!this.ready)
            await this.discover();
        if (this.has(WAN, 'GetCommonLinkProperties')) {
            const data = parseCommonLink(await this._soap(WAN, 'GetCommonLinkProperties'));
            if (data.downBytesPerSecond !== null && data.upBytesPerSecond !== null)
                return data;
            if (this.has(WAN, 'X_AVM-DE_GetOnlineMonitor')) {
                try {
                    const live = parseOnlineMonitor(await this._soap(WAN,
                        'X_AVM-DE_GetOnlineMonitor', {NewSyncGroupIndex: 0}));
                    return {...data, ...live};
                } catch (error) {
                    // Missing configuration rights should not hide link status.
                    if (error.code !== '606')
                        throw error;
                }
            }
            return data;
        }
        const live = parseOnlineMonitor(await this._soap(WAN,
            'X_AVM-DE_GetOnlineMonitor', {NewSyncGroupIndex: 0}));
        return {status: 'Unknown', ...live, downMaxBytesPerSecond: null,
            upMaxBytesPerSecond: null};
    }

    async readHosts() {
        if (!this.ready)
            await this.discover();
        if (this.has(HOSTS, 'X_AVM-DE_GetHostListPath')) {
            try {
                return sortHosts((await this._readHostList()).filter(host => host.active));
            } catch (error) {
                // The list needs App rights; the per-entry actions need none.
                if (error.code !== '606')
                    throw error;
            }
        }
        return this._readHostEntries();
    }

    // Returns null when the router has no event log action.
    async readLog() {
        if (!this.ready)
            await this.discover();
        if (!this.has(DEVICE_INFO, 'GetDeviceLog'))
            return null;
        return parseDeviceLog(await this._soap(DEVICE_INFO, 'GetDeviceLog'));
    }

    async _readHostList() {
        const fields = await this._soap(HOSTS, 'X_AVM-DE_GetHostListPath');
        const path = fields['NewX_AVM-DE_HostListPath'];
        if (!path)
            throw new Error('Router returned no host list');
        // The path carries a session id, so it is never shown in messages.
        return parseHostList(await this._get(serviceUrl(this.origin, path)));
    }

    async _readHostEntries() {
        if (!this.has(HOSTS, 'GetHostNumberOfEntries') ||
            !this.has(HOSTS, 'GetGenericHostEntry'))
            return null;
        const count = parseHostCount(await this._soap(HOSTS, 'GetHostNumberOfEntries'));
        const hosts = [];
        for (let start = 0; start < count; start += 8) {
            const end = Math.min(start + 8, count);
            const page = await Promise.all(Array.from({length: end - start}, async (_x, offset) => {
                const fields = await this._soap(HOSTS, 'GetGenericHostEntry',
                    {NewIndex: start + offset});
                return parseHost(fields);
            }));
            hosts.push(...page.filter(host => host.active));
        }
        if (this.has(HOSTS, 'X_AVM-DE_GetSpecificHostEntryByIP')) {
            for (let start = 0; start < hosts.length; start += 8) {
                await Promise.all(hosts.slice(start, start + 8).map(async host => {
                    if (!host.ip)
                        return;
                    try {
                        const fields = await this._soap(HOSTS,
                            'X_AVM-DE_GetSpecificHostEntryByIP', {NewIPAddress: host.ip});
                        host.speedMbps = parseHostSpeed(fields);
                    } catch (error) {
                        if (error.code !== '606' && error.code !== '714')
                            throw error;
                    }
                }));
            }
        }
        return sortHosts(hosts);
    }

    async _soap(serviceName, action, args = {}) {
        const service = this.services.get(serviceName);
        if (!service || !this.has(serviceName, action))
            throw new Error(`Unsupported router action: ${action}`);
        const uri = serviceUrl(this.origin, service.control);
        const body = soapBody(service.type, action, args);
        const message = Soup.Message.new('POST', uri);
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        message.get_request_headers().append('SOAPAction', `"${service.type}#${action}"`);
        const bytes = new GLib.Bytes(new TextEncoder().encode(body));
        message.set_request_body_from_bytes('text/xml; charset="utf-8"', bytes);
        // libsoup drops the body when it resends after the digest challenge.
        message.connect('restarted', () =>
            message.set_request_body_from_bytes('text/xml; charset="utf-8"', bytes));
        this._authenticate(message);
        const response = await this._send(message);
        return parseSoap(response, action);
    }

    async _get(uri) {
        const message = Soup.Message.new('GET', uri);
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        this._authenticate(message);
        return this._send(message);
    }

    _authenticate(message) {
        message.connect('authenticate', (_message, auth, retrying) => {
            if (retrying || !this.username || !this.password || auth.is_for_proxy ||
                auth.get_scheme_name().toLowerCase() !== 'digest')
                return false;
            auth.authenticate(this.username, this.password);
            return true;
        });
    }

    _send(message) {
        return new Promise((resolve, reject) => {
            this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT,
                this.cancellable, (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();
                        if (status === Soup.Status.UNAUTHORIZED) {
                            const error = new Error('Router login failed');
                            error.code = AUTH_FAILED;
                            throw error;
                        }
                        if (status !== Soup.Status.OK) {
                            // SOAP faults arrive with HTTP 500; preserve their error codes.
                            const body = new TextDecoder().decode(bytes.get_data());
                            if (status === Soup.Status.INTERNAL_SERVER_ERROR &&
                                body.includes('<'))
                                return resolve(body);
                            throw new Error(`Router returned HTTP ${status}`);
                        }
                        resolve(new TextDecoder().decode(bytes.get_data()));
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }
}
