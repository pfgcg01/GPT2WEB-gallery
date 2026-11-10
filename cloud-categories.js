/* Subject folders are independent of favorite/archive state. */
(() => {
  const $ = (id) => document.getElementById(id),
    el = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    },
    ui = () => globalThis.GPT2WEBGalleryUI;
  let catalog,
    chosen = "",
    onlySuggested = false,
    initialized = false,
    selection = [],
    editingIds = [],
    editingVersions = {},
    editSnapshot = null,
    lastCategories = "",
    busy = false;
  const roots = () => catalog.categories.filter((c) => !c.parent_id),
    children = (id) => catalog.categories.filter((c) => c.parent_id === id),
    find = (id) => catalog.categories.find((c) => c.id === id);
  const path = (id) => {
    const c = find(id);
    return c
      ? (c.parent_id ? find(c.parent_id)?.name + " → " : "") + c.name
      : "未分類";
  };
  function choose(id) {
    chosen = id;
    ui().filterChanged();
  }
  function init() {
    if (initialized) return;
    initialized = true;
    const section = el("section", undefined, "subject-browser");
    section.id = "subject-browser";
    section.setAttribute("aria-label", "主題分類");
    const heading = el("div", undefined, "subject-heading"),
      copy = el("div");
    copy.append(
      el("p", "依主題整理", "eyebrow"),
      el("h2", "先選一個主題，再慢慢挑。"),
    );
    const manage = el("button", "管理分類", "secondary");
    manage.id = "manage-categories";
    manage.onclick = () => {
      $("category-manage").showModal();
      renderManage(true);
    };
    heading.append(copy, manage);
    const nav = el("div", undefined, "subject-tabs");
    nav.id = "subject-tabs";
    nav.setAttribute("role", "group");
    nav.setAttribute("aria-label", "主分類");
    const sub = el("div", undefined, "subject-subtabs");
    sub.id = "subject-subtabs";
    sub.setAttribute("role", "group");
    sub.setAttribute("aria-label", "子分類");
    const hint = el("div", undefined, "subject-hint"),
      label = el("label"),
      check = el("input");
    check.type = "checkbox";
    check.id = "only-suggested";
    check.onchange = () => {
      onlySuggested = check.checked;
      ui().filterChanged();
    };
    label.append(check, document.createTextNode("只看尚未確認的預分類"));
    hint.append(label, el("span", "預分類可隨時調整；收藏和封存分開保留。"));
    section.append(heading, nav, sub, hint);
    document.querySelector(".workspace-header").after(section);
    const bulk = el("button", "調整分類");
    bulk.id = "bulk-categorize";
    bulk.onclick = () => openPicker(ui().getSelection());
    document.querySelector(".bulk-actions").prepend(bulk);
    const filters = [
      ...document.querySelectorAll(
        ".workspace > .filters:not([data-media-filter])",
      ),
    ];
    if (filters.length) {
      const details = el("details", undefined, "source-filters");
      details.append(el("summary", "來源與進階篩選（批次、輪次、裝置）"));
      filters[0].before(details);
      for (const f of filters) details.append(f);
      const search = $("search").closest("label");
      details.before(search);
      search.classList.add("subject-search");
    }
    const picker = el("dialog", undefined, "category-dialog");
    picker.id = "category-picker";
    picker.setAttribute("aria-labelledby", "category-picker-title");
    picker.innerHTML =
      '<header class="dialog-heading"><div><p class="eyebrow">ORGANIZE IMAGES</p><h2 id="category-picker-title">調整圖片分類</h2></div><button type="button" class="icon-button" aria-label="關閉分類視窗">×</button></header><form id="category-picker-form"><p id="category-picker-count"></p><label>主分類<select id="assign-root"></select></label><label id="assign-child-label">子分類<select id="assign-child"></select></label><p class="category-note">儲存後會標示為已確認；原圖、喜歡與封存狀態不受影響。</p><div class="settings-actions"><button class="primary" id="save-category" type="submit">儲存分類</button><button class="secondary" id="cancel-category" type="button">取消</button></div></form>';
    picker.querySelector('[aria-label="關閉分類視窗"]').onclick = () =>
      picker.close();
    picker.querySelector("#cancel-category").onclick = () => picker.close();
    picker.querySelector("#assign-root").onchange = () => pickerChildren();
    picker.querySelector("form").onsubmit = (event) => {
      event.preventDefault();
      if (busy) return;
      const c = $("assign-child").value || $("assign-root").value;
      ui().perform({
        kind: "category",
        action: "assign",
        requestId: crypto.randomUUID(),
        ids: editingIds,
        categoryId: c || null,
        expected: editingVersions,
      });
    };
    document.body.append(picker);
    const manager = el("dialog", undefined, "category-dialog");
    manager.id = "category-manage";
    manager.setAttribute("aria-labelledby", "category-manage-title");
    manager.innerHTML =
      '<header class="dialog-heading"><div><p class="eyebrow">YOUR CATEGORIES</p><h2 id="category-manage-title">管理主題分類</h2></div><button type="button" class="icon-button" aria-label="關閉分類管理">×</button></header><section><h3>新增分類</h3><form id="category-create-form"><label>放在哪裡<select id="new-category-parent"></select></label><label>分類名稱<input id="new-category-name" maxlength="40" required autocomplete="off"></label><button type="submit" class="primary">新增分類</button></form></section><section><h3>更名或移除</h3><form id="category-edit-form"><label>選擇分類<select id="edit-category"></select></label><label>新名稱<input id="edit-category-name" maxlength="40" required autocomplete="off"></label><div class="settings-actions"><button type="submit" class="secondary">儲存名稱</button><button type="button" class="secondary" id="delete-category">移除分類</button></div></form><p class="category-note">移除分類時，該分類與子分類的圖片會回到「未分類」，不刪除圖片。</p></section>';
    manager.querySelector('[aria-label="關閉分類管理"]').onclick = () =>
      manager.close();
    manager.querySelector("#edit-category").onchange = () => {
      const current = find($("edit-category").value);
      editSnapshot = current ? { ...current } : null;
      $("edit-category-name").value =
        find($("edit-category").value)?.name || "";
    };
    manager.querySelector("#category-create-form").onsubmit = (e) => {
      e.preventDefault();
      if (busy) return;
      ui().perform({
        kind: "category-manage",
        action: "create",
        requestId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        parentId: $("new-category-parent").value || null,
        name: $("new-category-name").value.trim(),
      });
    };
    manager.querySelector("#category-edit-form").onsubmit = (e) => {
      e.preventDefault();
      const c = find($("edit-category").value);
      if (!c || busy) return;
      ui().perform({
        kind: "category-manage",
        action: "rename",
        requestId: crypto.randomUUID(),
        id: c.id,
        name: $("edit-category-name").value.trim(),
        expectedVersion: Number(
          editSnapshot?.id === c.id ? editSnapshot.version : c.version,
        ),
      });
    };
    manager.querySelector("#delete-category").onclick = () => {
      const c = find($("edit-category").value);
      if (
        !c ||
        busy ||
        !confirm(
          "移除「" +
            path(c.id) +
            "」及其子分類？圖片會回到未分類，原圖與收藏狀態會保留。",
        )
      )
        return;
      ui().perform({
        kind: "category-manage",
        action: "delete",
        requestId: crypto.randomUUID(),
        id: c.id,
        expectedVersion: Number(
          editSnapshot?.id === c.id ? editSnapshot.version : c.version,
        ),
      });
    };
    document.body.append(manager);
    for (const d of [picker, manager]) {
      d.addEventListener("close", () => {
        if ($("toast").parentElement === d) document.body.append($("toast"));
      });
      d.addEventListener("click", (e) => {
        if (e.target === d) {
          const r = d.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            d.close();
        }
      });
    }
  }
  function renderManage(force = false) {
    const selected = $("edit-category").value,
      parent = $("new-category-parent").value,
      typedName = $("edit-category-name").value;
    $("new-category-parent").replaceChildren(
      new Option("新增為主分類", ""),
      ...roots().map((c) => new Option(c.name, c.id)),
    );
    $("new-category-parent").value = parent;
    const options = [];
    for (const root of roots()) {
      options.push(new Option(root.name, root.id));
      for (const c of children(root.id))
        options.push(new Option("　↳ " + c.name, c.id));
    }
    $("edit-category").replaceChildren(...options);
    if (find(selected)) $("edit-category").value = selected;
    const current = find($("edit-category").value);
    if (!force && $("category-manage").open && editSnapshot?.id === current?.id)
      $("edit-category-name").value = typedName;
    else {
      editSnapshot = current ? { ...current } : null;
      $("edit-category-name").value = current?.name || "";
    }
  }
  function pickerChildren(selected = "") {
    const root = $("assign-root").value,
      items = children(root);
    $("assign-child").replaceChildren(
      new Option("只放在主分類", ""),
      ...items.map((c) => new Option(c.name, c.id)),
    );
    $("assign-child").value = items.some((c) => c.id === selected)
      ? selected
      : "";
    $("assign-child-label").hidden = !items.length;
  }
  function openPicker(ids) {
    if (!ids.length || busy) return;
    editingIds = ids;
    editingVersions = Object.fromEntries(
      ids.map((id) => [
        id,
        catalog.images.find((i) => i.id === id)?.categoryVersion,
      ]),
    );
    const a = catalog.images.find((i) => i.id === ids[0]),
      same = ids.every(
        (id) =>
          catalog.images.find((i) => i.id === id)?.categoryId === a?.categoryId,
      ),
      c = same ? find(a?.categoryId) : null;
    $("assign-root").replaceChildren(
      new Option("未分類", ""),
      ...roots().map((c) => new Option(c.name, c.id)),
    );
    $("assign-root").value = c?.parent_id || c?.id || "";
    pickerChildren(c?.parent_id ? c.id : "");
    $("category-picker-count").textContent =
      "將調整 " +
      ids.length +
      " 張圖片" +
      (!same ? "，目前分屬不同分類。" : "。");
    $("category-picker").showModal();
  }
  const addon = {
    query(params) {
      if (chosen) params.set("category", chosen);
      if (onlySuggested) params.set("categorySource", "suggested");
    },
    button(image) {
      const button = el("button", "分類", "review-button category-button");
      button.type = "button";
      button.setAttribute(
        "aria-label",
        "調整分類 " + image.sources[0].filename,
      );
      button.title = "調整主題分類";
      button.onclick = () => openPicker([image.id]);
      return button;
    },
    badge(image) {
      const b = el("p", path(image.categoryId), "image-category");
      if (image.categorySource === "suggested") {
        b.append(el("span", "預分類", "category-suggested"));
      }
      b.title = path(image.categoryId);
      return b;
    },
    saved(operation) {
      if (operation.kind === "category") $("category-picker").close();
      if (operation.kind === "category-manage") {
        $("new-category-name").value = "";
        lastCategories = "";
        renderManage(true);
      }
    },
    render(data, context) {
      if (!data.cloud || !Array.isArray(data.categories)) return;
      catalog = data;
      busy = context.busy;
      selection = context.selected;
      init();
      if (chosen && chosen !== "uncategorized" && !find(chosen)) {
        chosen = "";
        queueMicrotask(() => ui().filterChanged());
      }
      const signature = JSON.stringify([
        catalog.categories,
        catalog.uncategorizedCount,
        chosen,
      ]);
      if (signature !== lastCategories) {
        lastCategories = signature;
        const nav = $("subject-tabs");
        nav.replaceChildren();
        for (const c of [
          { id: "", name: "全部主題", count: catalog.total },
          ...roots(),
          {
            id: "uncategorized",
            name: "未分類",
            count: catalog.uncategorizedCount || 0,
          },
        ]) {
          const b = el("button", undefined, "subject-tab");
          b.type = "button";
          b.dataset.category = c.id;
          const current = chosen === c.id || find(chosen)?.parent_id === c.id;
          b.setAttribute("aria-pressed", String(current));
          b.append(el("span", c.name), el("b", String(c.count || 0)));
          b.onclick = () => choose(c.id);
          nav.append(b);
        }
        const parent = find(chosen)?.parent_id || chosen,
          sub = $("subject-subtabs");
        sub.replaceChildren();
        const list = children(parent);
        if (list.length) {
          for (const c of [
            { id: parent, name: "全部", count: find(parent)?.count },
            ...list,
          ]) {
            const b = el(
              "button",
              c.name + " · " + (c.count || 0),
              "subject-subtab",
            );
            b.type = "button";
            b.setAttribute("aria-pressed", String(chosen === c.id));
            b.dataset.category = c.id;
            b.onclick = () => choose(c.id);
            sub.append(b);
          }
        }
        sub.hidden = !list.length;
        renderManage();
      }
      for (const b of document.querySelectorAll(
        ".category-button,#bulk-categorize,#save-category,#category-manage button[type=submit],#delete-category",
      ))
        b.disabled = busy;
      const current = find(chosen);
      if (current) {
        $("view-title").textContent = path(chosen);
        $("view-description").textContent =
          "在這個主題中查看" +
          ({
            pending: "待篩選",
            favorite: "喜歡的",
            archived: "已封存",
            all: "所有",
          }[
            document.querySelector("#views [aria-current=page]")?.dataset.view
          ] || "所有") +
          "圖片。";
      }
      $("only-suggested").checked = onlySuggested;
    },
  };
  globalThis.GPT2WEBCategoryUI = addon;
})();
