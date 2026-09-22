// ==UserScript==
// @name         Telegram Ad Filter + Pinned Hider
// @version      1.5.2-taf.2
// @description  Collapses ad messages and can hide pinned messages per Telegram channel
// @license      MIT
// @author       VChet, modified for per-channel pinned hiding
// @icon         https://web.telegram.org/favicon.ico
// @namespace    telegram-ad-filter-pinned-hider
// @match        https://web.telegram.org/k/*
// @require      https://openuserjs.org/src/libs/sizzle/GM_config.js
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @homepage     https://github.com/VChet/telegram-ad-filter
// @homepageURL  https://github.com/VChet/telegram-ad-filter
// @supportURL   https://github.com/VChet/telegram-ad-filter
// ==/UserScript==

/* jshint esversion: 11 */

//#region src/DOM.ts
const globalStyles = `
  .advertisement {
    padding: 0.5rem 1rem;
    font-size: var(--messages-text-size);
    font-style: italic;
    font-weight: var(--font-weight-bold);
    color: var(--link-color);
    white-space: nowrap;
    cursor: pointer;
  }
  #telegram-ad-filter-settings,
  .telegram-ad-filter-pin-toggle {
    display: inline-flex;
    justify-content: center;
    width: 24px;
    font-size: 24px;
    color: transparent;
    text-shadow: 0 0 var(--secondary-text-color);
  }
  .telegram-ad-filter-pin-toggle {
    opacity: .6;
  }
  .telegram-ad-filter-pin-toggle:hover,
  .telegram-ad-filter-pin-toggle.is-active {
    opacity: 1;
  }
  .telegram-ad-filter-pin-toggle.is-active {
    text-shadow: 0 0 var(--primary-color);
    filter: drop-shadow(0 0 3px var(--primary-color));
  }
  .telegram-ad-filter-pin-toggle[hidden] {
    display: none !important;
  }
  .topbar.taf-hide-pinned-message .pinned-container.pinned-message,
  .chat.taf-pin-filter-chat .topbar .pinned-container.pinned-message {
    display: none !important;
  }
  .bubble.is-sponsored {
    display: none;
  }
  .bubble:not(.has-advertisement) .advertisement,
  .bubble.has-advertisement .bubble-content *:not(.advertisement),
  .bubble.has-advertisement .reply-markup {
    display: none;
  }
`;
const frameStyle = `
  inset: 115px auto auto 130px;
  border: none;
  height: 325px;
  margin: 0px;
  max-height: 95%;
  max-width: 95%;
  opacity: 1;
  overflow: auto;
  padding: 0px;
  position: fixed;
  width: 75%;
  z-index: 9999;
  display: block;
`;
const popupStyle = `
  #telegram-ad-filter {
    color: #fff;
    background: #181818;
    a {
      color: inherit;
    }
    textarea {
      width: 100%;
      min-height: 150px;
      resize: vertical;
    }
    .subtitle {
      margin-block: 4px;
      font-size: 12px;
    }
  }
  #telegram-ad-filter .reset,
  #telegram-ad-filter .reset a,
  #telegram-ad-filter_buttons_holder {
    color: inherit;
  }
`;
function addSettingsButton(element, callback) {
	if (element.querySelector("#telegram-ad-filter-settings")) return;
	const settingsButton = document.createElement("button");
	settingsButton.classList.add("btn-icon", "rp");
	settingsButton.setAttribute("title", "Telegram Ad Filter Settings");
	const ripple = document.createElement("div");
	ripple.classList.add("c-ripple");
	const icon = document.createElement("span");
	icon.id = "telegram-ad-filter-settings";
	icon.textContent = "⚙️";
	settingsButton.append(ripple);
	settingsButton.append(icon);
	settingsButton.addEventListener("click", (event) => {
		event.stopPropagation();
		callback();
	});
	element.append(settingsButton);
}
const HIDDEN_PINNED_CHANNELS_KEY = "telegram-ad-filter:hiddenPinnedChannels";
const TAF_HIDE_PINNED_CLASS = "taf-hide-pinned-message";
let hiddenPinnedChannels = readHiddenPinnedChannels();
let tafSyncQueued = false;
function readHiddenPinnedChannels() {
	try {
		const stored = typeof GM_getValue === "function" ? GM_getValue(HIDDEN_PINNED_CHANNELS_KEY, "[]") : "[]";
		const entries = Array.isArray(stored) ? stored : JSON.parse(stored);
		return new Set(entries.filter((entry) => typeof entry === "string"));
	} catch (error) {
		console.warn("Telegram Ad Filter: could not read hidden pinned channels", error);
		return new Set();
	}
}
function saveHiddenPinnedChannels() {
	try {
		if (typeof GM_setValue === "function") GM_setValue(HIDDEN_PINNED_CHANNELS_KEY, JSON.stringify([...hiddenPinnedChannels].sort()));
	} catch (error) {
		console.warn("Telegram Ad Filter: could not save hidden pinned channels", error);
	}
}
function hasLayout(element) {
	const rect = element.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}
function getVisibleBroadcastChat() {
	const chats = [...document.querySelectorAll(".chat")];
	return chats.find((chat) => chat.querySelector(".bubbles-inner.is-broadcast") && hasLayout(chat)) ||
		chats.find((chat) => chat.querySelector(".bubbles-inner.is-broadcast")) ||
		null;
}
function getCurrentChannelKey(chat) {
	let hash = (location.hash || "").replace(/^#/, "").replace(/^\/+/, "").split(/[?&#]/)[0];
	try {
		hash = decodeURIComponent(hash);
	} catch {}
	const usernameMatch = hash.match(/^(@[A-Za-z0-9_]{4,})(?:[\/_]|$)/);
	if (usernameMatch) return "username:" + usernameMatch[1].toLowerCase();
	const peerIdMatch = hash.match(/^(-?\d+)(?:[\/_]|$)/);
	if (peerIdMatch) return "id:" + peerIdMatch[1];
	const title = chat.querySelector(".topbar .user-title")?.textContent?.replace(/\s+/g, " ").trim();
	return title ? "title:" + title.toLocaleLowerCase() : null;
}
function isPinnedMessageVisible(topbar) {
	const pinned = topbar.querySelector(".pinned-container.pinned-message");
	return Boolean(pinned && !pinned.classList.contains("hide"));
}
function getOtherVisiblePlates(topbar) {
	return [...topbar.querySelectorAll(".topbar-floating-plates .pinned-container:not(.pinned-message)")]
		.filter((plate) => !plate.classList.contains("hide") && getComputedStyle(plate).display !== "none");
}
function getOtherFloatingHeight(topbar) {
	const heights = getOtherVisiblePlates(topbar).map((plate) => plate.offsetHeight || parseFloat(getComputedStyle(plate).height) || 0);
	if (!heights.length) return 0;
	return heights.reduce((sum, height) => sum + height, 0) + 8 + (heights.length - 1);
}
function setReducedFloatingHeight(chat, topbar, active) {
	const property = "--pinned-floating-height";
	const current = chat.style.getPropertyValue(property).trim();
	const applied = chat.dataset.tafAppliedPinnedHeight || "";
	if (active) {
		if (current !== applied) chat.dataset.tafOriginalPinnedHeight = current;
		const mainHeight = chat.classList.contains("is-search-active") ? 0 : getOtherFloatingHeight(topbar);
		const replacement = `calc(${mainHeight}px + var(--topbar-floating-call-height, 0px) + var(--topbar-floating-audio-height, 0px))`;
		if (current !== replacement) chat.style.setProperty(property, replacement);
		chat.dataset.tafAppliedPinnedHeight = replacement;
		return;
	}
	const appliedReplacement = chat.dataset.tafAppliedPinnedHeight || "";
	if (appliedReplacement && current === appliedReplacement && !chat.classList.contains("is-search-active")) {
		const original = chat.dataset.tafOriginalPinnedHeight || "";
		if (original) chat.style.setProperty(property, original);
		else chat.style.removeProperty(property);
	}
	delete chat.dataset.tafAppliedPinnedHeight;
	delete chat.dataset.tafOriginalPinnedHeight;
}
function setReducedTopPadding(chat, topbar, active) {
	const padding = chat.querySelector(".bubbles-padding-top");
	if (!padding) return;
	if (active) {
		const current = parseFloat(padding.style.height);
		const applied = parseFloat(padding.dataset.tafAppliedHeight || "");
		if (!Number.isFinite(current)) return;
		if (!Number.isFinite(applied) || Math.abs(current - applied) > 0.5) {
			const pinned = topbar.querySelector(".pinned-container.pinned-message");
			const pinnedHeight = parseFloat(pinned?.dataset.tafPlateHeight || "") || 48;
			const deduction = pinnedHeight + (getOtherVisiblePlates(topbar).length ? 1 : 8);
			const next = Math.max(0, Math.round(current - deduction));
			padding.dataset.tafNativeHeight = String(current);
			padding.dataset.tafAppliedHeight = String(next);
			padding.style.height = next + "px";
		}
		return;
	}
	const appliedHeight = parseFloat(padding.dataset.tafAppliedHeight || "");
	const currentHeight = parseFloat(padding.style.height || "");
	if (Number.isFinite(appliedHeight) && Math.abs(currentHeight - appliedHeight) <= 0.5 && !chat.classList.contains("is-search-active")) {
		const original = parseFloat(padding.dataset.tafNativeHeight || "");
		if (Number.isFinite(original)) padding.style.height = original + "px";
	}
	delete padding.dataset.tafNativeHeight;
	delete padding.dataset.tafAppliedHeight;
}
function resetPinnedFilterForChat(chat) {
	const topbar = chat.querySelector(".topbar");
	topbar?.classList.remove(TAF_HIDE_PINNED_CLASS);
	setReducedFloatingHeight(chat, topbar, false);
	setReducedTopPadding(chat, topbar, false);
	chat.classList.remove("taf-pin-filter-chat");
}
function ensurePinToggleButton(chatUtils) {
	let button = chatUtils.querySelector(".telegram-ad-filter-pin-toggle");
	if (button) return button;
	button = document.createElement("button");
	button.classList.add("btn-icon", "rp", "telegram-ad-filter-pin-toggle", "force-show-on-mobile");
	button.setAttribute("aria-pressed", "false");
	const ripple = document.createElement("div");
	ripple.classList.add("c-ripple");
	const icon = document.createElement("span");
	icon.textContent = "📌";
	button.append(ripple, icon);
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		toggleCurrentChannelPinned();
	});
	chatUtils.append(button);
	return button;
}
function updatePinToggleButton(button, visible, hidden) {
	button.hidden = !visible;
	button.classList.toggle("is-active", hidden);
	button.setAttribute("aria-pressed", hidden ? "true" : "false");
	const title = !visible ? "仅频道可用" : hidden ? "恢复此频道的置顶内容（Telegram Ad Filter）" : "隐藏此频道的置顶内容（Telegram Ad Filter）";
	if (button.title !== title) button.title = title;
}
function syncPinnedFilter() {
	tafSyncQueued = false;
	const chat = getVisibleBroadcastChat();
	const currentFilteredChats = [...document.querySelectorAll(".chat.taf-pin-filter-chat")];
	const pinButtons = [...document.querySelectorAll(".telegram-ad-filter-pin-toggle")];
	if (!chat) {
		currentFilteredChats.forEach(resetPinnedFilterForChat);
		pinButtons.forEach((button) => updatePinToggleButton(button, false, false));
		return;
	}
	currentFilteredChats.forEach((element) => {
		if (element !== chat) resetPinnedFilterForChat(element);
	});
	const topbar = chat.querySelector(".topbar");
	const chatUtils = topbar?.querySelector(".chat-utils");
	if (!topbar || !chatUtils) return;
	const key = getCurrentChannelKey(chat);
	const previousKey = chat.dataset.tafFilterChannel || "";
	if (previousKey && previousKey !== key) {
		resetPinnedFilterForChat(chat);
	}
	chat.dataset.tafFilterChannel = key || "";
	const hidden = Boolean(key && hiddenPinnedChannels.has(key));
	const button = ensurePinToggleButton(chatUtils);
	pinButtons.forEach((candidate) => {
		if (candidate !== button) updatePinToggleButton(candidate, false, false);
	});
	updatePinToggleButton(button, Boolean(key), hidden);
	const pinned = topbar.querySelector(".pinned-container.pinned-message");
	if (pinned && !pinned.dataset.tafPlateHeight) {
		const pinnedHeight = pinned.offsetHeight || parseFloat(getComputedStyle(pinned).getPropertyValue("--pinned-message-height")) || 48;
		pinned.dataset.tafPlateHeight = String(pinnedHeight);
	}
	topbar.classList.toggle(TAF_HIDE_PINNED_CLASS, hidden);
	chat.classList.toggle("taf-pin-filter-chat", hidden);
	const reducePinnedSpace = hidden && isPinnedMessageVisible(topbar) && !chat.classList.contains("is-search-active");
	setReducedFloatingHeight(chat, topbar, reducePinnedSpace);
	setReducedTopPadding(chat, topbar, reducePinnedSpace);
}
function queuePinnedFilterSync() {
	if (tafSyncQueued) return;
	tafSyncQueued = true;
	requestAnimationFrame(syncPinnedFilter);
}
function toggleCurrentChannelPinned() {
	const chat = getVisibleBroadcastChat();
	const key = chat && getCurrentChannelKey(chat);
	if (!key) return;
	if (hiddenPinnedChannels.has(key)) hiddenPinnedChannels.delete(key);
	else hiddenPinnedChannels.add(key);
	saveHiddenPinnedChannels();
	syncPinnedFilter();
}
function handleMessageNode(node, adWords) {
	const message = node.querySelector(".message");
	if (!message || node.querySelector(".advertisement")) return;
	const textContent = message.textContent?.toLowerCase();
	const links = [...message.querySelectorAll("a")].reduce((acc, { href }) => {
		if (href) acc.push(href.toLowerCase());
		return acc;
	}, []);
	if (!textContent && !links.length) return;
	if (!adWords.map((filter) => filter.toLowerCase()).some((filter) => textContent?.includes(filter) || links.some((href) => href.includes(filter)))) return;
	const trigger = document.createElement("div");
	trigger.classList.add("advertisement");
	trigger.textContent = "Hidden by filter";
	node.querySelector(".bubble-content")?.prepend(trigger);
	node.classList.add("has-advertisement");
	trigger.addEventListener("click", () => {
		node.classList.remove("has-advertisement");
	});
	message.addEventListener("click", () => {
		node.classList.add("has-advertisement");
	});
}
//#endregion
//#region package.json
var version = "1.5.2-taf.2";
//#endregion
//#region src/configs.ts
const title = document.createElement("div");
title.innerHTML = `
  Telegram Ad Filter + Pinned Hider Settings
  <p class="subtitle">Modified local build v${version}</p>
  <p class="subtitle">Use the 📌 button in a channel to hide or restore its pinned message.</p>
`;
const settingsConfig = {
	id: "telegram-ad-filter",
	frameStyle,
	css: popupStyle,
	title,
	fields: { listUrls: {
		label: "Blacklist URLs (one per line) – each URL must be a publicly accessible JSON file containing an array of blocked words or phrases",
		type: "textarea",
		default: "https://raw.githubusercontent.com/VChet/telegram-ad-filter/master/blacklist.json"
	} }
};
//#endregion
//#region src/fetch.ts
function isValidURL(payload) {
	try {
		if (typeof payload !== "string") return false;
		const parsedUrl = new URL(payload);
		return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
	} catch {
		return false;
	}
}
function isValidJSON(payload) {
	try {
		JSON.parse(payload);
		return true;
	} catch {
		return false;
	}
}
async function fetchAndParseJSON(url) {
	const content = await fetch(url).then((response) => response.text());
	if (!isValidJSON(content)) throw new SyntaxError(`Invalid JSON: data from ${url}`);
	return JSON.parse(content);
}
async function fetchLists(urlsString) {
	const urls = urlsString.split("\n").map((url) => url.trim()).filter(Boolean);
	const resultSet = /* @__PURE__ */ new Set();
	for (const url of urls) {
		if (!isValidURL(url)) throw new URIError(`Invalid URL: ${url}. Please ensure it leads to an online source like GitHub, Gist, Pastebin, etc.`);
		try {
			const parsedData = await fetchAndParseJSON(url);
			if (!Array.isArray(parsedData)) throw new TypeError(`Invalid array: data from ${url}`);
			const strings = parsedData.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
			for (const string of strings) resultSet.add(string);
		} catch (error) {
			if (error instanceof SyntaxError) throw error;
			throw new Error(`Fetch error: ${url}. Please check the URL or your network connection.`);
		}
	}
	return [...resultSet];
}
//#endregion
//#region src/index.ts
(async () => {
	GM_addStyle(globalStyles);
	let adWords = [];
	const gmc = new GM_configStruct({
		...settingsConfig,
		events: {
			init: async function() {
				adWords = await fetchLists(this.get("listUrls").toString());
			},
			save: async function() {
				try {
					adWords = await fetchLists(this.get("listUrls").toString());
					this.close();
				} catch (error) {
					alert(error instanceof Error ? error.message : String(error));
				}
			}
		}
	});
	function walk(node) {
		if (!(node instanceof HTMLElement) || !node.nodeType) return;
		let child = null;
		let next = null;
		switch (node.nodeType) {
			case node.ELEMENT_NODE:
			case node.DOCUMENT_NODE:
			case node.DOCUMENT_FRAGMENT_NODE:
				if (node.matches(".chat-utils")) {
					addSettingsButton(node, () => {
						gmc.open();
					});
					ensurePinToggleButton(node);
				}
				if (node.matches(".bubble")) handleMessageNode(node, adWords);
				child = node.firstChild;
				while (child) {
					next = child.nextSibling;
					walk(child);
					child = next;
				}
				break;
			case node.TEXT_NODE:
		}
	}
	function mutationHandler(mutationRecords) {
		let shouldSync = false;
		for (const { type, addedNodes, target } of mutationRecords) {
			if (type === "childList") {
				shouldSync = true;
				if (typeof addedNodes === "object" && addedNodes.length) for (const node of addedNodes) walk(node);
			} else if (type === "attributes" && target instanceof Element && target.matches(".chat, .topbar, .topbar-floating-plates, .pinned-container, .bubbles-inner, .bubbles-padding-top")) {
				shouldSync = true;
			}
		}
		if (shouldSync) queuePinnedFilterSync();
	}
	new MutationObserver(mutationHandler).observe(document, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["class", "style"]
	});
	window.addEventListener("hashchange", queuePinnedFilterSync);
	queuePinnedFilterSync();
})();
//#endregion




