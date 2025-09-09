// ==UserScript==
// @name         HawkEye Mug Likelihood (v0.2)
// @namespace    homiewrecker.hawkeye.muglikelihood
// @version      0.2.0
// @description  Predict a target's on-hand cash likelihood using public page signals + your mug history. PDA-friendly, async, cached.
// @author       Homiewrecker
// @license      MIT
// @run-at       document-end
// @match        https://www.torn.com/*
// @grant        GM_addStyle
// @grant        GM.xmlHttpRequest
// @connect      api.torn.com
// @connect      www.torn.com
// ==/UserScript==

(function(){
  'use strict';

  /* =========================
     PREFS & CONSTANTS
     ========================= */
  const PREFS_KEY = 'hawkeye_mugprefs_v2';
  const WATCH_KEY = 'hawkeye_mug_watch_v1';
  const ATTACK_CACHE_KEY = 'hawkeye_mug_attacks_cache_v2';
  const ATTACK_LAST_TS_KEY = 'hawkeye_mug_attacks_last_v2';
  const KEY_STORAGE = 'hawkeye_torn_key';

  const DEFAULT_PREFS = {
    enabled: true,
    showOnProfiles: true,
    showOnFactions: true,
    scoreAgingHalfLifeDays: 21,
    mugJuicyThreshold: 70,
    mugMaybeThreshold: 40,
    minSamplesForPersonalModel: 2,
    attacksLookbackDays: 60,
    cacheTTLhrs: 6,
    enableBazaarSignal: true,
    enableStatusSignal: true,
    enableCoopMode: false, // future: pull /signals from your bot
    chainMode: false, // manual uplift toggle
  };

  /* =========================
     STATE
     ========================= */
  const STATE = {
    prefs: loadPrefs(),
    key: localStorage.getItem(KEY_STORAGE) || '',
    attacksCache: null,
    lastFetchTs: Number(localStorage.getItem(ATTACK_LAST_TS_KEY)||0),
    models: null,
  };

  /* =========================
     UTILITIES
     ========================= */
  function loadPrefs(){ try{ return Object.assign({}, DEFAULT_PREFS, JSON.parse(localStorage.getItem(PREFS_KEY)||'{}')); }catch{ return {...DEFAULT_PREFS}; } }
  function savePrefs(p){ localStorage.setItem(PREFS_KEY, JSON.stringify(p)); }
  function now(){ return Date.now(); }
  function tctHour(ts=now()){ return new Date(ts).getUTCHours(); }
  function decayWeight(ageMs, halfLifeDays){ const half=halfLifeDays*24*3600*1000; return Math.pow(0.5, ageMs/half); }
  function log1p(x){ return Math.log(1+Math.max(0,x)); }
  function sigmoid(z){ return 1/(1+Math.exp(-z)); }
  function clamp(n, lo, hi){ return Math.min(hi, Math.max(lo,n)); }

  function gmGetJSON(url){
    return new Promise((resolve, reject)=>{
      GM.xmlHttpRequest({ method:'GET', url, headers:{'Accept':'application/json'}, onload:r=>{ try{ resolve(JSON.parse(r.responseText)); }catch(e){ reject(e); } }, onerror:reject });
    });
  }
  function gmGetText(url){
    return new Promise((resolve, reject)=>{
      GM.xmlHttpRequest({ method:'GET', url, onload:r=>resolve(r.responseText), onerror:reject });
    });
  }

  function loadJSON(k){ try{ return JSON.parse(localStorage.getItem(k)||''); }catch{ return null; } }
  function saveJSON(k,v){ localStorage.setItem(k, JSON.stringify(v)); }

  /* =========================
     ATTACK LOGS -> ROWS
     ========================= */
  function restoreCachedAttacks(){ try{ const raw=localStorage.getItem(ATTACK_CACHE_KEY); if(raw) STATE.attacksCache=JSON.parse(raw); }catch{} }
  restoreCachedAttacks();

  async function fetchMyAttacks(force=false){
    const ttl = STATE.prefs.cacheTTLhrs*3600*1000;
    if(!force && STATE.attacksCache && (now()-STATE.lastFetchTs)<ttl) return STATE.attacksCache;
    if(!STATE.key) throw new Error('Missing Torn API key. Open HawkEye settings to set it.');

    const to = Math.floor(now()/1000);
    const from = to - STATE.prefs.attacksLookbackDays*24*3600;
    const url = `https://api.torn.com/user/?selections=attacks&from=${from}&to=${to}&key=${encodeURIComponent(STATE.key)}`;

    const data = await gmGetJSON(url);
    const rows = [];
    if(data && data.attacks){
      for(const id in data.attacks){
        const a = data.attacks[id]; if(!a) continue;
        // We only want mugs YOU performed with money > 0
        if(a.result==='Mugged' && a.money && a.money>0 && a.defender_id){
          rows.push({ ts: (a.timestamp_ended||a.timestamp||a.timestamp_started)*1000, target: String(a.defender_id), money: a.money });
        }
      }
    }
    STATE.attacksCache = rows.sort((x,y)=>y.ts-x.ts);
    STATE.lastFetchTs = now();
    localStorage.setItem(ATTACK_LAST_TS_KEY, String(STATE.lastFetchTs));
    localStorage.setItem(ATTACK_CACHE_KEY, JSON.stringify(STATE.attacksCache||[]));
    return STATE.attacksCache;
  }

  /* =========================
     MODELS
     ========================= */
  function buildModels(rows){
    const byHour = Array.from({length:24}, ()=>({sum:0, wsum:0, count:0}));
    const perTarget = {};
    for(const r of rows){
      const w = decayWeight(now()-r.ts, STATE.prefs.scoreAgingHalfLifeDays);
      const h = tctHour(r.ts);
      byHour[h].sum += r.money*w; byHour[h].wsum += w; byHour[h].count++;
      if(!perTarget[r.target]) perTarget[r.target] = {sum:0, wsum:0, count:0, byHour: Array.from({length:24}, ()=>({sum:0,wsum:0,count:0}))};
      const T = perTarget[r.target];
      T.sum += r.money*w; T.wsum += w; T.count++;
      T.byHour[h].sum += r.money*w; T.byHour[h].wsum += w; T.byHour[h].count++;
    }
    return { global: byHour, perTarget };
  }

  function expectedMoneyAtHour(modelHour){ if(!modelHour || modelHour.wsum===0) return 0; return modelHour.sum/modelHour.wsum; }

  /* =========================
     SCRAPERS (profile + bazaar)
     ========================= */
  function parseLastActionToMinutes(t){
    if(!t) return 999;
    const s = t.toLowerCase();
    if(/just now/.test(s)) return 0;
    const m = s.match(/(\d+)\s*(minute|hour|day)/);
    if(!m) return 999;
    const n = parseInt(m[1],10);
    if(/minute/.test(m[2])) return Math.min(n, 360);
    if(/hour/.test(m[2]))   return Math.min(n*60, 360);
    if(/day/.test(m[2]))    return 360; // cap at 6h
    return 999;
  }

  async function scrapeProfileSignals(xid){
    const root = document;
    const lastActionEl = root.querySelector('.last-action, .last-action .desc, .user-information .last, .info-last_action, .lastAction');
    const statusEl     = root.querySelector('.status, .user-status, .basic-status, .userInformation .status');
    const donatorIcon  = root.querySelector('img[alt*="Donator"], .donator-icon, .icon-donator');
    const levelEl      = root.querySelector('.level, .user-level, .info-cont .level span, .level > span');

    const lastActionText = lastActionEl?.textContent || '';
    const mins = parseLastActionToMinutes(lastActionText);

    const statusText = (statusEl?.textContent || '').toLowerCase();
    const isHosp = /hospital/.test(statusText);
    const isTrav = /travel|abroad/.test(statusText);
    const isOnline = /online|just now/.test((lastActionText||'').toLowerCase());

    const level = parseInt(levelEl?.textContent?.replace(/\D+/g,'')||'0',10) || 0;
    const isDonator = !!donatorIcon;
    return { mins, isOnline, isHosp, isTrav, level, isDonator };
  }

  async function fetchBazaarSignals(xid){
    if(!STATE.prefs.enableBazaarSignal) return { hasBazaar:false, bazaarListValue:0 };
    const cacheKey = `hawkeye_bazaar_${xid}`;
    const cached = loadJSON(cacheKey);
    if(cached && (now()-cached.ts) < 4*3600*1000) return cached.data;

    try{
      const url = `https://www.torn.com/bazaar.php?userID=${xid}`;
      const html = await gmGetText(url);
      const hasBazaar = !/doesn[â€™']?t have a bazaar|no bazaar/i.test(html);
      let total=0;
      if(hasBazaar){
        const prices = Array.from(html.matchAll(/\$\s*([\d,]+)/g)).map(m=>parseInt(m[1].replace(/,/g,''),10));
        const filtered = prices.filter(p=>p>1000 && p<250000000);
        total = filtered.sort((a,b)=>a-b).slice(0,20).reduce((a,b)=>a+b,0);
      }
      const data={ hasBazaar, bazaarListValue: total };
      saveJSON(cacheKey,{ts:now(), data});
      return data;
    }catch{
      return { hasBazaar:false, bazaarListValue:0 };
    }
  }

  /* =========================
     FEATURE FUSION & SCORING
     ========================= */
  function hourBias(h){ const rad = (2*Math.PI*h)/24; return 0.15*Math.sin(rad - Math.PI/2); }

  function scoreWalletLikelihood(features){
    const {
      mins, isOnline, isHosp, isTrav, level, isDonator,
      hasBazaar, bazaarListValue,
      personalMeanUSD, personalSamples, globalHourMeanUSD,
      tctHour, chainWindow, watched
    } = features;

    const z =
      (-1.8) +
      (isOnline ? +0.6 : 0) +
      (isHosp   ? -1.2 : 0) +
      (isTrav   ? -0.9 : 0) +
      (Math.max(0,(360 - Math.min(mins,360)))/360) * 0.8 +
      (hasBazaar ? +0.5 : 0) +
      (log1p(bazaarListValue)/14.0) * 0.7 +
      (Math.min(level,100)/100) * 0.3 +
      (isDonator ? +0.15 : 0) +
      (log1p(personalMeanUSD)/13.0) * (personalSamples>=2 ? 1.0 : 0.3) +
      (log1p(globalHourMeanUSD)/13.0) * 0.6 +
      (chainWindow ? +0.25 : 0) +
      (watched ? +0.2 : 0) +
      hourBias(tctHour);

    return Math.round(sigmoid(z)*100);
  }

  async function computeScoreForXID(xid, models){
    const prof = STATE.prefs.enableStatusSignal ? await scrapeProfileSignals(xid) : { mins:999,isOnline:false,isHosp:false,isTrav:false,level:0,isDonator:false };
    const baz  = await fetchBazaarSignals(xid);

    const personal = models.perTarget[xid];
    const personalMean = personal && personal.wsum>0 ? personal.sum/personal.wsum : 0;
    const globalHourMean = expectedMoneyAtHour(models.global[tctHour()]);

    const features = {
      mins: prof.mins,
      isOnline: prof.isOnline,
      isHosp: prof.isHosp,
      isTrav: prof.isTrav,
      level: prof.level,
      isDonator: prof.isDonator,
      hasBazaar: baz.hasBazaar,
      bazaarListValue: baz.bazaarListValue,
      personalMeanUSD: personalMean,
      personalSamples: personal?.count || 0,
      globalHourMeanUSD: globalHourMean,
      tctHour: tctHour(),
      chainWindow: !!STATE.prefs.chainMode,
      watched: getWatch().has(xid),
    };
    return scoreWalletLikelihood(features);
  }

  /* =========================
     UI & BADGES
     ========================= */
  GM_AddStyles();

  function GM_AddStyles(){
    GM_addStyle(`
      .hawkeye-badge { display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:12px; font-size:12px; font-weight:600; color:#fff; }
      .hawkeye-score { opacity:0.9; font-weight:700; }
      .hawkeye-btn { cursor:pointer; padding:4px 8px; border-radius:8px; border:1px solid #999; font-size:12px; background:#222; color:#eee; }
      .hawkeye-settings { position:fixed; bottom:14px; right:14px; background:#111; color:#eee; padding:12px; border-radius:12px; border:1px solid #333; z-index:99999; width:340px; box-shadow:0 6px 24px rgba(0,0,0,0.45);} 
      .hawkeye-settings h3{ margin:0 0 8px 0; font-size:14px;}
      .hawkeye-row { display:flex; gap:8px; align-items:center; margin:6px 0;}
      .hawkeye-row label{ flex:1;}
      .hawkeye-row input[type="text"], .hawkeye-row input[type="number"]{ flex:2; background:#1a1a1a; color:#fff; border:1px solid #444; padding:6px; border-radius:6px;}
      .hawkeye-row input[type="checkbox"]{ transform:scale(1.1);} 
      .hawkeye-foot{ display:flex; gap:8px; justify-content:space-between; margin-top:8px;}
      .hawkeye-watch { margin-left:8px; font-size:11px; color:#aaa; cursor:pointer; text-decoration:underline;}
      .hawkeye-tooltip { margin-left:6px; font-size:11px; color:#bbb; }
    `);
  }

  function ensureSettingsUI(){
    if(document.querySelector('.hawkeye-settings')) return;
    const wrap = document.createElement('div');
    wrap.className = 'hawkeye-settings';
    wrap.innerHTML = `
      <h3>HawkEye â€” Mug Likelihood v0.2</h3>
      <div class="hawkeye-row"><label>Enabled</label><input id="hawkeye_enabled" type="checkbox"></div>
      <div class="hawkeye-row"><label>Show on Profiles</label><input id="hawkeye_prof" type="checkbox"></div>
      <div class="hawkeye-row"><label>Show on Factions</label><input id="hawkeye_fac" type="checkbox"></div>
      <div class="hawkeye-row"><label>Enable Bazaar Signal</label><input id="hawkeye_baz" type="checkbox"></div>
      <div class="hawkeye-row"><label>Enable Status Signal</label><input id="hawkeye_stat" type="checkbox"></div>
      <div class="hawkeye-row"><label>Chain Mode Uplift</label><input id="hawkeye_chain" type="checkbox"></div>
      <div class="hawkeye-row"><label>Your Torn API Key</label><input id="hawkeye_key" type="text" placeholder="Paste your key (kept local)"></div>
      <div class="hawkeye-row"><label>Half-life (days)</label><input id="hawkeye_hl" type="number" min="3" max="60" step="1"></div>
      <div class="hawkeye-foot">
        <div>
          <button id="hawkeye_refresh" class="hawkeye-btn">Refresh Logs</button>
        </div>
        <div>
          <button id="hawkeye_save" class="hawkeye-btn">Save</button>
          <button id="hawkeye_close" class="hawkeye-btn">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    // init values
    wrap.querySelector('#hawkeye_enabled').checked = !!STATE.prefs.enabled;
    wrap.querySelector('#hawkeye_prof').checked    = !!STATE.prefs.showOnProfiles;
    wrap.querySelector('#hawkeye_fac').checked     = !!STATE.prefs.showOnFactions;
    wrap.querySelector('#hawkeye_baz').checked     = !!STATE.prefs.enableBazaarSignal;
    wrap.querySelector('#hawkeye_stat').checked    = !!STATE.prefs.enableStatusSignal;
    wrap.querySelector('#hawkeye_chain').checked   = !!STATE.prefs.chainMode;
    wrap.querySelector('#hawkeye_key').value       = STATE.key || '';
    wrap.querySelector('#hawkeye_hl').value        = STATE.prefs.scoreAgingHalfLifeDays;

    wrap.querySelector('#hawkeye_save').onclick = ()=>{
      STATE.prefs.enabled           = wrap.querySelector('#hawkeye_enabled').checked;
      STATE.prefs.showOnProfiles    = wrap.querySelector('#hawkeye_prof').checked;
      STATE.prefs.showOnFactions    = wrap.querySelector('#hawkeye_fac').checked;
      STATE.prefs.enableBazaarSignal= wrap.querySelector('#hawkeye_baz').checked;
      STATE.prefs.enableStatusSignal= wrap.querySelector('#hawkeye_stat').checked;
      STATE.prefs.chainMode         = wrap.querySelector('#hawkeye_chain').checked;
      STATE.prefs.scoreAgingHalfLifeDays = clamp(parseInt(wrap.querySelector('#hawkeye_hl').value||'21',10), 3, 60);
      savePrefs(STATE.prefs);
      const k = wrap.querySelector('#hawkeye_key').value.trim();
      if(k && k !== STATE.key){ STATE.key=k; localStorage.setItem(KEY_STORAGE, STATE.key); STATE.lastFetchTs=0; }
      alert('Saved');
    };

    wrap.querySelector('#hawkeye_refresh').onclick = async ()=>{
      try{ await fetchMyAttacks(true); alert('Attack logs refreshed.'); }catch(e){ alert('Refresh failed: '+e.message); }
    };

    wrap.querySelector('#hawkeye_close').onclick = ()=>{ wrap.style.display='none'; };
  }

  function addSettingsToggle(){
    if(document.getElementById('hawkeye_toggle_btn')) return;
    const b = document.createElement('button');
    b.id='hawkeye_toggle_btn'; b.className='hawkeye-btn';
    b.style.position='fixed'; b.style.bottom='14px'; b.style.right='370px'; b.style.zIndex='99999';
    b.textContent='HawkEye';
    b.onclick=()=>{ ensureSettingsUI(); const panel=document.querySelector('.hawkeye-settings'); panel.style.display=(panel.style.display==='none')?'block':(panel.style.display? 'none':'block'); };
    document.body.appendChild(b);
  }

  function classify(score, prefs){
    if(score>=prefs.mugJuicyThreshold) return {label:'Juicy', color:'#1ea672'};
    if(score>=prefs.mugMaybeThreshold) return {label:'Maybe', color:'#e0a800'};
    return {label:'Dry', color:'#d9534f'};
  }

  function renderBadge(score, prefs, tooltip){
    const cls = classify(score, prefs);
    const span = document.createElement('span');
    span.className='hawkeye-badge';
    span.style.background=cls.color; span.title = tooltip || '';
    span.innerHTML = `<span>${cls.label}</span><span class="hawkeye-score">${score}</span>`;
    return span;
  }

  function getProfileXID(){ const m=location.href.match(/XID=(\d+)/); return m?m[1]:null; }

  async function injectOnProfile(models){
    if(!STATE.prefs.showOnProfiles) return;
    const xid = getProfileXID(); if(!xid) return;
    const host = document.querySelector('#profileroot, .profile-wrapper, .content-wrapper, h2.title, .user-basic-information');
    if(!host || host.querySelector('.hawkeye-badge')) return;

    const score = await computeScoreForXID(xid, models);
    const tip = 'Wallet-likelihood score from status+bazaar+history';
    const badge = renderBadge(score, STATE.prefs, tip);
    const watch = mkWatchLink(xid);
    const wrap = document.createElement('div'); wrap.style.margin='6px 0'; wrap.append(badge, watch);
    host.prepend(wrap);
  }

  function mkWatchLink(xid){ const w=document.createElement('span'); w.className='hawkeye-watch'; const set=getWatch(); const watching=set.has(xid); w.textContent= watching?'Watching':'Watch'; w.onclick=()=>{ toggleWatch(xid,w); }; return w; }

  async function injectOnFaction(models){
    if(!STATE.prefs.showOnFactions) return;
    const rows = document.querySelectorAll('a[href*="profiles.php?XID="], .member-list a.user');
    for(const a of rows){
      if(a.dataset.hawkeyeDone) continue;
      const m = a.href && a.href.match(/XID=(\d+)/); if(!m) continue; const xid=m[1];
      try{
        const score = await computeScoreForXID(xid, models);
        const badge = renderBadge(score, STATE.prefs, 'Wallet-likelihood');
        badge.style.marginLeft='6px';
        a.after(badge);
        const watch = mkWatchLink(xid); badge.after(watch);
        a.dataset.hawkeyeDone='1';
      }catch{}
    }
  }

  function getWatch(){ try{ return new Set(JSON.parse(localStorage.getItem(WATCH_KEY)||'[]')); }catch{ return new Set(); } }
  function setWatch(set){ localStorage.setItem(WATCH_KEY, JSON.stringify(Array.from(set))); }
  function toggleWatch(xid, el){ const w=getWatch(); if(w.has(xid)){ w.delete(xid); el.textContent='Watch'; } else { w.add(xid); el.textContent='Watching'; } setWatch(w); }

  /* =========================
     OBSERVER
     ========================= */
  const observer = new MutationObserver(async ()=>{
    try{
      if(!STATE.prefs.enabled) return;
      addSettingsToggle();
      const rows = await fetchMyAttacks(false).catch(()=>[]);
      STATE.models = buildModels(rows);
      if(/profiles\.php\?XID=/.test(location.href)) await injectOnProfile(STATE.models);
      if(/factions\.php|#\/factions\//.test(location.href)) await injectOnFaction(STATE.models);
    }catch(e){ /* silent */ }
  });
  observer.observe(document.documentElement, { childList:true, subtree:true });

  /* =========================
     DISCORD BOT INTEGRATION (stub)
     =========================
     Later you can wire a webhook to post anonymized mug outcomes
     and pull /signals to strengthen priors across your faction.
     Keep this OFF by default to remain TOS-friendly.
  */
  // Example shape to send when YOU mug successfully:
  // function postCoopSignal(defenderId, money, hour){
  //   if(!STATE.prefs.enableCoopMode) return;
  //   const payload = {
  //     ts: Math.floor(Date.now()/1000),
  //     attacker: "you",
  //     defender_id: String(defenderId),
  //     money: Number(money)||0,
  //     tct_hour: hour
  //   };
  //   // GM.xmlHttpRequest({ method:'POST', url:'https://your-bot-endpoint/coop', data: JSON.stringify(payload), headers:{'Content-Type':'application/json'} });
  // }

})();
