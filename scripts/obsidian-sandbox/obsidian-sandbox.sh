#!/usr/bin/env bash
# Runs an Obsidian plugin in a throwaway vault inside a SEPARATE Obsidian instance, with remote debugging, so an
# agent can inspect and drive the real app. The user's own Obsidian, vaults and app settings are never touched:
# the instance gets its own --user-data-dir (own vault list, own single-instance lock, runs alongside theirs).
#
# Usage (run from the plugin repo, the folder holding manifest.json and the built main.js):
#   bash obsidian-sandbox.sh setup     create .obsidian-sandbox/ (vault + app data), link the build, seed fixtures
#   bash obsidian-sandbox.sh start     launch the sandbox instance and wait for its debug port
#   bash obsidian-sandbox.sh stop      quit the sandbox instance only
#   bash obsidian-sandbox.sh reload    disable + enable the plugin (after rebuilding)
#   bash obsidian-sandbox.sh status    is it running, which Obsidian version, which plugins
#   bash obsidian-sandbox.sh reset     stop and delete .obsidian-sandbox/ entirely
#
# Env: OBSIDIAN_SANDBOX_PORT (default 9333), OBSIDIAN_SANDBOX_DIR (default ./.obsidian-sandbox),
#      OBSIDIAN_SANDBOX_FIXTURES (vault copied in on setup; default ./test/e2e/vaults/basic, else ./sandbox-fixtures).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(pwd)"
SANDBOX="${OBSIDIAN_SANDBOX_DIR:-$PLUGIN_DIR/.obsidian-sandbox}"
VAULT="$SANDBOX/vault"
DATA="$SANDBOX/app-data"
PORT="${OBSIDIAN_SANDBOX_PORT:-9333}"
CDP="node $HERE/cdp.mjs"
export OBSIDIAN_SANDBOX_PORT="$PORT"

die() { echo "obsidian-sandbox: $*" >&2; exit 1; }

[ -f "$PLUGIN_DIR/manifest.json" ] || die "run from the plugin repo (no manifest.json in $PLUGIN_DIR)"
PLUGIN_ID="$(node -e 'console.log(require(process.argv[1]).id)' "$PLUGIN_DIR/manifest.json")"

case "$(uname)" in
	Darwin) USER_OBSIDIAN_DATA="$HOME/Library/Application Support/obsidian" ;;
	*) USER_OBSIDIAN_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/obsidian" ;;
esac

pids() { pgrep -f -- "--user-data-dir=$DATA" || true; }

setup() {
	mkdir -p "$VAULT/.obsidian/plugins/$PLUGIN_ID" "$DATA"
	for f in main.js manifest.json styles.css; do
		[ -e "$PLUGIN_DIR/$f" ] && ln -sf "$PLUGIN_DIR/$f" "$VAULT/.obsidian/plugins/$PLUGIN_ID/$f"
	done
	[ -e "$PLUGIN_DIR/main.js" ] || echo "warning: no main.js yet; build the plugin before start"
	printf '["%s"]\n' "$PLUGIN_ID" > "$VAULT/.obsidian/community-plugins.json"
	# EXPL: Opening the vault on launch. The id is arbitrary; Obsidian only needs it to be stable.
	printf '{"vaults":{"sandboxvault000001":{"path":"%s","ts":%s000,"open":true}}}\n' "$VAULT" "$(date +%s)" \
		> "$DATA/obsidian.json"
	# EXPL: Run the same Obsidian version as the user: Obsidian installs updates as obsidian-<ver>.asar in its data
	#       folder and loads the newest one found there. Copy (read-only on their side) the newest one, if any.
	local asar
	asar="$(ls "$USER_OBSIDIAN_DATA"/obsidian-*.asar 2>/dev/null | sort -V | tail -1 || true)"
	if [ -n "$asar" ] && [ ! -e "$DATA/$(basename "$asar")" ]; then cp "$asar" "$DATA/"; fi
	# EXPL: Optional fixtures, copied into the vault and never overwriting. The default is the e2e suite's fixture
	#       vault (notes, plus .obsidian/ settings such as .obsidian/plugins/<id>/data.json), so a note added to
	#       reproduce a bug here is also there for the spec that guards it. The older sandbox-fixtures/ layout keeps
	#       working: its plugin-data.json becomes the plugin's data.json.
	local fixtures="${OBSIDIAN_SANDBOX_FIXTURES:-}"
	if [ -z "$fixtures" ]; then
		if [ -d "$PLUGIN_DIR/test/e2e/vaults/basic" ]; then fixtures="$PLUGIN_DIR/test/e2e/vaults/basic"
		else fixtures="$PLUGIN_DIR/sandbox-fixtures"; fi
	fi
	if [ -d "$fixtures" ]; then
		find "$fixtures" -type f ! -name plugin-data.json | while read -r src; do
			dest="$VAULT/${src#"$fixtures"/}"
			mkdir -p "$(dirname "$dest")"
			[ -e "$dest" ] || cp "$src" "$dest"
		done
		if [ -f "$fixtures/plugin-data.json" ] && [ ! -e "$VAULT/.obsidian/plugins/$PLUGIN_ID/data.json" ]; then
			cp "$fixtures/plugin-data.json" "$VAULT/.obsidian/plugins/$PLUGIN_ID/data.json"
		fi
	fi
	echo "sandbox ready: $SANDBOX (plugin $PLUGIN_ID${asar:+, Obsidian $(basename "$asar" .asar | sed 's/obsidian-//')})"
}

start() {
	[ -d "$VAULT" ] || setup
	if [ -n "$(pids)" ]; then echo "sandbox already running (port $PORT, data $DATA)"; status; return; fi
	if curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null; then die "port $PORT is taken; set OBSIDIAN_SANDBOX_PORT"; fi
	case "$(uname)" in
		Darwin) open -n -a Obsidian --args --user-data-dir="$DATA" --remote-debugging-port="$PORT" --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling ;;
		*) (obsidian --user-data-dir="$DATA" --remote-debugging-port="$PORT" --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling >/dev/null 2>&1 &) ;;
	esac
	for _ in $(seq 1 40); do
		if $CDP eval 'typeof app !== "undefined" && !!app.workspace?.layoutReady' 2>/dev/null | grep -q true; then
			trust
			status
			return
		fi
		sleep 0.5
	done
	die "Obsidian did not come up on port $PORT"
}

# EXPL: A new vault opens in Restricted Mode behind "Do you trust the author of this vault?", so community plugins
#       don't load. This is the sandbox's own throwaway vault: trust it (Obsidian then opens its plugin settings,
#       which is closed again) and wait for the plugin to load.
trust() {
	$CDP eval "(async () => {
		const sleep = ms => new Promise(r => setTimeout(r, ms));
		// A sandbox window behind other windows would otherwise stop painting, and CDP input and frame waits stall.
		try { require('electron').remote.getCurrentWebContents().setBackgroundThrottling(false); } catch {}
		await sleep(500);
		const button = [...document.querySelectorAll('.modal-container button')]
			.find(b => b.textContent.includes('Trust author'));
		if (button) button.click();
		else if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
		for (let i = 0; i < 40 && !app.plugins.plugins['$PLUGIN_ID']; i++) await sleep(250);
		await sleep(500);
		app.setting?.close();
		return !!app.plugins.plugins['$PLUGIN_ID'];
	})()" | grep -q true || die "plugin $PLUGIN_ID did not load (check: node $HERE/cdp.mjs logs 3000)"
}

stop() {
	local p
	p="$(pids)"
	[ -n "$p" ] || { echo "not running"; return; }
	# shellcheck disable=SC2086
	kill $p
	for _ in $(seq 1 20); do [ -z "$(pids)" ] && { echo "stopped"; return; }; sleep 0.5; done
	die "sandbox instance did not exit"
}

reload() {
	$CDP eval "(async () => { await app.plugins.disablePlugin('$PLUGIN_ID'); await app.plugins.enablePlugin('$PLUGIN_ID'); return 'reloaded $PLUGIN_ID'; })()"
}

status() {
	[ -n "$(pids)" ] || { echo "not running"; return; }
	$CDP eval '({ obsidian: require("electron").ipcRenderer.sendSync("version"), vault: app.vault.getName(), plugins: Object.keys(app.plugins.plugins) })'
}

case "${1:-}" in
	setup) setup ;;
	start) start ;;
	stop) stop ;;
	reload) reload ;;
	status) status ;;
	reset) stop || true; rm -rf "$SANDBOX"; echo "removed $SANDBOX" ;;
	*) sed -n '2,16p' "$0"; exit 1 ;;
esac
