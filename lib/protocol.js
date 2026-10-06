import {parseXml, child, children, descendants, localName, value} from './xml.js';

export function parseDescription(xml) {
    const doc = parseXml(xml);
    const result = new Map();
    for (const service of descendants(doc, 'service')) {
        const type = value(service, 'serviceType');
        const control = value(service, 'controlURL');
        const scpd = value(service, 'SCPDURL');
        if (type && control && scpd)
            result.set(type, {type, control, scpd});
    }
    return result;
}

export function parseActions(xml) {
    const doc = parseXml(xml);
    return new Set(descendants(doc, 'action')
        .map(action => value(action, 'name')).filter(Boolean));
}

export function escapeXml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function soapBody(serviceType, action, args = {}) {
    if (!/^[A-Za-z_][\w.-]*$/.test(action))
        throw new Error('Invalid SOAP action');
    const fields = Object.entries(args).map(([key, val]) => {
        if (!/^[A-Za-z_][\w.-]*$/.test(key))
            throw new Error('Invalid SOAP field');
        return `<${key}>${escapeXml(val)}</${key}>`;
    }).join('');
    return `<?xml version="1.0" encoding="utf-8"?>` +
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
        `<s:Body><u:${action} xmlns:u="${escapeXml(serviceType)}">` +
        `${fields}</u:${action}></s:Body></s:Envelope>`;
}

export function parseSoap(xml, action) {
    const doc = parseXml(xml);
    const body = descendants(doc, 'Body')[0];
    if (!body)
        throw new Error('Missing SOAP body');
    const fault = child(body, 'Fault');
    if (fault) {
        const code = descendants(fault, 'errorCode')[0]?.text.trim();
        const detail = descendants(fault, 'errorDescription')[0]?.text.trim() ||
            value(fault, 'faultstring') || 'Router rejected the request';
        const error = new Error(detail);
        error.code = code ?? 'SOAP_FAULT';
        throw error;
    }
    const response = child(body, `${action}Response`);
    if (!response)
        throw new Error(`Missing ${action} response`);
    const fields = {};
    for (const field of response.children)
        fields[field.name.split(':').at(-1)] = field.text.trim();
    return fields;
}

// FRITZ! documents these lists as bytes per second in 5-second samples, but not
// which end holds the newest one. Confirm with `tests/live-discovery.js --probe`.
export const NEWEST_SAMPLE_FIRST = false;

function latestRate(text) {
    if (text == null || text === '')
        return null;
    const values = String(text).split(',').map(item => Number(item.trim()));
    if (!values.length || values.some(item => !Number.isFinite(item) || item < 0))
        return null;
    return NEWEST_SAMPLE_FIRST ? values[0] : values.at(-1);
}

export function parseCommonLink(fields) {
    return {
        status: fields.NewPhysicalLinkStatus || 'Unknown',
        downBytesPerSecond: latestRate(fields['NewX_AVM-DE_DownstreamCurrentUtilization']),
        upBytesPerSecond: latestRate(fields['NewX_AVM-DE_UpstreamCurrentUtilization']),
        downMaxBytesPerSecond: Number(fields['NewX_AVM-DE_DownstreamCurrentMaxSpeed']) || null,
        upMaxBytesPerSecond: Number(fields['NewX_AVM-DE_UpstreamCurrentMaxSpeed']) || null,
    };
}

export function parseOnlineMonitor(fields) {
    return {
        downBytesPerSecond: latestRate(fields.Newds_current_bps),
        upBytesPerSecond: latestRate(fields.Newus_current_bps),
    };
}

export function parseHost(fields) {
    return {
        name: fields.NewHostName || fields.NewIPAddress || 'Unknown device',
        ip: fields.NewIPAddress || '',
        active: fields.NewActive === '1',
        kind: fields.NewInterfaceType || '',
        speedMbps: fields['NewX_AVM-DE_Speed'] === undefined ? null : parseHostSpeed(fields),
    };
}

// Parses the XML file behind Hosts:X_AVM-DE_GetHostListPath.
export function parseHostList(xml) {
    const doc = parseXml(xml);
    if (localName(doc) !== 'List')
        throw new Error('Unexpected host list format');
    return children(doc, 'Item').map(item => {
        const fields = {};
        for (const field of item.children)
            fields[`New${localName(field)}`] = field.text.trim();
        return parseHost(fields);
    });
}

export function parseHostSpeed(fields) {
    const speed = Number(fields['NewX_AVM-DE_Speed']);
    return Number.isFinite(speed) && speed > 0 ? speed : null;
}

export function parseHostCount(fields) {
    const count = Number(fields.NewHostNumberOfEntries);
    if (!Number.isSafeInteger(count) || count < 0 || count > 1024)
        throw new Error('Invalid device count');
    return count;
}

// Parses DeviceInfo:GetDeviceLog, newest entry first, one "DD.MM.YY HH:MM:SS text"
// per line. Lines without a timestamp continue the previous entry.
export function parseDeviceLog(fields, limit = 20) {
    const entries = [];
    for (const line of (fields.NewDeviceLog ?? '').split('\n')) {
        const match = /^(\d\d\.\d\d\.\d\d \d\d:\d\d:\d\d) (.*)$/.exec(line.trim());
        if (match) {
            if (entries.length === limit)
                break;
            entries.push({time: match[1], message: match[2]});
        } else if (line.trim() && entries.length) {
            entries[entries.length - 1].message += ` ${line.trim()}`;
        }
    }
    return entries;
}

export function parseRouterUrl(input) {
    const text = input.trim();
    if (!text || /[\s@?#]/.test(text))
        throw new Error('Enter a router host or local URL');
    const match = /^(?:(https?):\/\/)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\/?$/.exec(text);
    if (!match)
        throw new Error('Enter only a router host or base URL');
    const scheme = match[1] || 'http';
    const host = match[2].toLowerCase();
    const port = Number(match[3] || (scheme === 'https' ? 49443 : 49000));
    if (port < 1 || port > 65535 || !isLocalHost(host))
        throw new Error('Router address must be on the local network');
    return `${scheme}://${host}:${port}`;
}

export function serviceUrl(origin, path) {
    if (!/^\/(?!\/)[A-Za-z0-9/_.,;?=&%+~-]*$/.test(path) ||
        path.split('/').includes('..'))
        throw new Error('Router description points outside the router');
    return `${origin}${path}`;
}

export function isLocalHost(host) {
    if (host.startsWith('['))
        return /^\[(?:f[cd][0-9a-f:]+|fe[89ab][0-9a-f:]+)\]$/.test(host);
    if (/^[0-9.]+$/.test(host)) {
        const parts = host.split('.').map(Number);
        return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
            (parts[0] === 10 || parts[0] === 127 ||
             (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
             (parts[0] === 192 && parts[1] === 168) ||
             (parts[0] === 169 && parts[1] === 254));
    }
    return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(host) &&
        (!host.includes('.') || ['.box', '.lan', '.local', '.home.arpa'].some(suffix => host.endsWith(suffix)));
}

// The web interface runs on the default port of the TR-064 origin's scheme.
export function webOrigin(origin) {
    const match = /^(https?):\/\/(\[[^\]]+\]|[^:]+):[0-9]+$/.exec(origin);
    if (!match)
        throw new Error('Invalid router origin');
    return `${match[1]}://${match[2]}`;
}

const NO_SESSION = '0000000000000000';

// Parses login_sid.lua?version=2. A session id of zeros means not logged in.
export function parseLoginSession(xml) {
    const doc = parseXml(xml);
    if (localName(doc) !== 'SessionInfo')
        throw new Error('Unexpected login response');
    const sid = value(doc, 'SID') ?? NO_SESSION;
    return {
        sid: /^[0-9a-f]{16}$/.test(sid) && sid !== NO_SESSION ? sid : null,
        challenge: value(doc, 'Challenge') ?? '',
        blockSeconds: Number(value(doc, 'BlockTime') ?? 0) || 0,
    };
}

// Version 2 challenges are "2$<iter1>$<salt1>$<iter2>$<salt2>" (PBKDF2-SHA256).
export function parseChallenge(challenge) {
    const match = /^2\$([0-9]+)\$([0-9a-f]+)\$([0-9]+)\$([0-9a-f]+)$/.exec(challenge);
    if (!match)
        throw new Error('Router web login needs a newer FRITZ!OS (PBKDF2 challenge)');
    const iter1 = Number(match[1]);
    const iter2 = Number(match[3]);
    if (iter1 < 1 || iter2 < 1 || iter1 > 1_000_000 || iter2 > 1_000_000)
        throw new Error('Unexpected login challenge');
    return {iter1, salt1: match[2], iter2, salt2: match[4]};
}

const METER_PERIODS = [
    ['Today', 'Today'], ['Yesterday', 'Yesterday'], ['ThisWeek', 'This week'],
    ['ThisMonth', 'This month'], ['LastMonth', 'Last month'],
];

function counter(high, low) {
    const h = Number(high);
    const l = Number(low);
    if (!Number.isSafeInteger(h) || !Number.isSafeInteger(l) || h < 0 || l < 0 ||
        l >= 2 ** 32)
        throw new Error('Invalid online meter value');
    return h * 2 ** 32 + l;
}

// The online meter page (data.lua, page netCnt) is undocumented: its volumes
// sit in a script as `const data = {...}` with 32-bit high/low halves.
export function parseOnlineMeter(html) {
    const match = /\bconst data = (\{.*\});\s*$/m.exec(html);
    if (!match)
        throw new Error('Online meter not found in router page');
    const data = JSON.parse(match[1]);
    return METER_PERIODS.filter(([key]) => data[key]).map(([key, label]) => ({
        label,
        sentBytes: counter(data[key].BytesSentHigh, data[key].BytesSentLow),
        receivedBytes: counter(data[key].BytesReceivedHigh, data[key].BytesReceivedLow),
    }));
}
