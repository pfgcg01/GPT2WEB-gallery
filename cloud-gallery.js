(() => {
  const $ = (id) => document.getElementById(id);
  let cursor = 0;
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
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
  async function list(reset = false) {
    if (reset) {
      cursor = 0;
      $("cloud-task-list").replaceChildren();
    }
    try {
      const result = await api("/api/text/tasks?cursor=" + cursor);
      for (const task of result.tasks) {
        const button = el(
          "button",
          `${task.topic} · ${task.workspaceName || "文字工作區"} · ${task.status === "completed" ? "已完成" : task.status === "cancelled" ? "已停止" : "進行中／部分完成"} · ${task.index || 0} 階段`,
        );
        button.className = "secondary cloud-task-button";
        button.onclick = () => detail(task.id);
        $("cloud-task-list").append(button);
      }
      cursor = result.nextCursor;
      $("cloud-tasks-more").hidden = cursor === null;
      if (reset && !result.tasks.length)
        $("cloud-task-list").append(el("p", "還沒有同步完成的文字階段。"));
    } catch (error) {
      $("cloud-task-list").append(el("p", error.message));
    }
  }
  async function detail(id) {
    try {
      const task = await api("/api/text/tasks/" + encodeURIComponent(id));
      $("cloud-task-detail").replaceChildren(
        el("h3", task.topic),
        el("p", task.goal),
      );
      for (const result of task.results || []) {
        const item = el("details"),
          summary = el("summary", result.title),
          pre = el("pre", result.reply.text);
        pre.className = "cloud-report-text";
        item.append(summary, pre);
        for (const source of result.reply.sources || []) {
          let url;
          try {
            url = new URL(source.url);
          } catch {
            continue;
          }
          if (!["http:", "https:"].includes(url.protocol)) continue;
          const a = el("a", source.title || url.href);
          a.href = url.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          item.append(a, el("br"));
        }
        $("cloud-task-detail").append(item);
      }
      if (task.partialReply) {
        const item = el("details"),
          pre = el("pre", task.partialReply.text);
        pre.className = "cloud-report-text";
        item.append(el("summary", "中斷時保存的部分文字"), pre);
        $("cloud-task-detail").append(item);
      }
      for (const file of task.files || []) {
        const a = el("a", "下載 " + file.name);
        a.href = "/api/images/" + file.id + "/original?download=1";
        a.className = "secondary";
        a.download = "";
        $("cloud-task-detail").append(a);
      }
    } catch (error) {
      $("cloud-task-detail").textContent = error.message;
    }
  }
  $("cloud-show-text").onclick = () => {
    $("cloud-reports").showModal();
    void list(true);
  };
  $("cloud-tasks-more").onclick = () => list();
})();
