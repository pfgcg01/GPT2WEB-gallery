(() => {
  const $ = (id) => document.getElementById(id);
  let cursor = 0,
    selected = null,
    listBusy = false,
    detailEpoch = 0,
    listSignature = "",
    detailSignature = "",
    loaded = 0,
    dialogEpoch = 0;
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function safeURL(value) {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
        ? url.href
        : null;
    } catch {
      return null;
    }
  }
  function inline(root, text) {
    let offset = 0;
    for (const match of text.matchAll(
      /`[^`\n]{1,4000}`|\*\*[^*\n]{1,4000}\*\*|\[[^\]\n]{1,500}\]\([^\)\n]{1,2048}\)/gu,
    )) {
      root.append(document.createTextNode(text.slice(offset, match.index)));
      const token = match[0];
      let node;
      if (token.startsWith("`")) node = el("code", token.slice(1, -1));
      else if (token.startsWith("**")) node = el("strong", token.slice(2, -2));
      else {
        const end = token.indexOf("]("),
          url = safeURL(token.slice(end + 2, -1));
        node = url
          ? el("a", token.slice(1, end))
          : document.createTextNode(token);
        if (url) {
          node.href = url;
          node.target = "_blank";
          node.rel = "noopener noreferrer";
        }
      }
      root.append(node);
      offset = match.index + token.length;
    }
    root.append(document.createTextNode(text.slice(offset)));
  }
  // Build only inert DOM nodes. Model HTML and code remain literal text.
  function reportBody(text) {
    const root = el("article"),
      lines = String(text || "")
        .replace(/\r\n?/gu, "\n")
        .split("\n");
    root.className = "research-body";
    let paragraph = [],
      list;
    const flush = () => {
      if (paragraph.length) {
        const p = el("p");
        inline(p, paragraph.join("\n"));
        root.append(p);
        paragraph = [];
      }
    };
    const cells = (line) =>
      line
        .trim()
        .replace(/^\||\|$/gu, "")
        .split("|")
        .map((s) => s.trim());
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i],
        heading = line.match(/^(#{1,6})\s+(.+)$/u),
        item = line.match(/^\s*(?:([-*+])|\d+[.)])\s+(.+)$/u);
      if (/^\s*(```|~~~)/u.test(line)) {
        flush();
        list = null;
        const fence = line.trim().slice(0, 3),
          code = [];
        while (++i < lines.length && !lines[i].trim().startsWith(fence))
          code.push(lines[i]);
        const pre = el("pre");
        pre.append(el("code", code.join("\n")));
        root.append(pre);
        continue;
      }
      if (!line.trim()) {
        flush();
        list = null;
        continue;
      }
      if (heading) {
        flush();
        list = null;
        const h = el("h" + Math.min(heading[1].length + 1, 6));
        inline(h, heading[2]);
        root.append(h);
        continue;
      }
      if (
        line.includes("|") &&
        /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(
          lines[i + 1] || "",
        )
      ) {
        flush();
        list = null;
        const table = el("table"),
          thead = el("thead"),
          tbody = el("tbody");
        const row = (value, tag) => {
          const tr = el("tr");
          for (const cell of cells(value)) {
            const td = el(tag);
            inline(td, cell);
            tr.append(td);
          }
          return tr;
        };
        thead.append(row(line, "th"));
        i++;
        while (
          i + 1 < lines.length &&
          lines[i + 1].includes("|") &&
          lines[i + 1].trim()
        )
          tbody.append(row(lines[++i], "td"));
        table.append(thead, tbody);
        const scroll = el("div");
        scroll.className = "research-table";
        scroll.tabIndex = 0;
        scroll.setAttribute("role", "region");
        scroll.setAttribute("aria-label", "報告表格，可橫向捲動");
        scroll.append(table);
        root.append(scroll);
        continue;
      }
      if (item) {
        flush();
        const tag = item[1] ? "ul" : "ol";
        if (list?.localName !== tag) {
          list = el(tag);
          root.append(list);
        }
        const li = el("li");
        inline(li, item[2]);
        list.append(li);
        continue;
      }
      list = null;
      paragraph.push(line);
    }
    flush();
    return root;
  }
  function sources(items = []) {
    const list = el("ul"),
      seen = new Set();
    for (const source of items) {
      const url = safeURL(source.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const li = el("li"),
        a = el("a", source.title || url);
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      li.append(a);
      list.append(li);
    }
    return list;
  }
  const statusName = (task) =>
    task.status === "completed"
      ? "已完成"
      : task.status === "cancelled"
        ? "已停止"
        : "進行中／部分完成";
  function highlight() {
    for (const button of $("cloud-task-list").querySelectorAll("button"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.taskId === selected),
      );
  }
  async function api(route, value) {
    const response = await (globalThis.GPT2WEBGalleryTransport?.fetch || fetch)(
      route,
      {
        method: value === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers:
          value === undefined
            ? {}
            : { "Content-Type": "application/json", "X-GPT2WEB-Gallery": "1" },
        body: value === undefined ? undefined : JSON.stringify(value),
        signal: AbortSignal.timeout(25000),
      },
    );
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "雲端操作暫未完成。");
    return result;
  }
  const fail = (error) => {
    $("cloud-message").textContent = error.message;
  };
  $("cloud-pair-code").onclick = async () => {
    try {
      const value = await api("/api/devices/pair-code", {});
      $("cloud-pair-json").value = JSON.stringify(value);
      $("cloud-pair-json").hidden = false;
      $("cloud-pair-copy").hidden = false;
      $("cloud-message").textContent =
        "十分鐘內貼入外掛的「雲端同步 → 配對與同步紀錄」。配對後授權此裝置上傳；不會提供 Supabase 管理金鑰。";
    } catch (error) {
      fail(error);
    }
  };
  $("cloud-pair-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("cloud-pair-json").value);
      $("cloud-message").textContent = "已複製配對資料。";
    } catch {
      $("cloud-pair-json").focus();
      $("cloud-pair-json").select();
      $("cloud-message").textContent = "請複製選取的配對資料。";
    }
  };
  async function devices() {
    try {
      const result = await api("/api/devices");
      $("cloud-devices").replaceChildren();
      for (const device of result.devices) {
        const li = el("li"),
          name = el(
            "span",
            device.name + (device.revoked_at ? " · 已撤銷" : " · 已配對"),
          );
        li.append(name);
        if (!device.revoked_at) {
          const button = el("button", "撤銷");
          button.className = "secondary";
          button.onclick = async () => {
            if (
              !confirm(
                "撤銷此裝置的上傳授權？本機待傳資料保留，這個裝置之後將無法同步。",
              )
            )
              return;
            try {
              await api("/api/devices/revoke", { id: device.id });
              await devices();
            } catch (error) {
              fail(error);
            }
          };
          li.append(button);
        }
        $("cloud-devices").append(li);
      }
    } catch (error) {
      fail(error);
    }
  }
  $("cloud-load-devices").onclick = devices;
  async function leases() {
    try {
      const result = await api("/api/leases");
      $("cloud-leases").replaceChildren();
      for (const lease of result.leases) {
        const li = el(
            "li",
            `${lease.workspace_name} · ${lease.gpt2web_devices?.name || "已配對裝置"}`,
          ),
          expired = Date.parse(lease.expires_at) < Date.now();
        li.append(el("span", expired ? " · 已離線／待確認" : " · 執行中"));
        if (expired) {
          const button = el("button", "確認原任務後解除");
          button.className = "secondary";
          button.onclick = async () => {
            if (
              !confirm(
                "請確認原裝置已停止此任務，並查看 ChatGPT 中最後要求的結果。解除後，舊任務不可再送出。確定解除？",
              )
            )
              return;
            try {
              await api("/api/leases/clear", { id: lease.id });
              await leases();
            } catch (error) {
              fail(error);
            }
          };
          li.append(button);
        }
        $("cloud-leases").append(li);
      }
      if (!result.leases.length)
        $("cloud-leases").append(el("li", "目前沒有對話被占用。"));
    } catch (error) {
      fail(error);
    }
  }
  $("cloud-load-leases").onclick = leases;
  async function list(reset = false, quiet = false) {
    if (listBusy) return;
    listBusy = true;
    const epoch = dialogEpoch;
    $("cloud-tasks-more").disabled = true;
    try {
      const result = await api(
        "/api/text/tasks?cursor=" + (reset ? 0 : cursor),
      );
      if (epoch !== dialogEpoch || !$("cloud-reports").open) return;
      const signature = JSON.stringify(result.tasks);
      if (!reset || !quiet || signature !== listSignature) {
        if (reset) $("cloud-task-list").replaceChildren();
        for (const task of result.tasks) {
          if (
            [...$("cloud-task-list").children].some(
              (node) => node.dataset.taskId === task.id,
            )
          )
            continue;
          const button = el("button");
          button.type = "button";
          button.dataset.taskId = task.id;
          button.className = "secondary cloud-task-button";
          button.append(
            el("strong", task.topic),
            el(
              "span",
              `${statusName(task)} · ${task.index || 0} 階段 · ${task.workspaceName || "文字工作區"}`,
            ),
          );
          if (task.updated_at)
            button.append(
              el("small", new Date(task.updated_at).toLocaleString("zh-TW")),
            );
          button.onclick = () => detail(task.id);
          $("cloud-task-list").append(button);
        }
        if (reset && !result.tasks.length)
          $("cloud-task-list").append(
            el(
              "p",
              "還沒有同步的研究資料。請先配對外掛，完成一個文字階段，並確認待傳已送出。",
            ),
          );
      }
      if (reset) listSignature = signature;
      loaded = $("cloud-task-list").querySelectorAll("button").length;
      cursor = result.nextCursor;
      $("cloud-tasks-more").hidden = cursor === null;
      highlight();
      $("cloud-report-status").textContent =
        `已載入 ${loaded} 份研究 · 更新於 ${new Date().toLocaleTimeString("zh-TW")}`;
      if (!selected && result.tasks.length) await detail(result.tasks[0].id);
    } catch (error) {
      if (epoch === dialogEpoch)
        $("cloud-report-status").textContent =
          "暫時無法更新，已載入的內容保留。" + error.message;
    } finally {
      if (epoch === dialogEpoch) {
        listBusy = false;
        $("cloud-tasks-more").disabled = false;
      }
    }
  }
  async function detail(id, quiet = false) {
    if (quiet && selected !== id) return;
    const sequence = ++detailEpoch;
    if (selected !== id) {
      detailSignature = "";
      $("cloud-task-detail").replaceChildren(el("p", "正在載入報告…"));
    }
    selected = id;
    highlight();
    try {
      const task = await api("/api/text/tasks/" + encodeURIComponent(id));
      if (sequence !== detailEpoch || !$("cloud-reports").open) return;
      const signature = JSON.stringify(task);
      if (signature === detailSignature) return;
      detailSignature = signature;
      const root = $("cloud-task-detail");
      const open = new Set(
        [...root.querySelectorAll("details[open][data-stage]")].map(
          (node) => node.dataset.stage,
        ),
      );
      root.replaceChildren(el("h3", task.topic), el("p", task.goal));
      root.append(
        el(
          "p",
          `${statusName(task)} · 已同步 ${task.results?.length || 0}／${task.steps?.length || task.index || 0} 階段`,
        ),
      );
      const downloads = el("div");
      downloads.className = "research-downloads";
      for (const file of task.files || []) {
        if (!/^[a-f0-9]{64}$/u.test(file.id)) continue;
        const format = /\.(html|md|txt)$/iu
          .exec(file.name || "")?.[1]
          .toLowerCase();
        const a = el(
          "a",
          "下載 " +
            ({ html: "HTML", md: "Markdown", txt: "TXT" }[format] || "") +
            " 報告",
        );
        const route = "/api/images/" + file.id + "/original?download=1";
        a.className = "secondary";
        a.rel = "noopener noreferrer";
        if (globalThis.GPT2WEBGalleryTransport)
          GPT2WEBGalleryTransport.download(a, route);
        else a.href = route;
        downloads.append(a);
      }
      root.append(downloads);
      const results = task.results || [],
        latest = results.at(-1);
      if (latest) {
        root.append(
          el(
            "h4",
            task.status === "completed"
              ? "最終研究報告"
              : "最近完成階段：" + latest.title,
          ),
          reportBody(latest.reply.text),
        );
        const sourceList = sources(
          results.flatMap((result) => result.reply.sources || []),
        );
        if (sourceList.children.length) {
          const references = el("details");
          references.className = "research-sources";
          references.dataset.stage = "sources";
          references.open = open.has("sources");
          references.append(
            el("summary", `來源連結（${sourceList.children.length}）`),
            sourceList,
          );
          root.append(references);
        }
      } else
        root.append(
          el(
            "p",
            task.files?.length
              ? "原階段正文未隨檔案保存，請下載報告查看。"
              : "尚未收到完整階段，外掛同步後會顯示在這裡。",
          ),
        );
      if (task.status === "completed" && !task.files?.length)
        root.append(
          el(
            "p",
            "正文已同步；下載檔尚未到達。請等外掛完成上傳，網站會自動更新。",
          ),
        );
      if (results.length) root.append(el("h4", "研究過程與原始文字"));
      for (const [index, result] of results.entries()) {
        const item = el("details"),
          pre = el("pre", result.reply.text);
        item.className = "research-stage";
        item.dataset.stage = String(index);
        item.open = open.has(String(index));
        pre.className = "cloud-report-text";
        item.append(
          el("summary", result.title),
          pre,
          sources(result.reply.sources),
        );
        root.append(item);
      }
      if (task.partialReply) {
        const item = el("details"),
          pre = el("pre", task.partialReply.text);
        pre.className = "cloud-report-text";
        item.dataset.stage = "partial";
        item.open = open.has("partial");
        item.append(el("summary", "尚未完成的部分文字"), pre);
        root.append(item);
      }
    } catch (error) {
      if (sequence === detailEpoch && $("cloud-reports").open) {
        $("cloud-report-status").textContent =
          "報告暫時無法更新。" + error.message;
        if (!quiet)
          $("cloud-task-detail").replaceChildren(
            el("p", "載入失敗，請按重新整理再試。"),
          );
      }
    }
  }
  async function refresh(quiet = false) {
    const current = selected;
    if (!quiet || loaded <= 20) await list(true, quiet);
    if (current && selected === current && $("cloud-reports").open)
      await detail(current, true);
  }
  $("cloud-show-text").onclick = () => {
    dialogEpoch++;
    selected = null;
    detailEpoch++;
    listBusy = false;
    listSignature = "";
    detailSignature = "";
    loaded = 0;
    cursor = 0;
    $("cloud-task-list").replaceChildren();
    $("cloud-task-detail").replaceChildren(el("p", "正在載入最近研究…"));
    $("cloud-reports").showModal();
    void refresh();
  };
  $("cloud-reports").addEventListener("close", () => {
    dialogEpoch++;
    detailEpoch++;
    listBusy = false;
  });
  $("cloud-tasks-more").onclick = () => list();
  $("cloud-reports-refresh").onclick = () => refresh();
  setInterval(() => {
    if ($("cloud-reports").open && !document.hidden) void refresh(true);
  }, 30000);
})();
