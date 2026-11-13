/* Shared website/extension transport. Media goes only to the upload Worker. */
(() => {
  const hex = (bytes) =>
    [...new Uint8Array(bytes)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  async function fingerprints(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const git = new Uint8Array(header.length + bytes.length);
    git.set(header);
    git.set(bytes, header.length);
    return {
      hash: hex(await crypto.subtle.digest("SHA-256", bytes)),
      gitSha: hex(await crypto.subtle.digest("SHA-1", git)),
      bytes: bytes.length,
    };
  }
  async function imagePreview(blob) {
    const image = await createImageBitmap(blob);
    try {
      const { width, height } = image;
      if (
        !width ||
        !height ||
        width > 32768 ||
        height > 32768 ||
        width * height > 80000000
      )
        throw Error("圖片超過本機預覽上限（8,000 萬像素）。");
      const scale = Math.min(1, 640 / width, 640 / height);
      const canvas =
        typeof OffscreenCanvas === "function"
          ? new OffscreenCanvas(
              Math.max(1, Math.round(width * scale)),
              Math.max(1, Math.round(height * scale)),
            )
          : Object.assign(document.createElement("canvas"), {
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
            });
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#e8eee8";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const preview = canvas.convertToBlob
        ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })
        : await new Promise((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", 0.8),
          );
      if (!preview || preview.size > 256 * 1024)
        throw Error("無法建立媒體預覽。");
      return { blob: preview, width, height };
    } finally {
      image.close();
    }
  }
  async function describe(blob, poster) {
    const original = await fingerprints(blob);
    return {
      ...original,
      ...(poster
        ? {
            preview: await fingerprints(poster.blob),
            width: poster.width,
            height: poster.height,
          }
        : {}),
    };
  }
  async function encoded(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts = ['{"encoding":"base64","content":"'];
    // Every chunk except the last is divisible by 3, so Base64 joins correctly.
    for (let at = 0; at < bytes.length; at += 24576)
      parts.push(btoa(String.fromCharCode(...bytes.subarray(at, at + 24576))));
    parts.push('"}');
    return new Blob(parts, { type: "application/json" });
  }
  function workerOrigin(value) {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/u.test(u.hostname) ||
      u.port ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      throw Error("GitHub 上傳後端網址不正確。");
    return u.origin;
  }
  async function send(
    ready,
    blob,
    poster,
    {
      fetch: request = globalThis.fetch,
      save = async () => {},
      state = {},
      signal,
      progress = () => {},
    } = {},
  ) {
    const origin = workerOrigin(ready.origin);
    if (
      globalThis.GPT2WEBGalleryConfig?.uploadOrigin &&
      origin !== globalThis.GPT2WEBGalleryConfig.uploadOrigin
    )
      throw Error("上傳後端與網站設定不符。");
    if (typeof ready.ticket !== "string" || !/^[a-f0-9]{64}$/u.test(ready.hash))
      throw Error("缺少 GitHub 上傳授權。");
    async function call(path, body) {
      const response = await request(origin + path, {
        method: "POST",
        headers: {
          "Content-Type": body?.type || "application/json",
          Authorization: "Bearer " + ready.ticket,
        },
        body,
        signal: signal || AbortSignal.timeout(240000),
        redirect: "error",
        credentials: "omit",
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok)
        throw Object.assign(
          Error(value.error || "GitHub 上傳中斷，請保留原檔後重試。"),
          { status: response.status },
        );
      return value;
    }
    const saved =
      state.hash === ready.hash ? { ...state } : { hash: ready.hash };
    for (const [part, file] of [
      ["original", blob],
      ["preview", poster?.blob],
    ]) {
      if (!file) continue;
      const expected =
        (part === "original" ? ready.gitSha : ready.previewGitSha) ||
        (await fingerprints(file)).gitSha;
      if (saved[part] === expected) continue;
      progress(part === "original" ? 0 : blob.size);
      const pack = file.size > 16 * 1024 * 1024;
      if (pack && !globalThis.GPT2WEBGitPack)
        throw Error("請更新網站或外掛以支援大檔上傳。");
      const result = await call(
        (pack ? "/pack" : "/blob") + "?part=" + part,
        pack
          ? await globalThis.GPT2WEBGitPack.encode(file, expected)
          : await encoded(file),
      );
      if (!result.ok || result.part !== part || result.gitSha !== expected)
        throw Error("GitHub 檔案收據不正確。");
      saved[part] = result.gitSha;
      await save({
        directState: saved,
        uploadedBytes: part === "original" ? blob.size : blob.size + file.size,
      });
    }
    const committed = await call("/commit", "{}");
    if (
      !committed.ok ||
      committed.hash !== ready.hash ||
      typeof committed.receipt !== "string"
    )
      throw Error("GitHub 提交尚未確認，請保留原檔。");
    await save({ directReceipt: committed.receipt, uploadedBytes: blob.size });
    return committed.receipt;
  }
  globalThis.GPT2WEBGithubDirect = Object.freeze({
    fingerprints,
    describe,
    imagePreview,
    encoded,
    workerOrigin,
    send,
  });
})();
