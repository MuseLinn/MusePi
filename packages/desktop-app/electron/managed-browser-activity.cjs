"use strict";

function startActivity(ledger, input, maxItems) {
	const item = {
		id: input.key,
		action: input.action,
		summary: input.summary,
		domain: input.domain ?? null,
		status: input.status ?? "dispatched",
		tabId: String(input.tabId),
		at: input.at ?? Date.now(),
	};
	ledger.push(item);
	while (ledger.length > maxItems) {
		const terminal = ledger.findIndex(candidate => candidate.status !== "dispatched");
		if (terminal < 0) break;
		ledger.splice(terminal, 1);
	}
	return item;
}

function settleActivity(ledger, key, status) {
	const item = ledger.find(candidate => candidate.id === key);
	if (!item || item.status !== "dispatched") return false;
	item.status = status;
	return true;
}

function projectActivity(ledger, activeTabId) {
	const running = ledger.filter(item => item.status === "dispatched");
	const activity =
		running.find(item => item.tabId === activeTabId) ?? running[0] ?? ledger[ledger.length - 1] ?? null;
	return {
		activity,
		busyTabIds: [...new Set(running.map(item => item.tabId))],
	};
}

function takeoverActivity(ledger, tabId) {
	let changed = 0;
	for (const item of ledger) {
		if (item.tabId !== tabId || item.status !== "dispatched") continue;
		item.status = "canceled";
		changed++;
	}
	return changed;
}

module.exports = { projectActivity, settleActivity, startActivity, takeoverActivity };
