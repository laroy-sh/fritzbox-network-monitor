# Router Monitor for GNOME 46

A GNOME Shell top-bar extension that reads documented FRITZ!Box TR-064 data from
your local network. It shows live WAN download/upload rates and connection status,
plus an active-device list and the router's recent event log. When the router exposes a device's connection speed,
the menu labels it **link speed**; it is not per-device traffic usage.

## Requirements

- GNOME Shell 46 with GJS, libsoup 3, libsecret, and GNOME keyring
- A FRITZ!Box reachable on the local network with app access enabled
- A FRITZ!Box username/password authorized for the required TR-064 actions

The WAN reader uses `WANCommonInterfaceConfig.GetCommonLinkProperties` where
available. If utilization is absent, it can try
`X_AVM-DE_GetOnlineMonitor`, which may require the broader FRITZ!Box settings
permission. Device presence uses the documented `Hosts` service: one request
for the router's host list file when the user has App rights, otherwise one
request per known host.
The event log uses `DeviceInfo.GetDeviceLog` and is read only when you expand
**Event log**; it shows the newest 20 entries and may require the FRITZ!Box
settings permission.

The **Online meter** submenu shows the data volume for today, yesterday, this
week, this month and last month. FRITZ!OS only offers it in its web interface,
so the extension logs in there (PBKDF2 challenge-response via `login_sid.lua`,
FRITZ!OS 7.24 or later) and reads the undocumented `data.lua` online meter page.
A FRITZ!OS update may change that page; the submenu then reports it as
unavailable. A rejected web login is not retried until the extension restarts.

A restricted FRITZ!Box user may be refused the event log (UPnP error 606) and
the web login; the menu says which part lacks permission. If TR-064 refuses WAN
data, the extension reads rates and link status from the router's UPnP status
service (`igddesc.xml`), which needs no login but requires **Home Network →
Network → Network Settings → Transmit status information over UPnP**.

**Top bar** in Preferences places the indicator on the left, in the center, or
on the right.

If the router rejects the login, the extension stops polling until you change
the credentials in Preferences, because FRITZ!OS makes you wait longer after
each failed login.

## Install

Run `make pack` from this directory, then
`gnome-extensions install --force fritzbox-monitor@codex.local.shell-extension.zip`.
Enable **Router Monitor** in the GNOME Extensions app and open its Preferences.
On Wayland, you may need to log out and back in before a newly installed
extension appears.
Enter the router host (default `192.168.178.1`) and username, pressing the ✓
button or Enter to apply each, then save the password. Change the address if your router uses another local IP. You can
enter `fritz.box` when it resolves to a private LAN address; the extension
rejects public DNS answers.

If necessary, enable **Home Network → Network → Network Settings → Allow access
for applications** in the FRITZ!Box interface. The extension only accepts local
router addresses (private IPv4, IPv6 `fc00::/7` and `fe80::/10`, or a local host
name). It uses HTTP Digest authentication over the local network. With plain
HTTP, a host name is resolved once and pinned to the local address. You can
explicitly enter an `https://` router URL if its certificate is trusted by your
system; the host name is then kept so the certificate can be verified. It does
not disable certificate checks.

## Development checks

`make test` runs `tests/protocol.test.js` (XML/SOAP parsing, URL rules, host
list and fallback handling, name resolution) and validates the settings schema.
The extension uses asynchronous requests and cancels them when disabled.

Two scripts need real services and are not part of `make test`:

- `gjs -m tests/keyring-smoke.js` checks that GNOME keyring lookups work.
- `FRITZ_USER=… FRITZ_PASSWORD=… gjs -m tests/live-discovery.js 192.168.178.1 --probe`
  lists the router's supported actions, reads WAN and hosts, and samples the
  rate lists twice to report which end holds the newest value. Run it during a
  download; if it disagrees with `NEWEST_SAMPLE_FIRST` in `lib/protocol.js`,
  change that constant. Credentials come from the environment, not arguments.

## Sources

- [FRITZ! TR-064 first steps](https://fritz.support/resources/TR-064_First_Steps.pdf)
- [WAN common interface](https://fritz.support/resources/TR-064_WAN_Common_Interface_Config.pdf)
- [Hosts service](https://fritz.support/resources/TR-064_Hosts.pdf)
