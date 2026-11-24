/* Read Chrome's existing favicon cache. The extension has no host permissions. */
async function readTabFavicons(pageUrls) {
  async function readIcon(pageUrl) {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.search = new URLSearchParams({pageUrl, size: "16"});
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(600)});
      if (!response.ok) return "";
      const bytes = new Uint8Array(await response.arrayBuffer());
      // Chrome's internal response does not include a Content-Type header.
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      return bytes.length <= 2048 && signature.every((byte, index) => bytes[index] === byte)
        ? btoa(String.fromCharCode(...bytes))
        : "";
    } catch {
      return "";
    }
  }

  const [fallback, ...icons] = await Promise.all([
    readIcon("https://agentbox-favicon-placeholder.invalid/"),
    ...pageUrls.map(readIcon),
  ]);
  return icons.map(icon => icon === fallback ? "" : icon);
}
