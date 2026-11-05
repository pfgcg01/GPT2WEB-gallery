/* Full prompt text is fetched only when requested, and rendered as plain text. */
(() => {
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  let dialog,
    list,
    message,
    more,
    imageId,
    cursor,
    snapshot,
    generation = 0,
    loading = false;
  const ui = () => globalThis.GPT2WEBGalleryUI;
  const reasons = {
    prompt_keywords: "依本輪 Prompt 關鍵字預分類",
    conversation_context: "接續文字沿用同一對話先前主題",
    no_prompt_match: "提示詞沒有明確分類關鍵字，可手動分類",
    ambiguous_prompt: "提示詞符合多種分類，請手動選擇",
    category_missing: "對應分類已移除，可手動分類",
    existing_category: "保留既有分類",
    missing_prompt: "此來源未保存 Prompt",
  };
  function init() {
    if (dialog) return;
    dialog = el("dialog", undefined, "prompt-dialog");
    dialog.id = "image-prompts";
    dialog.setAttribute("aria-labelledby", "image-prompts-title");
    const header = el("header", undefined, "dialog-heading"),
      title = el("h2", "圖片的 Prompt");
    title.id = "image-prompts-title";
    const close = el("button", "關閉", "secondary");
    close.type = "button";
    close.setAttribute("aria-label", "關閉 Prompt");
    close.onclick = () => dialog.close();
    header.append(title, close);
    const note = el(
      "p",
      "這裡保存外掛本輪實際送出的文字。相同圖片來自多個輪次時，各來源分別列出。",
      "prompt-note",
    );
    message = el("p");
    message.id = "image-prompts-status";
    message.setAttribute("role", "status");
    list = el("div");
    list.id = "image-prompts-list";
    more = el("button", "載入更多 Prompt", "secondary");
    more.id = "image-prompts-more";
    more.type = "button";
    more.hidden = true;
    more.onclick = () => load();
    dialog.append(header, note, message, list, more);
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      generation++;
      imageId = null;
      if (document.getElementById("toast")?.parentElement === dialog)
        (
          [...document.querySelectorAll("dialog[open]")].at(-1) || document.body
        ).append(document.getElementById("toast"));
    });
  }
  async function load() {
    if (loading || !imageId) return;
    loading = true;
    more.disabled = true;
    const requested = imageId,
      offset = cursor,
      ticket = generation;
    message.textContent = "正在讀取提示詞…";
    try {
      const data = await ui().api(
        "/api/images/" +
          requested +
          "/prompts?cursor=" +
          offset +
          (snapshot !== undefined ? "&snapshot=" + snapshot : ""),
      );
      if (ticket !== generation || imageId !== requested || !dialog.open)
        return;
      for (const [index, entry] of data.entries.entries()) {
        const details = el("details", undefined, "prompt-entry");
        details.open = offset === 0 && index === 0;
        const summary = el(
          "summary",
          (entry.workspaceName || "圖片來源") +
            (entry.round ? " · 第 " + entry.round + " 輪" : ""),
        );
        const batch = el("p", entry.batch || "", "prompt-note"),
          text = el("pre", entry.prompt, "prompt-text"),
          copy = el("button", "複製 Prompt", "secondary");
        copy.type = "button";
        copy.classList.add("copy-prompt");
        copy.onclick = async () => {
          try {
            await navigator.clipboard.writeText(entry.prompt);
            ui().toast("已複製 Prompt。");
          } catch {
            ui().toast("無法存取剪貼簿，請選取提示詞後複製。");
          }
        };
        const classification = entry.classification;
        const status =
          classification?.state === "error"
            ? "分類暫未完成，稍後會自動重試。"
            : classification?.state === "pending"
              ? "等待自動預分類。"
              : reasons[classification?.reason] || "";
        details.append(
          summary,
          batch,
          el("p", status, "prompt-note"),
          text,
          copy,
        );
        list.append(details);
      }
      cursor = data.nextCursor;
      snapshot = data.snapshot;
      more.hidden = cursor === null;
      message.textContent = list.children.length
        ? "已列出 " + list.children.length + " 個有保存 Prompt 的來源。"
        : "這張圖片的既有來源未保存 Prompt。更新外掛並啟用「同步圖片 Prompt」後，新產生的圖片才會附上本輪提示詞。";
    } catch (e) {
      if (ticket === generation && imageId === requested) {
        if (e.status === 409) {
          cursor = 0;
          snapshot = undefined;
          list.replaceChildren();
        }
        message.textContent = e.message;
        more.textContent = "重新讀取";
        more.hidden = false;
      }
    } finally {
      if (ticket === generation) {
        loading = false;
        more.disabled = false;
      }
    }
  }
  function open(image) {
    init();
    generation++;
    imageId = image.id;
    cursor = 0;
    snapshot = undefined;
    loading = false;
    list.replaceChildren();
    more.hidden = true;
    more.textContent = "載入更多 Prompt";
    if (!dialog.open) dialog.showModal();
    void load();
  }
  globalThis.GPT2WEBPromptUI = {
    button(image) {
      const button = el("button", "Prompt", "review-button prompt-button");
      button.type = "button";
      button.setAttribute(
        "aria-label",
        "查看 Prompt " + image.sources[0].filename,
      );
      button.onclick = () => open(image);
      return button;
    },
    preview(image) {
      const source = image.sources.find((s) => s.hasPrompt);
      return source?.promptPreview
        ? el("p", source.promptPreview, "prompt-preview")
        : null;
    },
  };
})();
