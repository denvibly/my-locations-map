window.mapViewsCloud = (() => {
  const onlineUrl = 'https://my-locations-map-sync.denvibly.chatgpt.site';
  const embedded = new URLSearchParams(location.search).get('cloud') === '1' && window.parent !== window;
  const required = embedded || document.querySelector('meta[name="map-cloud-enabled"]')?.content === 'true';
  const storageKey = 'locations-map-saved-views-v1';
  const protocol = 'locations-map-cloud-v1';
  const pending = new Map();
  let user = null;
  let bridgeReady = false;
  function sendPending() {
    for (const [id,operation] of pending) {
      if (operation.sent) continue;
      operation.sent=true;
      window.parent.postMessage({protocol,id,body:operation.body},onlineUrl);
    }
  }
  window.addEventListener('message', event => {
    if (!embedded || event.origin !== onlineUrl || event.source !== window.parent || event.data?.protocol !== protocol) return;
    if (event.data.type==='bridge-ready') {bridgeReady=true;sendPending();return;}
    const operation = pending.get(event.data.id);
    if (!operation) return;
    pending.delete(event.data.id);
    clearTimeout(operation.timeout);
    if (event.data.error) operation.reject(Object.assign(new Error('Cloud request failed'), {status:event.data.status}));
    else operation.resolve(event.data.result);
  });
  async function request(body) {
    if (embedded) return new Promise((resolve,reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {pending.delete(id);reject(new Error('Cloud connection timed out'));},25000);
      pending.set(id,{resolve,reject,timeout,body,sent:false});
      if (bridgeReady) sendPending();
      else window.parent.postMessage({protocol,type:'bridge-hello'},onlineUrl);
    });
    const response = await fetch('/api/map-views', {
      method:body ? 'POST' : 'GET',
      credentials:'same-origin',
      cache:'no-store',
      ...(body ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {}),
      signal:AbortSignal.timeout(20000)
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      const error = new Error('Cloud request failed');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  if (embedded) setInterval(() => {
    if (!bridgeReady && pending.size) window.parent.postMessage({protocol,type:'bridge-hello'},onlineUrl);
  },1000);
  async function load() {
    const saved = await request();
    if (saved.version !== 1 || !Array.isArray(saved.views)) throw new Error('Invalid cloud data');
    user = saved.user;
    return {version:1,activeId:saved.views.some(view=>view.id===saved.activeId)?saved.activeId:'',views:saved.views};
  }
  async function save(previous, next) {
    for (const view of next.views) {
      const before=previous.views.find(item=>item.id===view.id);
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
  function start() {
    if (embedded || location.origin !== 'https://denvibly.github.io' || window.parent !== window) return false;
    let library;
    try {library=JSON.parse(localStorage.getItem(storageKey));} catch {}
    const raw = JSON.stringify(library);
    const transfer = new URLSearchParams(location.search).get('transfer') === '1';
    let completed = false;
    try {completed=localStorage.getItem(storageKey+'-connected')===raw;} catch {}
    if (!transfer && (!library?.views?.length || completed)) {
      location.replace(onlineUrl+'/map');
      return true;
    }
    const panel=document.createElement('div');
    panel.style.cssText='position:fixed;inset:0;z-index:99999;background:#f5faf9;display:grid;place-content:center;padding:24px;color:#183738;font:17px/1.6 system-ui;gap:18px;text-align:center';
    const heading=document.createElement('h1');
    heading.textContent='Карта на всех ваших устройствах';
    const message=document.createElement('p');
    message.textContent='Войдите в тот же аккаунт ChatGPT. Сохранённые здесь виды перенесутся автоматически, без файлов.';
    const button=document.createElement('button');
    button.textContent='Войти и открыть мои виды';
    button.style.cssText='background:#197a73;border:0;border-radius:12px;color:white;padding:16px;cursor:pointer;font:600 17px system-ui';
    const fallback=document.createElement('a');
    fallback.textContent='Открыть онлайн-карту';
    fallback.href=onlineUrl+'/map';
    panel.append(heading,message,button,fallback);
    document.body.appendChild(panel);
    let destination=transfer ? window.opener : null;
    button.onclick=() => {
      destination=window.open(onlineUrl+'/map','locations-map-account');
      message.textContent=destination ? 'Завершите вход в открывшемся окне. Если вход уже завершён, нажмите кнопку ещё раз.' : 'Разрешите открытие окна или откройте онлайн-карту по ссылке ниже.';
    };
    const ready=() => {if(destination)destination.postMessage({protocol,type:'migration-source-ready'},onlineUrl);};
    window.addEventListener('message',event => {
      if (event.origin!==onlineUrl || event.source!==destination || event.data?.protocol!==protocol) return;
      if (event.data.type==='migration-target-ready' || event.data.type==='migration-request') {
        destination.postMessage({protocol,type:'migration-data',library:library || {version:1,views:[]}},onlineUrl);
      }
      if (event.data.type==='migration-complete') {
        try {localStorage.setItem(storageKey+'-connected',raw);} catch {}
        if (transfer) {window.close();message.textContent='Готово. Можно закрыть это окно.';}
        else {destination.close();location.replace(onlineUrl+'/map');}
      }
      if (event.data.type==='migration-error') message.textContent='Не удалось перенести виды. Оригиналы сохранены в этом браузере. Повторите вход.';
    });
    ready();
    return true;
  }
  return {required,onlineUrl,load,save,start,get user(){return user}};
})();
