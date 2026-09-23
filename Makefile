ZIP = fritzbox-monitor@codex.local.shell-extension.zip
SOURCES = metadata.json extension.js prefs.js schemas/org.gnome.shell.extensions.fritzbox-monitor.gschema.xml lib/client.js lib/protocol.js lib/xml.js lib/secrets.js

.PHONY: test pack clean

test:
	gjs -m tests/protocol.test.js
	glib-compile-schemas --strict --dry-run schemas

pack: test
	rm -f $(ZIP)
	zip -q -X $(ZIP) $(SOURCES)

clean:
	rm -f $(ZIP)
