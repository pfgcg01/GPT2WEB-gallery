/* Public configuration contains the API address, never a Supabase service key. */
(() => {
  const config = globalThis.GPT2WEBGalleryConfig,
    base = new URL(config.apiBase),
    viewer = new URL(config.viewerUrl);
  if (
    base.protocol !== "https:" ||
    !/^[-a-z0-9]+\.supabase\.co$/iu.test(base.hostname) ||
    base.pathname !== "/functions/v1/gpt2web" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    viewer.origin !== location.origin
  )
    throw Error("圖庫連線設定不正確。");
  const key = "gpt2web-gallery-session:" + config.apiBase,
    media = new Map();
  let token;
  try {
    token = localStorage.getItem(key);
  } catch {}
  function remember(value) {
    token = value;
    media.clear();
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {}
  }
  async function request(route, options = {}) {
    if (!route.startsWith("/api/")) throw Error("不支援的圖庫操作。");
    const headers = new Headers(options.headers);
    if (token) headers.set("X-GPT2WEB-Access", token);
    const response = await fetch(config.apiBase + route, {
      ...options,
      headers,
      credentials: "omit",
      redirect: "error",
    });
    if (response.ok && ["/api/access", "/api/access/rotate"].includes(route)) {
      const result = await response.clone().json();
      if (result.session) remember(result.session);
    }
    if (
      (response.ok && route === "/api/access/logout") ||
      response.status === 401
    )
      remember(null);
    return response;
  }
  async function mediaUrl(route) {
    const cached = media.get(route);
    if (cached && cached.until > Date.now()) return cached.promise;
    const promise = (async () => {
      const response = await request(route, {
          cache: "no-store",
          signal: AbortSignal.timeout(25000),
        }),
        result = await response.json();
      if (!response.ok) throw Error(result.error || "圖片暫時無法載入。");
      const u = new URL(result.url);
      const supabase =
        u.origin === base.origin &&
        u.pathname.startsWith("/storage/v1/object/sign/gpt2web-private/");
      const github =
        u.origin === "https://raw.githubusercontent.com" &&
        /^\/Novel-1234\/GEN-IMG\/[a-f0-9]{40}\/(?:originals|thumbs)\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:png|jpg|webp)$/u.test(
          u.pathname,
        ) &&
        !u.search &&
        !u.hash;
      if (u.username || u.password || (!supabase && !github))
        throw Error("圖片來源不正確。");
      return u.href;
    })();
    media.set(route, { until: Date.now() + 90000, promise });
    try {
      return await promise;
    } catch (error) {
      media.delete(route);
      throw error;
    }
  }
  function loadImage(el, route) {
    void mediaUrl(route)
      .then((url) => {
        if (el.dataset.media === route) el.src = url;
      })
      .catch(() => {
        if (el.dataset.media === route) el.dispatchEvent(new Event("error"));
      });
  }
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries)
              if (entry.isIntersecting) {
                observer.unobserve(entry.target);
                loadImage(entry.target, entry.target.dataset.media);
              }
          },
          { rootMargin: "250px" },
        )
      : null;
  function image(el, route) {
    el.dataset.media = route;
    if (observer && route.includes("/thumb")) observer.observe(el);
    else loadImage(el, route);
  }
  function download(el, route) {
    el.href = "#";
    el.onclick = async (event) => {
      event.preventDefault();
      try {
        const a = document.createElement("a");
        const source = await mediaUrl(route);
        if (new URL(source).origin === base.origin) {
          // Supabase supplies Content-Disposition, including HTML/Markdown
          // report names. Preserve that download behavior for private files.
          a.href = source;
          a.rel = "noopener noreferrer";
          a.download = "";
          document.body.append(a);
          a.click();
          a.remove();
          return;
        }
        // Cross-origin Raw URLs do not honor the download attribute. Save the
        // fetched original bytes as a local Blob instead of navigating away.
        const response = await fetch(source, {
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) throw Error("原圖暫時無法下載。");
        const blob = await response.blob();
        const digest = [
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
          ),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (digest !== route.split("/")[3])
          throw Error("原圖校驗不符，沒有保存不完整的檔案。");
        const objectUrl = URL.createObjectURL(blob);
        a.href = objectUrl;
        a.rel = "noopener noreferrer";
        a.download =
          "image-" +
          route.split("/")[3].slice(0, 12) +
          "." +
          (new URL(source).pathname.match(/\.(png|jpg|webp)$/u)?.[1] || "png");
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      } catch (error) {
        alert(error.message);
      }
    };
  }
  function backup(el) {
    el.href = "#";
    el.onclick = async (event) => {
      event.preventDefault();
      try {
        const response = await request("/api/backup", {
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw Error("備份暫時無法下載。");
        const url = URL.createObjectURL(await response.blob()),
          a = document.createElement("a");
        a.href = url;
        a.download = "GPT2WEB-cloud-reviews.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (error) {
        alert(error.message);
      }
    };
  }
  document.addEventListener("click", (event) => {
    const a = event.target.closest("a[href]"),
      route = a?.getAttribute("href");
    if (!route?.startsWith("/api/images/")) return;
    event.preventDefault();
    download(a, route);
    a.click();
  });
  globalThis.GPT2WEBGalleryTransport = Object.freeze({
    fetch: request,
    image,
    download,
    backup,
    viewerUrl: viewer.href,
  });
})();
