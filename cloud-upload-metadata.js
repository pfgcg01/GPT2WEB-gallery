/* Parse optional TXT/MD/JSON sidecars for numbered batch uploads. */
(() => {
  const text = (value, max = 8000) =>
    String(value ?? "")
      .replace(/\u0000/g, "")
      .trim()
      .slice(0, max);
  const normalize = (value) =>
    String(value ?? "")
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .toLocaleLowerCase();
  const basename = (value) => normalize(value).split("/").at(-1) || "";
  const stem = (value) => basename(value).replace(/\.[^.]+$/u, "");
  const numberKey = (value) => {
    const match = stem(value).match(/^(\d{1,4})(?:[-_ .].*)?$/u);
    return match ? String(Number(match[1])) : "";
  };
  const sourceOf = (value) => {
    const path = String(value ?? "")
      .trim()
      .replaceAll("\\", "/")
      .split("/");
    return path.length > 1
      ? providerHint(path.at(-2) + ".txt") || path[0].trim()
      : "";
  };
  const field = (line) => {
    const match = line.match(
      /^\s*(?:[-*]\s*)?(模型|model|來源|source|服務商|provider|提示詞|prompt|備註|notes?)\s*[:：]\s*(.*)$/iu,
    );
    if (!match) return null;
    const names = {
      模型: "model",
      model: "model",
      來源: "source",
      source: "source",
      服務商: "source",
      provider: "source",
      提示詞: "prompt",
      prompt: "prompt",
      備註: "notes",
      note: "notes",
      notes: "notes",
    };
    return {
      name: names[match[1].toLocaleLowerCase()] || names[match[1]],
      value: match[2],
    };
  };
  const reference = (value) => {
    let raw = text(value, 400)
      .replace(/^[-*]\s*/u, "")
      .trim();
    raw = raw.replace(/^\[(.+)\]$/u, "$1").trim();
    const file = raw.match(
      /(?:^|\s)([^\s]+\.(?:png|jpe?g|webp|gif|mp4|webm|wav|mp3|fbx|glb|gltf))$/iu,
    );
    if (file) return { key: normalize(file[1]), filename: file[1] };
    const number = raw.match(/^(\d{1,4})(?:[-_ .]+(.+))?$/u);
    if (!number) return null;
    const suffix = text(number[2], 120).replace(/^[-_ .]+/u, "");
    const model =
      suffix && !/\b(?:prompt|提示詞|模型|model)\b/iu.test(suffix)
        ? suffix
        : "";
    return { key: String(Number(number[1])), model };
  };
  function normalizeEntry(value, fallbackKey = "") {
    if (!value || typeof value !== "object") return null;
    const data = {
        ...value,
        ...(value.fields && typeof value.fields === "object"
          ? value.fields
          : {}),
      },
      file =
        data.filename || data.file || data.path || data.name || fallbackKey;
    const ref = reference(String(file));
    const key = ref?.key || normalize(file) || normalize(fallbackKey);
    if (!key) return null;
    return {
      key,
      filename: text(data.filename || data.file || data.path || "", 200),
      source: text(data.source, 500),
      model: text(data.model, 120),
      prompt: text(data.prompt || data.提示詞, 8000),
      notes: text(data.notes, 2000),
    };
  }
  function parseJson(raw, name) {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return { entries: [], warnings: [`${name}：JSON 格式無法解析`] };
    }
    if (!value || typeof value !== "object")
      return {
        entries: [],
        warnings: [`${name}：JSON 需要檔案對照表或陣列。`],
      };
    const rows = Array.isArray(value)
      ? value.map((item) => ["", item])
      : Array.isArray(value.files)
        ? value.files.map((item) => ["", item])
        : Object.entries(value);
    const entries = rows
      .map(([key, item]) => normalizeEntry(item, key))
      .filter(Boolean);
    return {
      entries,
      warnings: entries.length ? [] : [`${name}：沒有找到檔案對照資料`],
    };
  }
  function providerHint(name) {
    let value = String(name || "")
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      .replace(/\.[^.]+$/u, "");
    if (!/^\d{1,4}[.]\d{1,2}[-_]/u.test(value)) return "";
    return value
      .replace(/^\d{1,4}[.]\d{1,2}[-_]/u, "")
      .replace(/[_ -](?:紀錄|記錄|记录|record|metadata)$/iu, "")
      .replace(/_\d+$/u, "")
      .trim();
  }
  function parseText(raw, name) {
    const lines = String(raw || "")
      .replace(/^\uFEFF/u, "")
      .replace(/\r\n?/gu, "\n")
      .split("\n");
    const records = new Map(),
      warnings = [];
    let current = null,
      mode = "";
    const defaultSource = providerHint(name);
    const save = () => {
      if (!current) return;
      for (const ref of current.refs) {
        const entry = {
          key: ref.key,
          filename: ref.filename || "",
          source: text(current.source || defaultSource, 500),
          model: text(current.model || ref.model, 120),
          prompt: text(current.prompt),
          notes: text(current.notes, 2000),
        };
        if (!entry.model && !entry.prompt && !entry.notes && !entry.source)
          continue;
        const key = normalize(entry.source) + "|" + entry.key;
        const old = records.get(key);
        const conflicts =
          old &&
          ["model", "prompt", "notes"].some(
            (k) => old[k] && entry[k] && old[k] !== entry[k],
          );
        if (conflicts) {
          warnings.push(
            `${name}：編號 ${entry.key} 有不同的模型或 Prompt，請檢查後自行調整。`,
          );
          records.set(key + "#" + records.size, entry);
        } else
          records.set(
            key,
            old
              ? Object.fromEntries(
                  Object.keys(entry).map((k) => [k, entry[k] || old[k]]),
                )
              : entry,
          );
      }
      current = null;
      mode = "";
    };
    const start = (value) => {
      const range = value.match(
        /^(\d{1,4})\s*(?:~|～|–|—|-|至|到)\s*(\d{1,4})(?:\s*(?:共用\s*)?(?:Prompt|提示詞)[^:：]*)?[:：]?\s*$/iu,
      );
      let refs;
      if (range) {
        const first = Number(range[1]),
          last = Number(range[2]);
        if (last < first || last - first > 999) {
          warnings.push(`${name}：編號範圍 ${value} 無效。`);
          return false;
        }
        refs = Array.from({ length: last - first + 1 }, (_, i) => ({
          key: String(first + i),
          model: "",
        }));
      } else {
        const ref = reference(value);
        if (!ref) return false;
        refs = [ref];
      }
      save();
      current = { refs, source: "", model: "", prompt: "", notes: "" };
      mode = "prompt";
      return true;
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[-*_]{3,}$/u.test(trimmed)) {
        save();
        continue;
      }
      const heading = trimmed.match(/^#{1,6}\s*(?:\[(.+)\]|(.+))\s*$/u);
      if (heading && start(heading[1] || heading[2])) continue;
      const bracket = trimmed.match(/^\[(.+)\]$/u);
      if (bracket && start(bracket[1])) continue;
      const explicit = trimmed.match(
        /^(?:檔名|filename|file|檔案)\s*[:：]\s*(.+)$/iu,
      );
      if (explicit && start(explicit[1])) continue;
      if (
        /^(?:\d{1,4}(?:\s*(?:~|～|–|—|-|至|到)\s*\d{1,4})(?:\s*(?:共用\s*)?(?:Prompt|提示詞)[^:：]*)?[:：]?|\d{1,4}(?:[ ._-]+[A-Za-z][A-Za-z0-9_./+()-]*(?: [A-Za-z0-9_./+()-]+)*)?[:：]?)$/iu.test(
          trimmed,
        ) &&
        start(trimmed.replace(/[:：]$/u, ""))
      )
        continue;
      const tagged = field(line);
      if (tagged) {
        if (!current) continue;
        mode = tagged.name;
        current[mode] = tagged.value;
        continue;
      }
      if (!current) continue;
      if (mode === "prompt" || mode === "notes")
        current[mode] += (current[mode] ? "\n" : "") + line;
    }
    save();
    const entries = [...records.values()];
    if (!entries.length)
      warnings.push(`${name}：沒有找到可套用的編號或檔名區段。`);
    return { entries, warnings };
  }
  function parse(raw, name = "metadata") {
    const value = String(raw || "");
    return /\.json$/iu.test(name) || /^\s*(?:\{|\[\s*(?:\{|\]))/u.test(value)
      ? parseJson(value, name)
      : parseText(value, name);
  }
  function match(entry, item) {
    const path = normalize(item.relativePath || item.filename);
    const file = basename(path);
    const source = normalize(item.source || sourceOf(path));
    const candidates = [normalize(entry.key), normalize(entry.filename)].filter(
      Boolean,
    );
    const exact = candidates.some(
      (key) => key === path || key === file || basename(key) === file,
    );
    const numeric = candidates.some(
      (key) => key === numberKey(file) || key === numberKey(path),
    );
    if (!exact && !numeric) return false;
    if (entry.source && source && normalize(entry.source) !== source)
      return false;
    return true;
  }
  globalThis.GPT2WEBUploadMetadata = {
    parse,
    match,
    sourceOf,
    numberKey,
    providerHint,
  };
})();
