(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));

	/* ---------- clipboard interception ---------- */

	const cb = navigator.clipboard;
	if (!cb) {
		alert("navigator.clipboard unavailable");
		return;
	}

	const origWriteText = cb.writeText?.bind(cb);
	const origWrite = cb.write?.bind(cb);

	let lastClipboardText = "";
	let lastChangeTs = 0;

	function recordChange(text) {
		lastClipboardText = String(text || "");
		lastChangeTs = performance.now();
	}

	if (origWriteText) {
		cb.writeText = async t => {
			recordChange(t);
			return origWriteText(t);
		};
	}
	if (origWrite) {
		cb.write = async items => {
			try {
				for (const it of items || []) {
					if (it?.types?.includes("text/plain")) {
						const blob = await it.getType("text/plain");
						recordChange(await blob.text());
						break;
					}
				}
			} catch {}
			return origWrite(items);
		};
	}

	/* ---------- helpers ---------- */

	const isDiff = t =>
		/(^diff --git |^--- |^\+\+\+ |^@@ )/m.test(t || "");

	const keyOf = t => {
		const m = (t || "").match(/^diff --git\s+(.+)$/m);
		return m ? m[1].trim() : "len:" + (t || "").length;
	};

	const menus = () =>
		[...document.querySelectorAll(
			'[role="menu"],[data-radix-popper-content-wrapper] [role="menu"]'
		)];

	const menuButtons = () =>
		[...document.querySelectorAll(
			'button[aria-haspopup="menu"],[role="button"][aria-haspopup="menu"]'
		)];

	async function openMenu(btn) {
		const before = new Set(menus());
		btn.click();
		for (let i = 0; i < 60; i++) {
			await sleep(50);
			const ms = menus();
			const m = ms.find(x => !before.has(x)) || ms[ms.length - 1];
			if (m) return m;
		}
		return null;
	}

	function findCopyPatch(menu) {
		const items = [...menu.querySelectorAll(
			'button,[role="menuitem"],[data-radix-collection-item]'
		)];
		return (
			items.find(x => /^\s*copy patch\s*$/i.test(x.innerText || "")) ||
			items.find(x => /copy patch/i.test(x.innerText || "")) ||
			null
		);
	}

	async function waitForDiffAndQuiet(before, {
		maxMs = 12000,
		quietMs = 250
	} = {}) {
		const start = performance.now();
		while (performance.now() - start < maxMs) {
			if (lastClipboardText !== before && isDiff(lastClipboardText)) {
				const stamp = lastChangeTs;
				while (performance.now() - stamp < quietMs) {
					await sleep(25);
					if (lastChangeTs !== stamp) break;
				}
				if (performance.now() - lastChangeTs >= quietMs)
					return lastClipboardText;
			}
			await sleep(25);
		}
		return null;
	}

	function scrollStep() {
		window.scrollBy(0, Math.floor(window.innerHeight * 0.75));
	}

	/* ---------- main loop ---------- */

	const seen = new Set();
	const acc = [];
	let ok = 0, fail = 0;
	let stagnant = 0;

	for (let round = 0; round < 200; round++) {
		let didWork = false;

		for (const btn of menuButtons()) {
			if (btn.__seen) continue;
			btn.__seen = true;

			btn.scrollIntoView({ block: "center" });
			await sleep(80);

			const menu = await openMenu(btn);
			if (!menu) { fail++; continue; }

			const cp = findCopyPatch(menu);
			if (!cp) {
				document.body.click();
				fail++;
				continue;
			}

			const before = lastClipboardText;
			cp.click();

			const diff = await waitForDiffAndQuiet(before);
			if (diff) {
				const k = keyOf(diff);
				if (!seen.has(k)) {
					seen.add(k);
					acc.push(diff.trimEnd());
					ok++;
				}
				didWork = true;
			} else {
				fail++;
			}

			document.body.click();
			await sleep(80);
		}

		if (didWork) {
			stagnant = 0;
		} else if (++stagnant >= 2) {
			break;
		}

		scrollStep();
		await sleep(250);
	}

	/* ---------- finalize ---------- */

	await sleep(500); // let late UI writes finish

	if (!acc.length) {
		alert("Captured 0 patches.");
		return;
	}

	const out = acc.join("\n\n") + "\n";

	if (origWriteText) {
		await origWriteText(out);
	} else {
		await cb.write([
			new ClipboardItem({
				"text/plain": new Blob([out], { type: "text/plain" })
			})
		]);
	}

	await sleep(600); // prevent late overwrite

	// restore clipboard
	if (origWriteText) cb.writeText = origWriteText;
	if (origWrite) cb.write = origWrite;

	alert(`Copied ${ok} unique patch(es) (${fail} failed).`);
})();
