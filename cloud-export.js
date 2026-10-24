// Assemble verified original files in the browser, outside serverless response
// size limits. Deliberately bounded to 200 MB; no resizing or transcoding.
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
export async function cloudZip(
  entries,
  {
    fetch: request = fetch,
    progress = () => {},
    resolveUrl = (entry) => entry.url,
    cache = new Map(),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > 500 ||
    entries.reduce((n, e) => n + e.size, 0) > 200 * 1024 * 1024
  )
    throw Error("一次最多匯出 500 張／200 MB。");
  const local = [],
    central = [];
  let offset = 0,
    count = 0;
  for (const entry of entries) {
    if (
      !/^[a-f0-9]{64}$/u.test(entry.id) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.name.includes("..") ||
      entry.name.startsWith("/") ||
      entry.name.includes("\\")
    )
      throw Error("匯出清單不正確。");
    progress(`正在核對原檔 ${++count}／${entries.length}…`);
    let data = cache.get(entry.id);
    if (data && data.length !== entry.size) {
      cache.delete(entry.id);
      data = null;
    }
    for (let attempt = 0; !data; attempt++) {
      try {
        const url = new URL(await resolveUrl(entry));
        if (
          url.protocol !== "https:" ||
          !/^[-a-z0-9]+\.supabase\.co$/iu.test(url.hostname) ||
          !url.pathname.startsWith("/storage/v1/object/sign/")
        )
          throw Object.assign(Error("原檔下載位址不正確。"), {
            terminal: true,
          });
        const response = await request(url.href, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(90000),
        });
        if (!response.ok)
          throw Error("原檔下載中斷，已核對檔案仍保留，可再按匯出續傳。");
        const reader = response.body.getReader(),
          chunks = [];
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > entry.size) {
            await reader.cancel();
            throw Object.assign(Error("原檔長度不符。"), { terminal: true });
          }
          chunks.push(value);
        }
        if (length !== entry.size) throw Error("原檔尚未完整下載。");
        const bytes = new Uint8Array(length);
        let position = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, position);
          position += chunk.length;
        }
        const digest = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        ]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (digest !== entry.id)
          throw Object.assign(
            Error("原檔 SHA-256 不符，沒有匯出未核對的 ZIP。"),
            { terminal: true },
          );
        cache.set(entry.id, bytes);
        data = bytes;
      } catch (error) {
        if (error.terminal || attempt >= 2) throw error;
        progress(`第 ${count} 張連線中斷，取得新連結後重試；已核對檔案保留。`);
        await wait(1000 * (attempt + 1));
      }
    }
    const length = data.length;
    const name = new TextEncoder().encode(entry.name),
      checksum = crc(data),
      header = new Uint8Array(30),
      h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x800, true);
    h.setUint16(12, 33, true);
    h.setUint32(14, checksum, true);
    h.setUint32(18, length, true);
    h.setUint32(22, length, true);
    h.setUint16(26, name.length, true);
    const directory = new Uint8Array(46),
      d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 0x0a14, true);
    d.setUint16(6, 20, true);
    d.setUint16(8, 0x800, true);
    d.setUint16(14, 33, true);
    d.setUint32(16, checksum, true);
    d.setUint32(20, length, true);
    d.setUint32(24, length, true);
    d.setUint16(28, name.length, true);
    d.setUint32(42, offset, true);
    local.push(header, name, new Blob([data]));
    central.push(directory, name);
    offset += header.length + name.length + length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0),
    end = new Uint8Array(22),
    e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: "application/zip" });
}
let active = false,
  selection = "",
  saved = new Map();
export async function saveCloudZip(entries, progress) {
  if (active) throw Error("正在匯出，請等待目前下載完成。");
  const key = entries
    .map((entry) => entry.id)
    .sort()
    .join(":");
  if (key !== selection) {
    saved.clear();
    selection = key;
  }
  active = true;
  try {
    const resolveUrl = async (entry) => {
      const response = await (
        globalThis.GPT2WEBGalleryTransport?.fetch || fetch
      )("/api/exports/file", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GPT2WEB-Gallery": "1",
        },
        body: JSON.stringify({ id: entry.id }),
        signal: AbortSignal.timeout(30000),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "無法取得新的下載連結。");
      return result.url;
    };
    const blob = await cloudZip(entries, {
        progress,
        resolveUrl,
        cache: saved,
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = `GPT2WEB-selected-${Date.now()}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    saved.clear();
    selection = "";
    progress(`已核對 ${entries.length} 張原檔，請查看瀏覽器下載。`);
  } finally {
    active = false;
  }
}
