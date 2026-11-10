/* Owner-session uploads. TUS offsets and immutable metadata survive page reloads. */
(() => {
  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  const digest = async (value) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  const base64 = (bytes) => {
    let s = "";
    for (let at = 0; at < bytes.length; at += 8192)
      s += String.fromCharCode(...bytes.subarray(at, at + 8192));
    return btoa(s);
  };
  async function api(route, value) {
    const response = await (globalThis.GPT2WEBGalleryTransport?.fetch || fetch)(
      route,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-GPT2WEB-Gallery": "1",
        },
        body: JSON.stringify(value),
        signal: AbortSignal.timeout(180000),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(Error(result.error || "上傳暫未完成。"), {
        status: response.status,
      });
    return result;
  }
  async function preview(file, mime) {
    const url = URL.createObjectURL(file),
      video = mime.startsWith("video/"),
      media = document.createElement(video ? "video" : "img");
    const canvas = document.createElement("canvas");
    let width = 960,
      height = 540,
      decoded = false;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("讀取預覽逾時")), 15000);
        const done = (fn) => () => {
          clearTimeout(timer);
          fn();
        };
        media.onerror = done(() => reject(Error("無法讀取預覽")));
        if (video) {
          media.muted = true;
          media.preload = "auto";
          media.onloadeddata = done(resolve);
        } else media.onload = done(resolve);
        media.src = url;
      });
      width = video ? media.videoWidth : media.naturalWidth;
      height = video ? media.videoHeight : media.naturalHeight;
      if (!width || !height || width * height > 16000000)
        throw Error("媒體尺寸超過 1,600 萬像素。");
      decoded = true;
    } catch (error) {
      URL.revokeObjectURL(url);
      if (video) {
        media.pause();
        media.removeAttribute("src");
        media.load();
      }
      throw Error(
        video
          ? "此瀏覽器無法讀取影片預覽；請使用相容的 MP4（H.264）或 WebM 檔案。"
          : error.message,
      );
    }
    try {
      const scale = Math.min(1, 640 / width, 640 / height);
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      context.fillStyle = "#e8eee8";
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (decoded) context.drawImage(media, 0, 0, canvas.width, canvas.height);
      else {
        context.fillStyle = "#285b4b";
        context.font = "28px sans-serif";
        context.textAlign = "center";
        context.fillText(
          "影片 · 下載原檔觀看",
          canvas.width / 2,
          canvas.height / 2,
        );
      }
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.8),
      );
      if (!blob || blob.size > 256 * 1024) throw Error("無法建立媒體預覽。");
      return { blob, width, height };
    } finally {
      if (video) {
        media.pause();
        media.removeAttribute("src");
        media.load();
      }
      URL.revokeObjectURL(url);
    }
  }
  function allowed(url, origin) {
    try {
      const u = new URL(url),
        base = new URL(origin);
      return (
        base.protocol === "https:" &&
        /^[a-z0-9-]+\.supabase\.co$/iu.test(base.hostname) &&
        u.protocol === "https:" &&
        [
          base.hostname,
          base.hostname.replace(".supabase.co", ".storage.supabase.co"),
        ].includes(u.hostname) &&
        !u.username &&
        !u.password &&
        !u.port &&
        !u.hash &&
        /^\/storage\/v1\/upload\/resumable(?:\/|$)/u.test(u.pathname)
      );
    } catch {
      return false;
    }
  }
  async function transfer(item, save, progress = () => {}) {
    const spec = item.spec;
    if (
      !item.file ||
      item.file.size !== spec.bytes ||
      (await digest(await item.file.arrayBuffer())) !== spec.hash
    )
      throw Object.assign(Error("待傳原檔指紋不符，請重新選擇。"), {
        status: 422,
      });
    const ready = await api("/api/uploads/prepare", spec);
    if (ready.complete) {
      if (ready.hash !== spec.hash) throw Error("上傳收據指紋不符。");
      return;
    }
    if (!ready.uploaded) {
      if (
        !allowed(ready.tusEndpoint, ready.storageOrigin) ||
        ready.path !==
          `${item.libraryId}/originals/${spec.hash}.${extensions[spec.mime]}` ||
        ready.bucket !== "gpt2web-private"
      )
        throw Error("上傳目的地不符合此圖庫。");
      const common = { "Tus-Resumable": "1.0.0", "x-signature": ready.token };
      let upload = item.upload,
        offset = 0;
      if (upload) {
        if (!allowed(upload.url, ready.storageOrigin))
          throw Error("續傳位址不正確。");
        const head = await fetch(upload.url, {
          method: "HEAD",
          headers: common,
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        if ([401, 403, 404, 410].includes(head.status)) {
          upload = null;
          await save({ upload: null });
        } else if (!head.ok)
          throw Object.assign(Error("無法核對續傳位置。"), {
            status: head.status,
          });
        else offset = Number(head.headers.get("Upload-Offset"));
      }
      if (!upload) {
        const metadata = Object.entries({
          bucketName: ready.bucket,
          objectName: ready.path,
          contentType: spec.mime,
          cacheControl: "120",
        })
          .map(([key, value]) => key + " " + btoa(value))
          .join(",");
        const response = await fetch(ready.tusEndpoint, {
          method: "POST",
          headers: {
            ...common,
            "Upload-Length": String(spec.bytes),
            "Upload-Metadata": metadata,
          },
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        });
        if (response.status === 409) return complete();
        if (!response.ok)
          throw Object.assign(Error("建立續傳失敗。"), {
            status: response.status,
          });
        const location = response.headers.get("Location");
        if (!location) throw Error("儲存服務未提供續傳位址。");
        upload = { url: new URL(location, ready.tusEndpoint).href };
        if (!allowed(upload.url, ready.storageOrigin))
          throw Error("續傳位址不正確。");
        offset = Number(response.headers.get("Upload-Offset") || 0);
        await save({ upload });
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > spec.bytes)
        throw Error("續傳長度不正確。");
      while (offset < spec.bytes) {
        const end = Math.min(spec.bytes, offset + 6 * 1024 * 1024),
          response = await fetch(upload.url, {
            method: "PATCH",
            headers: {
              ...common,
              "Content-Type": "application/offset+octet-stream",
              "Upload-Offset": String(offset),
            },
            body: item.file.slice(offset, end),
            signal: AbortSignal.timeout(120000),
            redirect: "error",
          });
        if (!response.ok)
          throw Object.assign(Error("檔案傳送中斷，已保留續傳資料。"), {
            status: response.status,
          });
        if (Number(response.headers.get("Upload-Offset")) !== end)
          throw Error("儲存服務回報長度不符。");
        offset = end;
        await save({ uploadedBytes: offset });
        progress(offset / spec.bytes);
      }
    }
    return complete();
    async function complete() {
      progress(1);
      const result = await api("/api/uploads/complete", {
        id: spec.id,
        ...(item.preview
          ? {
              preview: base64(new Uint8Array(await item.preview.arrayBuffer())),
            }
          : {}),
      });
      if (!result.ok || result.hash !== spec.hash)
        throw Error("原檔仍在核對，尚未標記成功。");
    }
  }
  globalThis.GPT2WEBUploadTransfer = { extensions, digest, preview, transfer };
})();
