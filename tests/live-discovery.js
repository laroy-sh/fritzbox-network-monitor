import GLib from 'gi://GLib';

import {FritzClient} from '../lib/client.js';
import {NEWEST_SAMPLE_FIRST} from '../lib/protocol.js';

const address = ARGV[0];
if (!address)
    throw new Error('Usage: [FRITZ_USER=… FRITZ_PASSWORD=…] gjs -m tests/live-discovery.js <local-router-IP> [--probe]');

// Credentials come from the environment so they do not show up in `ps`.
const username = GLib.getenv('FRITZ_USER') ?? '';
const password = GLib.getenv('FRITZ_PASSWORD') ?? '';

function wait(seconds) {
    return new Promise(resolve => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

function samples(text) {
    return (text ?? '').split(',').filter(Boolean).map(Number);
}

function same(a, b) {
    return a.length > 0 && a.length === b.length && a.every((item, i) => item === b[i]);
}

// Consecutive reads shift the sample list; the direction tells which end is newest.
// Flat or periodic lists match both ways, so only a one-sided match counts.
function newestEnd(previous, current) {
    for (let shift = 1; shift < Math.min(previous.length, 5); shift++) {
        const kept = current.slice(shift);
        const first = same(kept, previous.slice(0, -shift));
        const last = same(current.slice(0, -shift), previous.slice(shift));
        if (new Set(kept).size < 2 || first === last)
            continue;
        return first ? 'first' : 'last';
    }
    return 'undetermined (keep traffic flowing and retry)';
}

async function readLists(client) {
    const lists = {};
    if (client.has('WANCommonInterfaceConfig', 'GetCommonLinkProperties')) {
        const fields = await client._soap('WANCommonInterfaceConfig', 'GetCommonLinkProperties');
        lists.utilizationDown = samples(fields['NewX_AVM-DE_DownstreamCurrentUtilization']);
        lists.utilizationUp = samples(fields['NewX_AVM-DE_UpstreamCurrentUtilization']);
    }
    if (client.has('WANCommonInterfaceConfig', 'X_AVM-DE_GetOnlineMonitor')) {
        try {
            const fields = await client._soap('WANCommonInterfaceConfig',
                'X_AVM-DE_GetOnlineMonitor', {NewSyncGroupIndex: 0});
            lists.monitorDs = samples(fields.Newds_current_bps);
            lists.monitorMc = samples(fields.Newmc_current_bps);
            lists.monitorUs = samples(fields.Newus_current_bps);
        } catch (error) {
            print(`Online monitor: ${error.message}`);
        }
    }
    return lists;
}

const client = new FritzClient(address, username, password);
try {
    await client.discover();
    print(`Router API at ${client.origin}`);
    for (const [service, actions] of client.actions)
        print(`${service}: ${[...actions].filter(action => /GetCommonLinkProperties|GetOnlineMonitor|GetHostNumberOfEntries|GetGenericHostEntry|GetSpecificHostEntryByIP|GetHostListPath/.test(action)).join(', ')}`);
    if (ARGV.includes('--probe')) {
        if (!username)
            print('Set FRITZ_USER and FRITZ_PASSWORD to probe authenticated actions.');
        try {
            const wan = await client.readWan();
            print(`WAN status: ${wan.status}; rates available: ${wan.downBytesPerSecond !== null}`);
        } catch (error) {
            print(`WAN read: ${error.message}`);
        }
        try {
            const hosts = await client.readHosts();
            print(`Active devices: ${hosts?.length ?? 'unavailable'}`);
        } catch (error) {
            print(`Host read: ${error.message}`);
        }
        try {
            // Keep traffic flowing (e.g. a download) so the samples differ.
            print('Reading rate samples twice, 6 seconds apart…');
            const before = await readLists(client);
            await wait(6);
            const after = await readLists(client);
            for (const [name, list] of Object.entries(after)) {
                print(`${name}: ${list.join(',')}`);
                print(`  newest sample is ${newestEnd(before[name] ?? [], list)}`);
            }
            print(`lib/protocol.js assumes newest is ${NEWEST_SAMPLE_FIRST ? 'first' : 'last'}.`);
        } catch (error) {
            print(`Rate samples: ${error.message}`);
        }
    }
} finally {
    client.close();
}
