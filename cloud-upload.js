/* Persistent, library-scoped upload queue. No owner key is stored in the queue. */
(() => {
  const FIELDS = {
      prompt: ["Prompt", 8000],
      source: ["來源", 500],
      model: ["模型", 120],
      notes: ["備註", 2000],
    },
    MAX = 40 * 1024 * 1024,
    LIMIT = 512 * 1024 * 1024;
  const ui = () => globalThis.GPT2WEBGalleryUI,
    transfer = () => globalThis.GPT2WEBUploadTransfer;
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  let dialog,
    list,
    summary,
    start,
    pause,
    clear,
    picker,
    common,
    commonFields = {},
    batchName,
    db,
    items = [],
    libraryId,
    batch,
    running = false,
    adding = false,
    pausing = false;
  const urls = new Map(),
    rows = new Map();
  function database() {
    return (db ||= new Promise((resolve, reject) => {
      const request = indexedDB.open("gpt2web-website-uploads", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("items", { keyPath: "id" });
        request.result.createObjectStore("batches", { keyPath: "libraryId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(Error("無法保存待傳檔案，請允許此網站使用瀏覽器儲存空間。"));
    }));
  }
  async function store(name, value, remove = false) {
    const database = await db;
    return new Promise((resolve, reject) => {
      const tx = database.transaction(name, "readwrite");
      tx.objectStore(name)[remove ? "delete" : "put"](value);
      tx.oncomplete = resolve;
      tx.onerror = () =>
        reject(Error("待傳資料無法保存，可能儲存空間不足；請保留原始檔案。"));
      tx.onabort = tx.onerror;
    });
  }
  async function all(name) {
    const database = await db;
    return new Promise((resolve, reject) => {
      const request = database.transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function update(item, patch) {
    const saved = { ...item, ...patch };
    // Keep consecutive field edits on the newest draft while IndexedDB commits.
    // Applying an older snapshot after await would overwrite a later checkbox/edit.
    Object.assign(item, patch);
    await store("items", saved);
    renderItem(item);
  }
  function input(field, value, oninput, prefix) {
    const [label, max] = FIELDS[field],
      wrap = el("label", undefined, "upload-field"),
      area = el(field === "prompt" || field === "notes" ? "textarea" : "input");
    wrap.append(el("span", label + "（選填）"));
    area.maxLength = max;
    area.value = value || "";
    if (area.localName === "textarea") area.rows = field === "prompt" ? 3 : 2;
    area.setAttribute("aria-label", prefix + label);
    area.onchange = () => oninput(area.value);
    wrap.append(area);
    return { wrap, area };
  }
  function counts() {
    const done = items.filter((i) => i.state === "done").length,
      failed = items.filter((i) => i.state === "failed").length;
    summary.textContent = `共 ${items.length} 個檔案 · 已完成 ${done} · 待傳 ${items.length - done - failed} · 失敗 ${failed}${running ? (pausing ? " · 本檔完成後暫停" : " · 正在上傳") : ""}`;
    start.disabled =
      running || adding || !items.some((i) => i.state !== "done");
    start.textContent = items.some((i) => i.spec)
      ? "繼續／重試未完成檔案"
      : "開始批次上傳";
    pause.hidden = !running;
    pause.disabled = pausing;
    clear.disabled = running || adding || !items.length;
    picker.disabled = running || adding;
    common.disabled = running || adding;
    // Rows created while adding are disabled until the selection is committed.
    // Refresh every row when the queue returns to idle or begins uploading.
    for (const item of items) renderItem(item);
  }
  function renderItem(item) {
    let row = rows.get(item.id);
    if (!row) {
      row = el("article", undefined, "upload-item");
      row.dataset.uploadId = item.id;
      const picture = el("div", undefined, "upload-preview");
      if (item.file && item.mime.startsWith("image/")) {
        const img = el("img");
        const url = URL.createObjectURL(item.file);
        urls.set(item.id, url);
        img.src = url;
        img.alt = "";
        img.loading = "lazy";
        picture.append(img);
      } else
        picture.append(
          el("span", item.mime?.startsWith("video/") ? "▶ 影片" : "✓"),
        );
      const body = el("div", undefined, "upload-item-body"),
        title = el("h3", item.filename),
        status = el("p", undefined, "upload-item-status");
      status.setAttribute("role", "status");
      const details = el("details"),
        toggle = el("input");
      toggle.type = "checkbox";
      toggle.checked = item.custom;
      toggle.setAttribute("aria-label", "自行填寫 " + item.filename);
      const toggleLabel = el("label", undefined, "upload-custom-toggle");
      toggleLabel.append(
        toggle,
        document.createTextNode("這個檔案使用獨立資料（可留空）"),
      );
      const custom = el("fieldset", undefined, "upload-individual-fields"),
        fields = {};
      for (const field of Object.keys(FIELDS)) {
        const control = input(
          field,
          item.fields?.[field],
          async (value) => {
            try {
              await update(item, {
                fields: { ...item.fields, [field]: value },
              });
            } catch (e) {
              ui().toast(e.message);
            }
          },
          item.filename + " ",
        );
        fields[field] = control.area;
        custom.append(control.wrap);
      }
      toggle.onchange = async () => {
        try {
          await update(item, { custom: toggle.checked });
        } catch (e) {
          ui().toast(e.message);
          toggle.checked = item.custom;
        }
      };
      const caption = el("summary", "個別資料與調整");
      details.append(caption, toggleLabel, custom);
      const remove = el("button", "移除", "secondary");
      remove.type = "button";
      remove.onclick = async () => {
        try {
          await store("items", item.id, true);
          items = items.filter((i) => i !== item);
          row.remove();
          rows.delete(item.id);
          URL.revokeObjectURL(urls.get(item.id));
          urls.delete(item.id);
          counts();
        } catch (e) {
          ui().toast(e.message);
        }
      };
      const progress = el("progress");
      progress.max = 1;
      progress.value = 0;
      progress.setAttribute("aria-label", item.filename + " 上傳進度");
      body.append(title, status, progress, details);
      row.append(picture, body, remove);
      row._parts = {
        status,
        details,
        toggle,
        custom,
        fields,
        remove,
        progress,
      };
      rows.set(item.id, row);
      list.append(row);
    }
    const p = row._parts;
    p.status.textContent =
      {
        queued: "等待上傳",
        uploading: "正在傳送原檔…",
        verifying: "原檔已傳送，正在核對與建立預覽…",
        failed: "未完成：" + item.error,
        done: "已核對完成",
      }[item.state] || "等待續傳";
    p.progress.value =
      item.state === "done"
        ? 1
        : (item.uploadedBytes || 0) /
          (item.spec?.bytes || item.file?.size || 1);
    p.custom.hidden = !item.custom;
    p.toggle.disabled = running || !!item.spec;
    p.custom.disabled = running || !!item.spec;
    p.remove.disabled = running || adding;
    p.details.hidden = item.state === "done";
    row.dataset.state = item.state;
    if (item.spec) {
      p.status.textContent +=
        item.state === "failed" ? "；重試會沿用原資料，避免重複。" : "";
    }
  }
  async function choose(files) {
    if (running || adding) return;
    adding = true;
    counts();
    const problems = [];
    try {
      for (const file of files) {
        const extension = file.name.split(".").at(-1).toLowerCase(),
          mime =
            Object.keys(transfer().extensions).find(
              (key) => transfer().extensions[key] === extension,
            ) || (extension === "jpeg" ? "image/jpeg" : null);
        if (!mime) {
          problems.push(file.name + "：不支援的格式");
          continue;
        }
        if (!file.size || file.size > MAX) {
          problems.push(file.name + "：單檔需為 1 byte–40 MiB");
          continue;
        }
        if (
          items.length >= 100 ||
          items.reduce((sum, i) => sum + (i.file?.size || 0), 0) + file.size >
            LIMIT
        ) {
          problems.push("已達 100 個檔案或 512 MiB 待傳上限，請先完成這批。");
          break;
        }
        const item = {
          id: crypto.randomUUID(),
          libraryId,
          filename: file.name,
          file,
          mime,
          fields: {},
          custom: false,
          state: "queued",
          addedAt: Date.now(),
        };
        await store("items", item);
        items.push(item);
        renderItem(item);
      }
    } catch (error) {
      problems.push(error.message);
    } finally {
      adding = false;
      counts();
    }
    if (problems.length) message(problems.join("\n"));
  }
  function message(text) {
    dialog.querySelector(".upload-message").textContent = text;
  }
  function init() {
    if (dialog) return;
    const button = el("button", "批次上傳", "primary");
    button.id = "cloud-upload-open";
    button.onclick = () => open();
    document.querySelector(".header-actions").prepend(button);
    dialog = el("dialog", undefined, "upload-dialog");
    dialog.id = "cloud-upload";
    dialog.setAttribute("aria-labelledby", "cloud-upload-title");
    const header = el("header", undefined, "dialog-heading"),
      heading = el("h2", "批次上傳作品");
    heading.id = "cloud-upload-title";
    const close = el("button", "關閉", "secondary");
    close.setAttribute("aria-label", "關閉批次上傳");
    close.onclick = () => dialog.close();
    header.append(heading, close);
    const note = el(
      "p",
      "一次選取多張圖片、GIF 或影片，共用填寫資料，也可逐一調整。所有欄位皆可留空；填寫 Prompt 才會自動預分類。原始檔案保存到現有公開 GEN-IMG 儲存庫，Prompt 等資料保存在私人圖庫。",
      "upload-note",
    );
    const drop = el("div", undefined, "upload-dropzone"),
      chooseButton = el("button", "選擇多個檔案", "secondary");
    picker = el("input");
    picker.id = "upload-files";
    picker.type = "file";
    picker.multiple = true;
    picker.accept = ".png,.jpg,.jpeg,.webp,.gif,.mp4,.webm";
    picker.hidden = true;
    chooseButton.onclick = () => {
      if (!running && !adding) picker.click();
    };
    picker.onchange = () => {
      void choose(Array.from(picker.files));
      picker.value = "";
    };
    drop.append(
      chooseButton,
      picker,
      el(
        "p",
        "或將檔案拖曳到這裡。支援 PNG、JPG、WebP、GIF、MP4、WebM；單檔最多 40 MiB。影片能否播放取決於瀏覽器支援的編碼。",
      ),
    );
    drop.ondragover = (e) => e.preventDefault();
    drop.ondrop = (e) => {
      e.preventDefault();
      void choose(e.dataTransfer.files);
    };
    common = el("fieldset", undefined, "upload-common");
    const legend = el("legend", "這批檔案的共用資料（全部選填）"),
      batchLabel = el("label", undefined, "upload-field");
    batchName = el("input");
    batchName.id = "upload-batch-name";
    batchName.maxLength = 100;
    batchName.setAttribute("aria-label", "批次名稱");
    batchLabel.append(el("span", "批次名稱"), batchName);
    common.append(legend, batchLabel);
    const persistBatch = async () => {
      Object.assign(batch, {
        name: batchName.value,
        fields: Object.fromEntries(
          Object.entries(commonFields).map(([k, v]) => [k, v.value]),
        ),
      });
      try {
        await store("batches", batch);
      } catch (error) {
        message(error.message);
      }
    };
    batchName.onchange = persistBatch;
    for (const field of Object.keys(FIELDS)) {
      const control = input(field, "", persistBatch, "共用 ");
      commonFields[field] = control.area;
      common.append(control.wrap);
    }
    summary = el("p", undefined, "upload-summary");
    summary.id = "upload-summary";
    summary.setAttribute("role", "status");
    list = el("div");
    list.id = "upload-list";
    const feedback = el("p", undefined, "upload-message");
    feedback.setAttribute("role", "status");
    const actions = el("div", undefined, "upload-actions");
    start = el("button", "開始批次上傳", "primary");
    start.id = "upload-start";
    start.onclick = () => run();
    pause = el("button", "本檔完成後暫停", "secondary");
    pause.onclick = () => {
      pausing = true;
      counts();
    };
    clear = el("button", "清除已完成／開始新批次", "secondary");
    clear.onclick = async () => {
      try {
        for (const item of items.filter((i) => i.state === "done")) {
          await store("items", item.id, true);
          rows.get(item.id)?.remove();
          rows.delete(item.id);
          URL.revokeObjectURL(urls.get(item.id));
          urls.delete(item.id);
        }
        items = items.filter((i) => i.state !== "done");
        if (!items.length) {
          batch = {
            libraryId,
            id: crypto.randomUUID(),
            startedAt: Date.now(),
            name: "",
            fields: {},
          };
          await store("batches", batch);
          batchName.value = "";
          for (const input of Object.values(commonFields)) input.value = "";
        }
        counts();
      } catch (error) {
        message(error.message);
      }
    };
    actions.append(start, pause, clear);
    dialog.append(
      header,
      note,
      drop,
      common,
      summary,
      feedback,
      list,
      actions,
      el(
        "p",
        "請保持此頁開啟。網路中斷或重新整理後，待傳原檔保留在此瀏覽器；再次開啟批次上傳，按「繼續／重試」即可。每個檔案開始上傳後，其資料會固定；成功項目不會重傳。",
        "upload-note",
      ),
    );
    document.body.append(dialog);
    addEventListener("beforeunload", (event) => {
      if (running) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  }
  async function open() {
    init();
    if (dialog.open) return;
    try {
      const current = ui().getCatalog();
      if (!current?.cloud) return;
      const changed = libraryId !== current.instanceId;
      libraryId = current.instanceId;
      if (changed) {
        await database();
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear();
        rows.clear();
        list.replaceChildren();
        items = (await all("items"))
          .filter((i) => i.libraryId === libraryId)
          .sort((a, b) => a.addedAt - b.addedAt);
        batch = (await all("batches")).find(
          (b) => b.libraryId === libraryId,
        ) || {
          libraryId,
          id: crypto.randomUUID(),
          startedAt: Date.now(),
          name: "",
          fields: {},
        };
        batchName.value = batch.name;
        for (const [key, input] of Object.entries(commonFields))
          input.value = batch.fields[key] || "";
        for (const item of items) {
          if (["uploading", "verifying"].includes(item.state))
            item.state = "queued";
          renderItem(item);
        }
      }
      counts();
      message("");
      dialog.showModal();
    } catch (error) {
      ui().toast(error.message);
      libraryId = null;
    }
  }
  async function run() {
    if (running || adding) return;
    running = true;
    pausing = false;
    message("");
    try {
      batch = {
        ...batch,
        name: batchName.value,
        fields: Object.fromEntries(
          Object.entries(commonFields).map(([k, v]) => [k, v.value]),
        ),
      };
      await store("batches", batch);
      counts();
      for (const item of items) renderItem(item);
      for (const item of items.filter((i) => i.state !== "done")) {
        if (pausing) break;
        try {
          if (!item.spec) {
            const hash = await transfer().digest(await item.file.arrayBuffer()),
              fields = item.custom ? item.fields : batch.fields;
            const metadata = {
              workspaceId: "website",
              workspaceName: "網站手動上傳",
              taskId: batch.id,
              batchId: batch.id,
              batch: new Date(batch.startedAt).toISOString(),
              batchLabel:
                batch.name ||
                "手動上傳 · " + new Date(batch.startedAt).toLocaleString(),
              filename: item.filename,
              relative: item.filename,
              index: items.indexOf(item) + 1,
              startedAt: batch.startedAt,
              uploadOrigin: "website",
              ...fields,
            };
            let preview;
            if (item.mime === "image/gif" || item.mime.startsWith("video/")) {
              const poster = await transfer().preview(item.file, item.mime);
              preview = poster.blob;
              Object.assign(metadata, {
                previewHash: await transfer().digest(
                  await preview.arrayBuffer(),
                ),
                mediaWidth: poster.width,
                mediaHeight: poster.height,
              });
            }
            await update(item, {
              preview,
              spec: {
                id: await transfer().digest(
                  new TextEncoder().encode("website:" + item.id),
                ),
                hash,
                bytes: item.file.size,
                mime: item.mime,
                kind: item.mime.startsWith("video/") ? "video" : "image",
                metadata,
              },
            });
          }
          let last;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await update(item, { state: "uploading", error: "" });
              await transfer().transfer(
                item,
                (patch) => update(item, patch),
                (progress) => {
                  rowProgress(item, progress);
                },
              );
              last = null;
              break;
            } catch (error) {
              last = error;
              if (
                error.status === 401 ||
                (error.status &&
                  error.status < 500 &&
                  ![408, 409, 429].includes(error.status)) ||
                attempt === 2 ||
                pausing
              )
                break;
              await new Promise((resolve) =>
                setTimeout(resolve, (attempt + 1) * 1500),
              );
            }
          }
          if (last) throw last;
          await update(item, {
            state: "done",
            file: null,
            preview: null,
            upload: null,
            error: "",
          });
          URL.revokeObjectURL(urls.get(item.id));
          urls.delete(item.id);
          void ui()
            .refresh(true)
            .catch(() => {});
        } catch (error) {
          await update(item, { state: "failed", error: error.message });
          if (error.status === 401) {
            message(
              "圖庫授權已失效。請使用最新專用連結開啟，再繼續未完成檔案。",
            );
            pausing = true;
          }
        }
        counts();
      }
    } catch (error) {
      message(error.message);
    } finally {
      running = false;
      for (const item of items) renderItem(item);
      counts();
      if (!pausing)
        message(
          items.every((i) => i.state === "done")
            ? "本批次全部核對完成，已加入圖庫。"
            : "本批次處理結束；未完成項目已保留，可再次按繼續／重試。",
        );
    }
  }
  function rowProgress(item, progress) {
    const row = rows.get(item.id);
    if (!row) return;
    row._parts.progress.value = progress;
    if (progress === 1) {
      row._parts.status.textContent = "原檔已傳送，正在核對與建立預覽…";
    }
  }
  init();
})();
