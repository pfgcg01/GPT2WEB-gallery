/* Minimal native Git pack. Compression runs on the user's device, never Worker. */
(() => {
  const text = new TextEncoder();
  const hex = (bytes) =>
    [...new Uint8Array(bytes)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const unhex = (value) =>
    Uint8Array.from(value.match(/../gu), (v) => parseInt(v, 16));
  async function objectSha(type, bytes) {
    const all = new Blob([text.encode(`${type} ${bytes.length}\0`), bytes]);
    return hex(await crypto.subtle.digest("SHA-1", await all.arrayBuffer()));
  }
  async function metadata(gitSha) {
    if (!/^[a-f0-9]{40}$/u.test(gitSha)) throw Error("Git blob 指紋不正確。");
    const tree = new Uint8Array(
      await new Blob([
        text.encode("100644 data\0"),
        unhex(gitSha),
      ]).arrayBuffer(),
    );
    const treeSha = await objectSha("tree", tree);
    const commit = text.encode(
      `tree ${treeSha}\nauthor GPT2WEB <upload@gpt2web.invalid> 1704067200 +0000\ncommitter GPT2WEB <upload@gpt2web.invalid> 1704067200 +0000\n\nGPT2WEB media upload ${gitSha}\n`,
    );
    return {
      tree,
      treeSha,
      commit,
      commitSha: await objectSha("commit", commit),
      ref: `refs/heads/gpt2web-upload-${gitSha}`,
    };
  }
  function header(type, size) {
    const bytes = [];
    let first = (type << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) {
      bytes.push(first | 128);
      first = size & 127;
      size = Math.floor(size / 128);
    }
    bytes.push(first);
    return Uint8Array.from(bytes);
  }
  async function encode(blob, gitSha) {
    if (typeof CompressionStream !== "function")
      throw Error("此瀏覽器不支援大檔 Git 傳輸，請更新 Firefox 或 Chrome。");
    const info = await metadata(gitSha),
      parts = [Uint8Array.from([80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, 3])];
    for (const [type, data] of [
      [3, blob],
      [2, new Blob([info.tree])],
      [1, new Blob([info.commit])],
    ]) {
      parts.push(
        header(type, data.size),
        await new Response(
          data.stream().pipeThrough(new CompressionStream("deflate")),
        ).blob(),
      );
    }
    const pack = new Blob(parts),
      checksum = await crypto.subtle.digest("SHA-1", await pack.arrayBuffer());
    return new Blob([pack, checksum], {
      type: "application/x-git-packed-objects",
    });
  }
  globalThis.GPT2WEBGitPack = Object.freeze({ metadata, encode, objectSha });
})();
