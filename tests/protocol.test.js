import Gio from 'gi://Gio';

import {
    escapeXml, NEWEST_SAMPLE_FIRST, parseActions, parseCommonLink, parseDescription,
    parseHost, parseHostCount, parseHostList, parseHostSpeed, parseRouterUrl,
    parseSoap, serviceUrl, soapBody,
} from '../lib/protocol.js';
import {parseXml} from '../lib/xml.js';
import {AUTH_FAILED, FritzClient} from '../lib/client.js';

let tests = 0;
function equal(actual, expected, label) {
    tests++;
    if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
}
function throws(fn, label) {
    tests++;
    try {
        fn();
    } catch (_error) {
        return;
    }
    throw new Error(`${label}: expected an error`);
}

const description = `<?xml version="1.0"?>
<root xmlns="urn:dslforum-org:device-1-0"><device><serviceList>
<service><serviceType>urn:dslforum-org:service:WANCommonInterfaceConfig:1</serviceType>
<controlURL>/upnp/control/wancommonifconfig1</controlURL>
<SCPDURL>/wancommonifconfigSCPD.xml</SCPDURL></service>
<service><serviceType>urn:dslforum-org:service:Hosts:1</serviceType>
<controlURL>/upnp/control/hosts</controlURL><SCPDURL>/hostsSCPD.xml</SCPDURL>
</service></serviceList></device></root>`;
const scpd = '<scpd><actionList><action><name>GetCommonLinkProperties</name></action>' +
    '<action><name>GetHostNumberOfEntries</name></action></actionList></scpd>';
const response = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body><u:GetCommonLinkPropertiesResponse xmlns:u="urn:dslforum-org:service:WANCommonInterfaceConfig:1">
<NewPhysicalLinkStatus>Up</NewPhysicalLinkStatus>
<NewX_AVM-DE_DownstreamCurrentUtilization>1000,2000,3000</NewX_AVM-DE_DownstreamCurrentUtilization>
<NewX_AVM-DE_UpstreamCurrentUtilization>100,200,300</NewX_AVM-DE_UpstreamCurrentUtilization>
</u:GetCommonLinkPropertiesResponse></s:Body></s:Envelope>`;

equal(parseDescription(description).size, 2, 'service discovery');
equal(parseActions(scpd).has('GetCommonLinkProperties'), true, 'action discovery');
equal(escapeXml('a&<b>'), 'a&amp;&lt;b&gt;', 'SOAP escaping');
equal(soapBody('urn:example:service:Test:1', 'GetInfo', {NewValue: 'A&B'})
    .includes('<NewValue>A&amp;B</NewValue>'), true, 'SOAP arguments');
const wan = parseCommonLink(parseSoap(response, 'GetCommonLinkProperties'));
equal(wan.status, 'Up', 'link status');
equal(wan.downBytesPerSecond, NEWEST_SAMPLE_FIRST ? 1000 : 3000, 'latest download');
equal(wan.upBytesPerSecond, NEWEST_SAMPLE_FIRST ? 100 : 300, 'latest upload');
equal(parseHostCount({NewHostNumberOfEntries: '3'}), 3, 'host count');
equal(parseHost({NewHostName: 'Laptop', NewIPAddress: '192.168.178.7',
    NewActive: '1'}).active, true, 'active host');
equal(parseHostSpeed({'NewX_AVM-DE_Speed': '866'}), 866, 'link speed');
equal(parseRouterUrl('fritz.box'), 'http://fritz.box:49000', 'default URL');
equal(parseRouterUrl('https://192.168.178.1'), 'https://192.168.178.1:49443',
    'secure URL');
equal(serviceUrl('http://fritz.box:49000', '/upnp/control/hosts'),
    'http://fritz.box:49000/upnp/control/hosts', 'service URL');
equal(parseRouterUrl('[fd00::1]'), 'http://[fd00::1]:49000', 'IPv6 unique local');
equal(parseRouterUrl('[FC12:3456::1]'), 'http://[fc12:3456::1]:49000', 'IPv6 fc prefix');
throws(() => parseRouterUrl('[2001:db8::1]'), 'public IPv6');
throws(() => parseRouterUrl('https://example.org'), 'nonlocal URL');
throws(() => serviceUrl('http://fritz.box:49000', '//evil.example/'), 'external action URL');
throws(() => parseXml('<!DOCTYPE x [<!ENTITY xx SYSTEM "file:///etc/passwd">]><x/>'),
    'reject DTD');
throws(() => parseHostCount({NewHostNumberOfEntries: '-1'}), 'invalid host count');

const fault = `<s:Envelope><s:Body><s:Fault><detail><UPnPError>` +
    `<errorCode>606</errorCode><errorDescription>Action not authorized</errorDescription>` +
    `</UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
try {
    parseSoap(fault, 'GetInfo');
    throw new Error('SOAP fault was accepted');
} catch (error) {
    equal(error.code, '606', 'SOAP fault code');
}

// Host list file, copied from the FRITZ! Hosts service documentation.
const hostList = `<List>
          <!-- devicehosts :8 -->
          <!-- users :2 -->
          <Item>
                  <Index>1</Index>
                  <IPAddress>192.168.178.24</IPAddress>
                  <MACAddress>2A:B3:66:30:08:87</MACAddress>
                  <Active>0</Active>
                  <HostName>PC-192-168-178-24</HostName>
                  <InterfaceType/>
                  <X_AVM-DE_Port>0</X_AVM-DE_Port>
                  <X_AVM-DE_Speed>0</X_AVM-DE_Speed>
          </Item>
          <Item>
                  <Index>2</Index>
                  <IPAddress>192.168.178.30</IPAddress>
                  <Active>1</Active>
                  <HostName>Laptop</HostName>
                  <InterfaceType>802.11</InterfaceType>
                  <X_AVM-DE_Speed>866</X_AVM-DE_Speed>
          </Item>
</List>`;
const listed = parseHostList(hostList);
equal(listed.length, 2, 'host list entries');
equal(listed[0].active, false, 'inactive listed host');
equal(listed[0].speedMbps, null, 'zero speed is unknown');
equal(listed[1].name, 'Laptop', 'listed host name');
equal(listed[1].speedMbps, 866, 'listed host speed');
equal(parseHost({NewHostName: 'X'}).speedMbps, null, 'entry without speed');
throws(() => parseHostList('<root/>'), 'unexpected host list root');

// Capability detection and fallback behavior without a real router.
const client = new FritzClient('fritz.box', 'test', 'test');
client._resolveLocalAddress = async () => {};
client._get = async uri => uri.endsWith('tr64desc.xml') ? description : scpd;
await client.discover();
equal(client.has('WANCommonInterfaceConfig', 'GetCommonLinkProperties'), true,
    'WAN capability');
equal(client.has('Hosts', 'GetGenericHostEntry'), false, 'missing host action');
client._soap = async () => parseSoap(response, 'GetCommonLinkProperties');
equal((await client.readWan()).downBytesPerSecond, 3000, 'WAN query');
equal(await client.readHosts(), null, 'missing host service action');
client._send = async message => {
    equal(message.get_method(), 'POST', 'SOAP HTTP method');
    return response;
};
equal((await FritzClient.prototype._soap.call(client, 'WANCommonInterfaceConfig',
    'GetCommonLinkProperties')).NewPhysicalLinkStatus, 'Up', 'Soup SOAP request');
client.close();

// Host list path, with fallback to per-entry reads when the user lacks rights.
const hostScpd = '<scpd><actionList>' +
    ['GetHostNumberOfEntries', 'GetGenericHostEntry', 'X_AVM-DE_GetHostListPath']
        .map(name => `<action><name>${name}</name></action>`).join('') +
    '</actionList></scpd>';
const hostsClient = new FritzClient('192.168.178.1', 'test', 'test');
hostsClient._get = async uri => {
    if (uri.endsWith('tr64desc.xml'))
        return description;
    if (uri.includes('devicehostlist.lua'))
        return hostList;
    return uri.includes('hosts') ? hostScpd : scpd;
};
await hostsClient.discover();
const calls = [];
hostsClient._soap = async (_service, action, args) => {
    calls.push(action);
    if (action === 'X_AVM-DE_GetHostListPath')
        return {'NewX_AVM-DE_HostListPath': '/devicehostlist.lua?sid=0123456789abcdef'};
    throw new Error(`unexpected ${action}`);
};
let hosts = await hostsClient.readHosts();
equal(hosts.length, 1, 'host list keeps active hosts');
equal(hosts[0].speedMbps, 866, 'host list speed');
equal(calls.join(), 'X_AVM-DE_GetHostListPath', 'host list uses one SOAP call');

hostsClient._soap = async (_service, action, args) => {
    if (action === 'X_AVM-DE_GetHostListPath') {
        const error = new Error('Action not authorized');
        error.code = '606';
        throw error;
    }
    if (action === 'GetHostNumberOfEntries')
        return {NewHostNumberOfEntries: '1'};
    return {NewHostName: 'Printer', NewIPAddress: '192.168.178.40', NewActive: '1',
        NewIndex: String(args.NewIndex)};
};
hosts = await hostsClient.readHosts();
equal(hosts.map(host => host.name).join(), 'Printer', 'fallback to host entries');

hostsClient._soap = async () => {
    const error = new Error('Router login failed');
    error.code = AUTH_FAILED;
    throw error;
};
try {
    await hostsClient.readHosts();
    throw new Error('login failure was ignored');
} catch (error) {
    equal(error.code, AUTH_FAILED, 'login failure is not a fallback case');
}
hostsClient.close();

// Name resolution: HTTP pins the checked address, HTTPS keeps the name for TLS.
function stubResolver(answers) {
    const resolver = Gio.Resolver.get_default();
    resolver.lookup_by_name_async = (_host, _cancellable, callback) => callback(resolver, null);
    resolver.lookup_by_name_finish = () =>
        answers.map(text => Gio.InetAddress.new_from_string(text));
    return () => {
        delete resolver.lookup_by_name_async;
        delete resolver.lookup_by_name_finish;
    };
}
let restore = stubResolver(['203.0.113.5', '192.168.178.1']);
try {
    const plain = new FritzClient('fritz.box', '', '');
    await plain._resolveLocalAddress();
    equal(plain.origin, 'http://192.168.178.1:49000', 'HTTP pins local answer');
    const secure = new FritzClient('https://fritz.box', '', '');
    await secure._resolveLocalAddress();
    equal(secure.origin, 'https://fritz.box:49443', 'HTTPS keeps host name');
    plain.close();
    secure.close();
} finally {
    restore();
}
restore = stubResolver(['203.0.113.5']);
try {
    const rebound = new FritzClient('https://fritz.box', '', '');
    let rejected = false;
    try {
        await rebound._resolveLocalAddress();
    } catch (_error) {
        rejected = true;
    }
    equal(rejected, true, 'public-only answers rejected');
    rebound.close();
} finally {
    restore();
}

print(`${tests} tests passed`);
