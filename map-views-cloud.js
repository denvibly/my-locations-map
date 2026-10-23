window.mapViewsCloud = (() => {
  const onlineUrl = 'https://my-locations-map-sync.denvibly.chatgpt.site';
  const embedded = new URLSearchParams(location.search).get('cloud') === '1' && window.parent !== window;
  const standalone = location.origin === 'https://denvibly.github.io' && window.parent === window;
  const required = standalone || embedded || document.querySelector('meta[name="map-cloud-enabled"]')?.content === 'true';
  const storageKey = 'locations-map-saved-views-v1';
  const protocol = 'locations-map-cloud-v1';
  const pending = new Map();
  let bridgeChannel = '';
  try {bridgeChannel=sessionStorage.getItem(storageKey+'-channel') || '';} catch {}
  let user = null, endpoint = embedded ? window.parent : null, bridgeFrame = null, accountWindow = null, bridgeReady = false;
  let started = false, migrationChecked = false, legacyLibrary = null, legacyRaw = null;
  function sendPending() {
    if (!bridgeReady || !endpoint) return;
    for (const [id,operation] of pending) {
      if (operation.sent) continue;
      operation.sent = true;
      operation.source = endpoint;
      endpoint.postMessage({protocol,id,body:operation.body},onlineUrl);
    }
  }
  function disconnect() {
    bridgeReady = false;
    user = null;
    for (const operation of pending.values()) {
      clearTimeout(operation.timeout);
      operation.reject(Object.assign(new Error('Cloud connection unavailable'),{status:401}));
    }
    pending.clear();
    window.dispatchEvent(new Event('map-cloud-disconnected'));
  }
  window.addEventListener('message', event => {
    if (event.origin !== onlineUrl || !event.source || event.data?.protocol !== protocol) return;
    if (standalone && event.data.type==='bridge-ready' && bridgeChannel && event.data.channel===bridgeChannel && event.source!==window) accountWindow=event.source;
    const trusted = embedded ? event.source === window.parent : standalone && (event.source === bridgeFrame?.contentWindow || event.source === accountWindow);
    if (!trusted) return;
    if (event.data.type === 'bridge-ready') {
      if (standalone && event.source===accountWindow && event.data.channel!==bridgeChannel) return;
      if (standalone && bridgeReady && endpoint===bridgeFrame?.contentWindow && event.source===accountWindow) return;
      const changed = !bridgeReady;
      endpoint = event.source;
      bridgeReady = true;
      sendPending();
      if (changed && standalone && event.source===accountWindow && bridgeFrame) bridgeFrame.src=onlineUrl+'/bridge';
      if (changed) window.dispatchEvent(new Event('map-cloud-connected'));
      return;
    }
    const operation = pending.get(event.data.id);
    if (!operation || event.source !== operation.source) return;
    pending.delete(event.data.id);
    clearTimeout(operation.timeout);
    if (event.data.error) {
      operation.reject(Object.assign(new Error('Cloud request failed'),{status:event.data.status}));
      if (event.data.status === 401) disconnect();
    } else operation.resolve(event.data.result);
  });
  async function request(body) {
    if (standalone || embedded) return new Promise((resolve,reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {pending.delete(id);reject(new Error('Cloud connection timed out'));},25000);
      const operation = {resolve,reject,timeout,body,sent:false,source:null};
      pending.set(id,operation);
      if (bridgeReady) sendPending();
      else (embedded ? window.parent : bridgeFrame?.contentWindow)?.postMessage({protocol,type:'bridge-hello'},onlineUrl);
    });
    const response = await fetch('/api/map-views', {
      method:body ? 'POST' : 'GET',
      credentials:'same-origin',
      cache:'no-store',
      ...(body ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {}),
      signal:AbortSignal.timeout(20000)
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw Object.assign(new Error('Cloud request failed'),{status:response.status});
    return response.json();
  }
  async function migrateLegacy(saved) {
    if (migrationChecked || !standalone) return saved;
    if (!legacyLibrary?.views?.length) {migrationChecked=true;return saved;}
    let activeId = '';
    for (const view of legacyLibrary.views) {
      if (!view || typeof view.id !== 'string' || typeof view.name !== 'string' || !view.state || typeof view.state !== 'object') throw new Error('Invalid legacy view');
      const signature = JSON.stringify([view.name,view.state]);
      const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(view.id+signature));
      const id = 'migrated-'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
      const match = saved.views.find(item=>item.id===id || JSON.stringify([item.name,item.state])===signature);
      if (!match) {
        try {await request({operation:'upsert',expectedVersion:0,view:{id,name:view.name,state:view.state}});}
        catch (error) {if(error.status!==409)throw error;}
      }
      if (view.id === legacyLibrary.activeId) activeId = match?.id || id;
    }
    if (!saved.activeId && activeId) await request({operation:'select',activeId});
    migrationChecked = true;
    try {localStorage.setItem(storageKey+'-connected',legacyRaw);} catch {}
    return request();
  }
  async function load() {
    const response = await request();
    if (response.version !== 1 || !Array.isArray(response.views)) throw new Error('Invalid cloud data');
    const saved = await migrateLegacy(response);
    user = saved.user;
    return {version:1,activeId:saved.views.some(view=>view.id===saved.activeId)?saved.activeId:'',views:saved.views};
  }
  async function save(previous,next) {
    for (const view of next.views) {
      const before = previous.views.find(item=>item.id===view.id);
      if (!before || before.name!==view.name || JSON.stringify(before.state)!==JSON.stringify(view.state)) {
        await request({operation:'upsert',expectedVersion:before ? view.version ?? before.version ?? 0 : 0,view:{id:view.id,name:view.name,state:view.state}});
      }
    }
    for (const view of previous.views) {
      if (!next.views.some(item=>item.id===view.id)) await request({operation:'delete',id:view.id,expectedVersion:next.deletedVersions?.[view.id] ?? view.version ?? 0});
    }
    if (next.activeId !== previous.activeId || !previous.views.length) await request({operation:'select',activeId:next.activeId});
    return load();
  }
  function connect(signOut = false) {
    if (!standalone) return false;
    if (signOut) disconnect();
    bridgeChannel=crypto.randomUUID();
    try {sessionStorage.setItem(storageKey+'-channel',bridgeChannel);} catch {}
    const path='/bridge?channel='+encodeURIComponent(bridgeChannel);
    accountWindow = window.open(onlineUrl+(signOut ? '/signout-with-chatgpt?return_to='+encodeURIComponent(path) : path),'locations-map-account','popup,width=540,height=620');
    return !!accountWindow;
  }
  function transferLegacy() {
    const destination = window.opener;
    const panel = document.createElement('p');
    panel.textContent = 'Подключаю виды из этого браузера. После переноса окно закроется.';
    panel.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#f5faf9;margin:0;padding:40px;font:18px system-ui';
    document.body.appendChild(panel);
    window.addEventListener('message',event => {
      if (event.origin!==onlineUrl || event.source!==destination || event.data?.protocol!==protocol) return;
      if (event.data.type==='migration-request' || event.data.type==='migration-target-ready') {
        let library;
        try {library=JSON.parse(localStorage.getItem(storageKey));} catch {}
        destination.postMessage({protocol,type:'migration-data',library:library || {version:1,views:[]}},onlineUrl);
      }
      if (event.data.type==='migration-complete') {window.close();panel.textContent='Готово. Можно закрыть это окно.';}
      if (event.data.type==='migration-error') panel.textContent='Не удалось подключить виды. Исходные сохранения не удалены.';
    });
    destination?.postMessage({protocol,type:'migration-source-ready'},onlineUrl);
    return true;
  }
  function start() {
    if (!standalone || started) return false;
    started = true;
    if (new URLSearchParams(location.search).get('transfer') === '1') return transferLegacy();
    try {
      const raw = localStorage.getItem(storageKey);
      const saved = JSON.parse(raw);
      if (saved?.version===1 && Array.isArray(saved.views) && raw!==localStorage.getItem(storageKey+'-connected')) {
        legacyLibrary=saved;
        legacyRaw=raw;
      }
    } catch {}
    bridgeFrame = document.createElement('iframe');
    bridgeFrame.src = onlineUrl+'/bridge';
    bridgeFrame.title = 'Подключение сохранённых видов';
    bridgeFrame.hidden = true;
    bridgeFrame.referrerPolicy = 'origin';
    document.body.appendChild(bridgeFrame);
    return false;
  }
  if (standalone || embedded) setInterval(() => {
    if (accountWindow?.closed) {
      const wasEndpoint = endpoint === accountWindow;
      accountWindow = null;
      if (wasEndpoint) {disconnect();if(bridgeFrame)bridgeFrame.src=onlineUrl+'/bridge';}
    }
    if (!bridgeReady && pending.size) (embedded ? window.parent : bridgeFrame?.contentWindow)?.postMessage({protocol,type:'bridge-hello'},onlineUrl);
  },1000);
  return {required,standalone,onlineUrl,load,save,start,connect,get user(){return user}};
})();
