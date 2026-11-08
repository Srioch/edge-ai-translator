// Registered only for sites selected in the popup. The worker rechecks the rule
// against the sender's URL to handle revocation and navigation races.
chrome.runtime.sendMessage({ type: "auto.start" }).catch(() => {});
