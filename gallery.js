(() => {
  const $ = id => document.getElementById(id), labels = { pending: '待篩選', favorite: '喜歡的', archived: '已封存', all: '所有圖片' };
  const idPattern = /^[a-f0-9]{64}$/;
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16));
  let catalog, view = 'pending', page = 1, selected = new Set(), viewerId, zoomed = false, busy = false, refreshing = false, offline = false, undoChanges, toastTimer;
  let pendingKey = new URLSearchParams(location.hash.slice(1)).get('access'), pendingOperation, lastGrid = '', lastOptions = '', lastCompare = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const icon = name => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS(svg.namespaceURI, 'use'); svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true'); use.setAttribute('href', '#ic-' + name); svg.append(use); return svg; };
  const bytes = n => n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  const asset = id => catalog?.images.find(image => image.id === id);
  const transport=globalThis.GPT2WEBGalleryTransport;
  const setImage=(el,route)=>{if(transport)transport.image(el,route);else el.src=route;};
  function toast(message, changes) { clearTimeout(toastTimer); const dialog=[...document.querySelectorAll('dialog[open]')].at(-1);(dialog||document.body).append($('toast'));$('toast-message').textContent = message; $('toast').hidden = false; undoChanges = changes?.length ? changes : null; $('undo').hidden = !undoChanges; toastTimer = setTimeout(() => { $('toast').hidden = true; }, undoChanges ? 25000 : 8000); }
  async function api(route, value) {
    let response;
    try { response = await (transport?.fetch||fetch)(route, { method: value === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: value === undefined ? {} : { 'Content-Type': 'application/json', 'X-GPT2WEB-Gallery': '1' }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(20000) }); }
    catch { throw Object.assign(new Error('暫時連不上圖庫，正在保留目前畫面與未確認操作。'), { network: true }); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { if (response.status === 401 && route !== '/api/access') gate('此裝置的存取已失效，請使用最新專用連結開啟。'); throw Object.assign(new Error(result.error || '圖庫暫時無法處理，請稍後再試。'), { status: response.status }); }
    return result;
  }
  function gate(message, retry = false) { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); $('app').hidden = true; $('gate').hidden = false; $('gate-message').textContent = message; $('gate-retry').hidden = !retry; }
  function connection(connected, message) { offline = !connected; $('connection').dataset.state = connected ? 'connected' : 'offline'; $('connection').textContent = connected ? '已連接' : '重新連接中'; $('offline').hidden = connected && !pendingOperation; $('offline').textContent = message || (pendingOperation ? '上次變更尚未確認，重新連接後會核對同一筆操作。' : '暫時失去連線，已載入的圖片會保留，稍後自動重連。'); }
  const pendingStorageKey = () => 'gpt2web-gallery-pending-' + catalog?.instanceId;
  function savePending(value) { pendingOperation = value; try { if (value) localStorage.setItem(pendingStorageKey(), JSON.stringify(value)); else localStorage.removeItem(pendingStorageKey()); } catch { /* The server's idempotency receipt still prevents replay. */ } }
  function loadPending() { try { const saved = JSON.parse(localStorage.getItem(pendingStorageKey())); if (saved?.requestId && (Array.isArray(saved.ids) || Array.isArray(saved.restore))) pendingOperation = saved; } catch { /* Ignore a damaged local receipt. */ } }
  function baseFilter(image) {
    const query = $('search').value.trim().toLocaleLowerCase(), batch = $('batch').value, round = $('round').value;
    return image.sources.some(source => (!batch || source.batch === batch) && (!round || String(source.round) === round) &&
      (!query || `${source.filename} ${source.batchLabel} ${source.relative} 第 ${source.round || ''} 輪`.toLocaleLowerCase().includes(query)));
  }
  function images() {
    if(catalog?.paged)return catalog.images;
    const list = (catalog?.images || []).filter(image => (view === 'all' || image.status === view) && baseFilter(image));
    const sort = $('sort').value;
    return list.sort((a, b) => {
      if (sort === 'new') return b.addedAt - a.addedAt || a.id.localeCompare(b.id);
      if (sort === 'name') return a.sources[0].filename.localeCompare(b.sources[0].filename, undefined, { numeric: true });
      return b.sources[0].batch.localeCompare(a.sources[0].batch) || (b.sources[0].round || 0) - (a.sources[0].round || 0) || a.sources[0].filename.localeCompare(b.sources[0].filename, undefined, { numeric: true });
    });
  }
  function reviewButton(image, status, compact = false) {
    const button = node('button', 'review-button'); button.type = 'button'; button.dataset.status = status;
    button.setAttribute('aria-pressed', String(image.status === status)); button.setAttribute('aria-label', `${status === 'favorite' ? image.status === status ? '取消收藏' : '收藏' : status === 'archived' ? image.status === status ? '還原到待篩選' : '封存' : '回到待篩選'} ${image.sources[0].filename}`);
    button.title = status === 'favorite' ? '喜歡 · F' : status === 'archived' ? '封存／還原 · A' : '待篩選 · U';
    button.append(icon(status === 'favorite' ? 'heart' : status === 'archived' ? 'archive' : 'inbox'));
    if (!(compact && status === 'pending')) button.append(node('span', '', status === 'favorite' ? '喜歡' : status === 'archived' ? '封存' : '待篩選'));
    button.disabled = busy || !!pendingOperation;
    button.onclick = () => review([image.id], image.status === status && status !== 'pending' ? 'pending' : status); return button;
  }
  function actions(image, compact = false) { const row = node('div', compact ? 'card-actions' : 'review-actions'); for (const status of ['favorite', 'archived', 'pending']) row.append(reviewButton(image, status, compact)); return row; }
  function card(image) {
    const source = image.sources[0], article = node('article', 'image-card' + (selected.has(image.id) ? ' is-selected' : '')); article.dataset.id = image.id;
    const checkLabel = node('label', 'card-select'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(image.id); checkbox.setAttribute('aria-label', '選取 ' + source.filename);
    checkbox.onchange = () => { if (checkbox.checked && selected.size >= 500) { checkbox.checked = false; return toast('一次最多選取 500 張，請分批整理。'); } if (checkbox.checked) selected.add(image.id); else selected.delete(image.id); article.classList.toggle('is-selected', checkbox.checked); renderSelection(); };
    checkLabel.append(checkbox); article.append(checkLabel);
    const media = node('button', 'image-media'); media.type = 'button'; media.setAttribute('aria-label', '放大檢視 ' + source.filename);
    const imageEl = node('img'); setImage(imageEl,`/api/images/${image.id}/thumb`); imageEl.alt = source.filename; imageEl.loading = 'lazy'; imageEl.decoding = 'async'; imageEl.width = 640; imageEl.height = 640;
    const loading=node('span','thumb-loading','載入縮圖…');let retries=0;
    imageEl.onload=()=>{loading.remove();media.querySelector('.missing-thumb')?.remove();};
    imageEl.onerror = () => { loading.remove();if (!media.querySelector('.missing-thumb')) media.append(node('span', 'missing-thumb', '縮圖暫時無法載入'));
      if(retries<3){const delay=[1500,4000,10000][retries++];setTimeout(()=>{if(imageEl.isConnected&&!$('app').hidden)setImage(imageEl,`/api/images/${image.id}/thumb?retry=${retries}`);},delay);}};
    media.append(imageEl,loading); media.onclick = () => openViewer(image.id); article.append(media);
    if (image.status !== 'pending') { const tag = node('span', 'card-tag', image.status === 'favorite' ? '♥ 已收藏' : '已封存'); tag.dataset.state = image.status; article.append(tag); }
    const details = node('div', 'card-body'); details.append(node('p', 'card-batch', source.batchLabel + (source.round ? ' · 第 ' + source.round + ' 輪' : '')),
      node('h2', 'card-title', source.filename), node('p', 'card-detail', `${image.width} × ${image.height} · ${bytes(image.bytes)}${image.sources.length > 1 ? ' · ' + image.sources.length + ' 個來源' : ''}`));
    article.append(details, actions(image, true)); return article;
  }
  function renderSelection() {
    const list = images(); $('bulk').hidden = !selected.size; $('selected-count').textContent = `已選 ${selected.size} 張`;
    $('select-all').checked = !!list.length && list.every(image => selected.has(image.id)); $('select-all').indeterminate = selected.size > 0 && !$('select-all').checked;
    $('compare-selected').disabled = selected.size < 2 || selected.size > 4;
    for (const id of ['bulk-favorite', 'bulk-archive', 'bulk-pending']) $(id).disabled = busy || !!pendingOperation;
  }
  function renderScan(scan) {
    $('scan').disabled = scan.running || busy;
    if(scan.cloud){$('scan').textContent='更新圖庫';$('scan-status').textContent='僅顯示已核對上傳的成果';return;}
    $('scan-status').textContent = scan.error ? '掃描未完成：' + scan.error : scan.running ? `正在收錄 · 已檢查 ${scan.seen} 個檔案` :
      scan.issues ? `${scan.issues} 個檔案暫未收錄，會在下次掃描重試` : '自動收錄已開啟';
  }
  function render() {
    if (!catalog) return;
    for (const status of ['pending', 'favorite', 'archived']) $('count-' + status).textContent = catalog.counts[status]; $('count-all').textContent = catalog.total;
    for (const button of $('views').querySelectorAll('button')) { if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); }
    $('view-title').textContent = { pending: '先看看，慢慢挑。', favorite: '喜歡的，都留在這裡。', archived: '先收好，隨時再看。', all: '每一次生成，都在這裡。' }[view];
    $('view-description').textContent = { pending: '喜歡的留下，其他的先收好。點開圖片，就能用鍵盤快速篩選。', favorite: '把值得留下的圖片集中起來，隨時比較、匯出。', archived: '暫時不選的圖片，仍能放大查看或還原。', all: '依批次與輪次回顧作品，找出下一張喜歡的圖片。' }[view];
    const roundOptions=catalog.rounds||[...new Set(catalog.images.flatMap(i=>i.sources.map(s=>s.round)).filter(Boolean))].sort((a,b)=>a-b);
    const optionKey = JSON.stringify([catalog.batches, roundOptions,catalog.devices,catalog.workspaces]);
    if (optionKey !== lastOptions) {
      lastOptions = optionKey; const batch = $('batch').value, round = $('round').value;
      $('batch').replaceChildren(new Option('所有批次', '')); for (const b of catalog.batches) $('batch').append(new Option(b.label, b.id));
      $('round').replaceChildren(new Option('所有輪次', '')); for (const n of roundOptions) $('round').append(new Option('第 ' + n + ' 輪', String(n)));
      for(const [id,values,label] of [['device',(catalog.devices||[]),'所有裝置'],['workspace',(catalog.workspaces||[]).map(w=>({id:w.name,label:w.name})),'所有工作區']])if($(id)){const chosen=$(id).value;$(id).replaceChildren(new Option(label,''),...values.map(v=>new Option(v.label,v.id)));$(id).value=values.some(v=>v.id===chosen)?chosen:'';}
      if (catalog.batches.some(b=>b.id===batch)) $('batch').value = batch; if ([...$('round').options].some(o=>o.value===round)) $('round').value = round;
    }
    const list = images(), shown = list.slice(0, page * 60), signature = JSON.stringify([shown.map(i=>[i.id,i.status,i.reviewVersion,i.sources]),busy,!!pendingOperation]);
    if (signature !== lastGrid) {
      lastGrid=signature;const old=new Map([...$('grid').children].map(el=>[el.dataset.id,el])),keep=new Set();let cursor=$('grid').firstChild;
      for(const image of shown){const key=JSON.stringify([image.status,image.reviewVersion,image.sources]);let el=old.get(image.id);if(!el||el.dataset.renderKey!==key){el=card(image);el.dataset.renderKey=key;}
        el.classList.toggle('is-selected',selected.has(image.id));el.querySelector('input[type=checkbox]').checked=selected.has(image.id);
        for(const button of el.querySelectorAll('.review-button'))button.disabled=busy||!!pendingOperation;
        if(el!==cursor)$('grid').insertBefore(el,cursor);cursor=el.nextSibling;keep.add(el);}
      for(const el of [...$('grid').children])if(!keep.has(el))el.remove();
    }
    $('result-count').textContent = `${labels[view]} ${catalog.filteredCount??list.length} 張${catalog.paged?' · 已載入 '+list.length+' 張':''}${$('batch').value || $('round').value || $('search').value ? ' · 已套用篩選' : ''}`;
    $('empty').hidden = !!list.length; $('empty-title').textContent = catalog.total === 0 ? catalog.scan.running ? '正在整理第一批圖片。' : '等一張新作品。' : view === 'favorite' ? '從一張喜歡的開始。' : view === 'archived' ? '封存區，暫時空著。' : '這一組已經看完了。';
    $('empty-description').textContent = catalog.total === 0 ? catalog.cloud?'先到圖庫設定取得配對資料，貼入 Firefox 外掛。生成後請等外掛顯示雲端已核對，圖片才會出現在這裡。':'將圖片保存到 IMG-save，網站就會自動收錄。' : '試試切換批次、清除搜尋，或到其他分類看看。';
    $('load-more').hidden = catalog.paged?catalog.nextCursor===null:list.length <= shown.length; $('load-more').textContent = `載入更多 · 還有 ${catalog.paged?catalog.filteredCount-list.length:list.length - shown.length} 張`;
    $('export-favorites').disabled = catalog.paged?view!=='favorite'||!catalog.images.length:!catalog.images.some(i=>i.status==='favorite'&&baseFilter(i));
    if(catalog.paged)$('export-favorites').title='切到「喜歡的」後，匯出目前已載入的收藏。更多圖片請先載入下一頁。';
    $('library-info').textContent = `共 ${catalog.total} 張圖片 · ${catalog.sourceCount} 個來源檔案`;
    renderSelection(); renderScan(catalog.scan); updateViewer(); updateCompare();
  }
  function query(){const p=new URLSearchParams({paged:'1',status:view,sort:$('sort').value});for(const id of ['batch','round','search','device','workspace'])if($(id)?.value)p.set(id,$(id).value);return p;}
  let loadedQuery='',loadingMore=false,filterTimer;
  function refresh(full = false) {
    if (refreshing) return full ? refreshing.catch(()=>{}).then(()=>refresh(true)) : refreshing;
    const task = (async()=>{ try {
      const params=query(),requested=params.toString();if(!full&&catalog&&loadedQuery===requested){params.set('revision',catalog.revision);params.set('instance',catalog.instanceId);}
      const response = await api('/api/catalog?'+params);
      if(requested!==query().toString())return;
      // Refresh only the pages already read, keeping later-page selections and
      // the open viewer stable when another device uploads a new image.
      if(!response.unchanged&&response.paged&&loadedQuery===requested&&catalog?.paged){
        const wanted=catalog.images.length,seen=new Set();
        while(response.images.length<wanted&&response.nextCursor!==null){
          if(seen.has(response.nextCursor))throw Error('圖庫分頁重複，請重新整理。');
          seen.add(response.nextCursor);const more=query();more.set('cursor',response.nextCursor);more.set('snapshot',response.revision);
          const next=await api('/api/catalog?'+more);if(requested!==query().toString())return;
          if(next.revision!==response.revision)throw Object.assign(Error('圖庫正在更新，稍後重新讀取。'),{network:true});
          response.images.push(...next.images);response.nextCursor=next.nextCursor;
        }
      }
      if(!response.unchanged&&response.cloud&&!response.paged){
        const seen=new Set();while(response.nextCursor!==null&&response.nextCursor!==undefined){if(seen.has(response.nextCursor))throw Error('圖庫分頁重複，請重新整理。');seen.add(response.nextCursor);const next=await api('/api/catalog?cursor='+response.nextCursor);if(next.revision!==response.revision)throw Object.assign(Error('圖庫正在更新，稍後重新讀取。'),{network:true});response.images.push(...next.images);response.nextCursor=next.nextCursor;}
        response.batches=[...new Map(response.images.flatMap(image=>image.sources).map(source=>[source.batch,{id:source.batch,label:source.batchLabel}])).values()];response.total=response.images.length;response.sourceCount=response.images.reduce((n,image)=>n+image.sources.length,0);response.counts=Object.fromEntries(['pending','favorite','archived'].map(status=>[status,response.images.filter(image=>image.status===status).length]));
      }
      if (response.unchanged) { catalog.scan = response.scan; renderScan(response.scan); }
      else { loadedQuery=requested;catalog = response;page=response.paged?Math.max(1,Math.ceil(response.images.length/60)):1; catalog.images = catalog.images.filter(i=>idPattern.test(i.id)&&Array.isArray(i.sources)&&i.sources.length); selected = new Set([...selected].filter(id=>asset(id))); render(); }
      connection(true);
    } catch (error) { if (error.status !== 401) connection(false, error.message); throw error; }
    finally { /* The owner of the promise clears it below. */ } })();
    refreshing=task;void task.finally(()=>{if(refreshing===task)refreshing=false;}).catch(()=>{});return task;
  }
  async function perform(operation, recovered = false) {
    if (busy) return; busy = true; savePending(operation); render();
    const oldList = images(), currentIndex = oldList.findIndex(i=>i.id===viewerId), nextId = oldList[currentIndex+1]?.id || oldList[currentIndex-1]?.id;
    try {
      const result = await api('/api/reviews', operation); savePending(null);
      if (!$('compare').open) for (const change of result.changed) selected.delete(change.id);
      await refresh(true);
      if (viewerId && !images().some(i=>i.id===viewerId)) { if (nextId && images().some(i=>i.id===nextId)) viewerId = nextId; else { viewerId = null; $('viewer').close(); } }
      toast(recovered ? '已核對並保存上次變更。' : operation.restore ? '已復原剛才的變更。' : `已保存 ${result.changed.length} 張圖片的分類。`, operation.restore ? null : result.changed);
      connection(true);
    } catch (error) {
      if (!error.network && error.status!==401) savePending(null);
      if (error.network) connection(false, '變更尚未確認，重新連接後會核對同一筆操作。');
      else {toast(error.message);if(error.status===409)await refresh(true).catch(()=>{});}
    } finally { busy = false; render(); }
  }
  function review(ids, status) { if (!ids.length || busy || pendingOperation) return; return perform({ requestId: uuid(), ids, status, expected:Object.fromEntries(ids.map(id=>[id,asset(id)?.reviewVersion])) }); }
  function openViewer(id) { viewerId = id; zoomed = false; $('image-scroll').classList.remove('is-zoomed'); $('zoom').setAttribute('aria-pressed','false'); updateViewer(); if (!$('viewer').open) $('viewer').showModal(); }
  function updateViewer() {
    const image = asset(viewerId); if (!image) { if ($('viewer').open) $('viewer').close(); return; }
    const list = images(), index = list.findIndex(i=>i.id===viewerId), source = image.sources[0];
    $('viewer-title').textContent = source.filename; $('viewer-position').textContent = `${index>=0?index+1:'—'} / ${list.length} · ${labels[image.status]}`;
    $('viewer-meta').textContent = `${source.batchLabel}${source.round?' · 第 '+source.round+' 輪':''} · ${image.width} × ${image.height} · ${bytes(image.bytes)}`;
    const src = `/api/images/${image.id}/original`; if (($('viewer-image').dataset.media||$('viewer-image').getAttribute('src')) !== src) { setImage($('viewer-image'),src); $('viewer-image').alt = source.filename; $('image-scroll').scrollTo(0,0); }
    if(transport)transport.download($('viewer-download'),src+'?download=1');else $('viewer-download').href = src + '?download=1'; $('previous').disabled = index<=0; $('next').disabled = index<0||index>=list.length-1;
    $('viewer-actions').replaceChildren(...actions(image).children);
  }
  function navigate(direction) { const list = images(), index = list.findIndex(i=>i.id===viewerId), next = list[index+direction]; if (next) openViewer(next.id); }
  function updateCompare() {
    if (!$('compare').open) return;
    const list = [...selected].map(asset).filter(Boolean), key = JSON.stringify(list.map(i=>[i.id,i.status,busy,!!pendingOperation])); if (key===lastCompare) return; lastCompare=key;
    const fragment=document.createDocumentFragment();
    for (const image of list.slice(0,4)) { const item=node('article','compare-item'), img=node('img');setImage(img,`/api/images/${image.id}/original`);img.alt=image.sources[0].filename;item.append(img,node('p','',image.sources[0].filename),actions(image));fragment.append(item); }
    $('compare-grid').replaceChildren(fragment);
  }
  async function exportImages(ids) {
    if (!ids.length) return toast('先選幾張圖片，或把喜歡的加入收藏。');
    try { const result=await api('/api/exports',{ids});if(result.entries){const {saveCloudZip}=await import('./cloud-export.js');await saveCloudZip(result.entries,message=>toast(message));return;} const a=node('a');a.href=result.url;a.download='';document.body.append(a);a.click();a.remove();toast(`已準備 ${result.count} 張原檔，下載狀態請看瀏覽器。`); } catch(error){toast(error.message);}
  }
  async function copyLink(rotate=false) {
    if(rotate&&$('rotate-link').disabled)return;if(rotate)$('rotate-link').disabled=true;
    try {
      const result=await api(rotate?'/api/access/rotate':'/api/access/link',{}), link=(result.viewerUrl||transport?.viewerUrl||(result.origin||location.origin)+'/')+'#access='+result.key;
      if(rotate){$('new-link').value=link;$('new-link-area').hidden=false;if(!$('settings').open)$('settings').showModal();}
      try { await navigator.clipboard.writeText(link);toast(rotate?'已更換並複製新連結，請保存。':'已複製專用連結，可在其他裝置直接開啟。'); }
      catch { $('new-link').value=link;$('new-link-area').hidden=false;if(!$('settings').open)$('settings').showModal();$('new-link').focus();$('new-link').select();toast('請複製畫面中的專用連結。'); }
    } catch(error){toast(error.message);}finally{if(rotate)$('rotate-link').disabled=false;}
  }
  async function boot() {
    $('gate-retry').hidden=true;
    try {
      if(pendingKey){await api('/api/access',{key:pendingKey});pendingKey=null;}
      await refresh(true);$('gate').hidden=true;$('app').hidden=false;$('version').textContent='v'+catalog.version;loadPending();render();if(pendingOperation)void perform(pendingOperation,true);
    } catch(error){gate(error.status===401?'請使用完整、有效的專用連結開啟圖庫。':error.message,error.status!==401);}
  }
  const filterChanged=()=>{page=1;selected.clear();if(catalog?.paged)void refresh(true).catch(error=>toast(error.message));else render();};
  $('views').onclick=event=>{const button=event.target.closest('button[data-view]');if(button){view=button.dataset.view;filterChanged();}};
  for(const id of ['search','batch','round','sort','device','workspace'])$(id)?.addEventListener(id==='search'?'input':'change',()=>{clearTimeout(filterTimer);if(id==='search')filterTimer=setTimeout(filterChanged,250);else filterChanged();});
  $('select-all').onchange=()=>{if($('select-all').checked){const list=images();selected=new Set(list.slice(0,500).map(i=>i.id));if(list.length>500)toast('已選前 500 張，可分批整理。');}else selected.clear();lastGrid='';render();};
  $('deselect').onclick=()=>{selected.clear();lastGrid='';render();};
  $('load-more').onclick=async()=>{
    if(!catalog?.paged){page++;render();return;}if(loadingMore||catalog.nextCursor===null)return;loadingMore=true;$('load-more').disabled=true;
    const snapshot=catalog.revision,params=query(),requested=params.toString();params.set('cursor',catalog.nextCursor);params.set('snapshot',snapshot);
    try{const result=await api('/api/catalog?'+params);if(snapshot===catalog.revision&&requested===query().toString()){catalog.images.push(...result.images.filter(i=>!asset(i.id)));catalog.nextCursor=result.nextCursor;page++;render();}}
    catch(error){if(error.status===409)await refresh(true).catch(()=>{});toast(error.message);}finally{loadingMore=false;$('load-more').disabled=false;}
  };
  for(const [id,status]of[['bulk-favorite','favorite'],['bulk-archive','archived'],['bulk-pending','pending']])$(id).onclick=()=>review([...selected],status);
  $('compare-selected').onclick=()=>{if(selected.size<2||selected.size>4)return;lastCompare='';$('compare').showModal();updateCompare();};
  $('export-selected').onclick=()=>exportImages([...selected]);$('export-favorites').onclick=()=>exportImages(catalog.images.filter(i=>i.status==='favorite'&&baseFilter(i)).map(i=>i.id));
  $('scan').onclick=async()=>{try{if(!catalog?.cloud)await api('/api/scan',{});await refresh(true);toast(catalog?.cloud?'已更新雲端成果；尚未上傳的檔案請在外掛查看同步狀態。':'開始檢查新圖片，已保存的分類會保留。');}catch(error){toast(error.message);}};
  $('previous').onclick=()=>navigate(-1);$('next').onclick=()=>navigate(1);
  $('zoom').onclick=()=>{zoomed=!zoomed;$('image-scroll').classList.toggle('is-zoomed',zoomed);$('zoom').setAttribute('aria-pressed',String(zoomed));};
  $('viewer').addEventListener('close',()=>{viewerId=null;$('viewer-image').removeAttribute('src');delete $('viewer-image').dataset.media;});
  $('compare').addEventListener('close',()=>{const visible=new Set(images().map(i=>i.id));selected=new Set([...selected].filter(id=>visible.has(id)));lastGrid='';render();});
  document.addEventListener('keydown',event=>{if(!$('viewer').open||event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.target.matches('input,textarea,select,[contenteditable=true]'))return;
    if(['ArrowLeft','ArrowRight','f','a','u'].includes(event.key.toLowerCase())||['ArrowLeft','ArrowRight'].includes(event.key))event.preventDefault();
    if(event.key==='ArrowLeft')navigate(-1);if(event.key==='ArrowRight')navigate(1);const image=asset(viewerId);if(!image)return;
    const status={f:'favorite',a:'archived',u:'pending'}[event.key.toLowerCase()];if(status)review([image.id],image.status===status&&status!=='pending'?'pending':status);
  });
  document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
  for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
  for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('close',()=>{if($('toast').parentElement===dialog)document.body.append($('toast'));});
  $('undo').onclick=()=>{if(!undoChanges||busy||pendingOperation)return;void perform({requestId:uuid(),restore:undoChanges.map(c=>({id:c.id,status:c.before,expectedVersion:c.version}))});};
  $('toast-close').onclick=()=>{$('toast').hidden=true;};
  $('copy-link').onclick=()=>copyLink();$('settings-copy').onclick=()=>copyLink();$('open-settings').onclick=()=>$('settings').showModal();
  $('rotate-link').onclick=()=>{if(confirm('更換後，舊連結及其他裝置的存取會失效。現在更換並保存新連結？'))void copyLink(true);};
  $('copy-new-link').onclick=async()=>{try{await navigator.clipboard.writeText($('new-link').value);toast('已複製新連結。');}catch{$('new-link').focus();$('new-link').select();}};
  $('logout').onclick=async()=>{try{await api('/api/access/logout',{});location.reload();}catch(error){toast(error.message);}};
  $('gate-retry').onclick=boot;
  if(transport)for(const a of document.querySelectorAll('a[href="/api/backup"]'))transport.backup(a);
  addEventListener('hashchange',()=>{const key=new URLSearchParams(location.hash.slice(1)).get('access');if(key){pendingKey=key;history.replaceState(null,'',location.pathname+location.search);void boot();}});
  $('viewer-image').onerror=()=>toast('原檔暫時無法載入，可稍後重開圖片。');
  setInterval(async()=>{if($('app').hidden)return;try{await refresh();if(pendingOperation&&!busy)await perform(pendingOperation,true);}catch{/* Retry the same operation after connectivity returns. */}},5000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('app').hidden)void refresh().catch(()=>{});});
  void boot();
})();
