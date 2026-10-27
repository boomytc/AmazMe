/* All values are main-process data rendered as text, never markup or executable input. */
const element = id => document.getElementById(id);
for (const command of ["check", "download", "install", "cancel", "later"]) element(command).onclick = () => window.amazmeUpdates.command(command);
element("channel").onchange = () => window.amazmeUpdates.command("channel", element("channel").value);
element("automatic").onchange = () => window.amazmeUpdates.command("automatic", element("automatic").checked);
window.amazmeUpdates.onState((state, copy) => {
	document.documentElement.lang = copy.language;
	for (const key of ["heading", "current", "status", "detail", "error", "channelLabel", "automaticLabel", "trust", "check", "download", "install", "cancel", "later"]) element(key).textContent = copy[key];
	element("channel").options[0].textContent = copy.stable;
	element("channel").options[1].textContent = copy.preview;
	element("channel").value = state.channel;
	element("automatic").checked = state.automatic;
	const busy = ["checking", "downloading", "verifying", "installing"].includes(state.phase);
	for (const key of ["check", "channel", "automatic"]) element(key).disabled = busy || state.phase === "ready";
	element("download").hidden = !(["available", "error"].includes(state.phase) && state.version);
	element("install").hidden = state.phase !== "ready";
	element("cancel").hidden = !["checking", "downloading", "verifying"].includes(state.phase);
	element("later").disabled = state.phase === "installing";
	element("progress").hidden = !["downloading", "verifying", "installing"].includes(state.phase);
	if (state.phase === "downloading" && state.total) { element("progress").max = state.total; element("progress").value = state.received || 0; }
	else element("progress").removeAttribute("value");
});
window.amazmeUpdates.command("state");
