"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Kind = "expense" | "income";
type SortKey = "kind" | "date" | "merchant" | "category" | "amount";
type Tx = { id:string; kind:Kind; merchant:string; date:string; realised:string; amount:string; category:string; source:string };
type ZAccount = { id:string; title:string; instrument:number; user:number; balance?:number; inBalance?:boolean; archive?:boolean };
type ZTag = { id:string; title:string };
type ZMarker = { id:string; date:string; state:"planned"|"processed"|"deleted"; income:number; outcome:number; incomeInstrument:number; outcomeInstrument:number; incomeAccount:string; outcomeAccount:string; tag?:string[] };
type ZState = { accounts:ZAccount[]; tags:ZTag[]; markers:ZMarker[]; instruments:Array<{id:number;shortTitle:string}>; user:number; serverTimestamp:number };
type ApiLog = { time:string; action:string; status:number|string; request:unknown; response:unknown };
type ZenData = { user?:Array<{id:number}>; account?:ZAccount[]; tag?:ZTag[]; reminderMarker?:ZMarker[]; instruments?:Array<{id:number;shortTitle:string}>; instrument?:Array<{id:number;shortTitle:string}>; serverTimestamp?:number; [key:string]:unknown };
type ForecastCurrency = { instrument:number; currency:string; balance:number; expenses:number; income:number; forecast:number };
type ForecastCategory = { instrument:number; currency:string; title:string; amount:number };

const SESSION_TOKEN_KEY="mhb-zenmoney-session-token";
const SESSION_REMEMBER_KEY="mhb-zenmoney-remember-token";

const categories: Array<[RegExp, string]> = [
  [/VOLI|IDEA|AROMA|LAKOVIC|MIX MARKT|PEKARA|KOALA/i, "Продукты"],
  [/STEAM|SPOTIFY|YOUTUBE|APPLE\.COM|ANTHROPIC/i, "Подписки и развлечения"],
  [/TELEMACH|TELEKOM|MTEL|M:TEL/i, "Связь и интернет"],
  [/JPK|PARKING|BS BAR/i, "Транспорт"],
  [/OKOV|KUCA HEMIJE/i, "Дом и хозяйство"],
  [/EPAM|UPLATA ZARADE/i, "Зарплата"],
];

function guessCategory(name:string, kind:Kind) {
  return categories.find(([rx]) => rx.test(name))?.[1] ?? (kind === "income" ? "Доход" : "Без категории");
}
function isoDate(value:string) {
  const m = value.match(/(\d{2})[.\/]\s*(\d{2})[.\/]\s*(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}
function parseText(text:string, filename:string):Tx[] {
  const lines = text.replace(/[|]/g,"I").replace(/\r/g,"").split("\n").map(x=>x.trim()).filter(Boolean);
  const rows:Tx[]=[]; const amountRx=/EUR\s*([\d,.]+)(?:\s*(Expense|Income))?/i;
  for(let i=0;i<lines.length;i++){
    const m=lines[i].match(amountRx); if(!m) continue;
    const amount=m[1].replace(/,/g,""); if(!/^\d+(?:\.\d{1,2})?$/.test(amount)) continue;
    const before=lines[i].slice(0,m.index).trim(); const merchant=(before||lines[i-1]||"").replace(/^[©®@0O]\s*/,"").replace(/\s{2,}/g," ").trim();
    if(!merchant||/Transactions|Income|Expense|Reserved|All/i.test(merchant)) continue;
    let date="",realised=""; let kind:Kind=/Income/i.test(m[2]??"")?"income":"expense";
    for(let j=i;j<Math.min(i+5,lines.length);j++){if(/Currency date/i.test(lines[j]))date=isoDate(lines[j]);if(/Realisation date/i.test(lines[j]))realised=isoDate(lines[j]);if(/\bIncome\b/i.test(lines[j]))kind="income";}
    if(!date)continue;
    rows.push({id:crypto.randomUUID(),kind,merchant,date,realised,amount,category:guessCategory(merchant,kind),source:filename});
  } return rows;
}
function fingerprint(tx:Tx){return [tx.kind,tx.date,tx.realised,Number(tx.amount).toFixed(2),tx.merchant.toUpperCase().replace(/\s+/g," ")].join("|")}
function escapeCsv(value:string){return `"${value.replace(/"/g,'""')}"`}
function errorText(value:unknown){if(value instanceof Error)return value.message;if(typeof value==="string")return value;try{return JSON.stringify(value,null,2)}catch{return "Неизвестная ошибка"}}
function localIsoDate(date:Date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`}
function money(value:number,currency:string){return `${new Intl.NumberFormat("ru-RU",{maximumFractionDigits:0}).format(value)} ${currency}`}
function saveSessionToken(value:string){try{if(value)sessionStorage.setItem(SESSION_TOKEN_KEY,value);else sessionStorage.removeItem(SESSION_TOKEN_KEY)}catch{/* Хранилище может быть недоступно в приватном режиме. */}}
function saveRememberToken(value:boolean){try{if(value)sessionStorage.setItem(SESSION_REMEMBER_KEY,"1");else sessionStorage.removeItem(SESSION_REMEMBER_KEY)}catch{/* Хранилище может быть недоступно в приватном режиме. */}}
async function stableUuid(value:string){const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))).slice(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`}

export default function Home(){
  const [rows,setRows]=useState<Tx[]>([]),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0);
  const [account,setAccount]=useState("Hipotekarna EUR"),[notice,setNotice]=useState("Добавьте скриншоты списков Expense и Income");
  const [token,setToken]=useState(""),[zstate,setZstate]=useState<ZState|null>(null),[zAccount,setZAccount]=useState(""),[apiStatus,setApiStatus]=useState(""),[apiBusy,setApiBusy]=useState(false);
  const [rememberToken,setRememberToken]=useState(false);
  const [apiLogs,setApiLogs]=useState<ApiLog[]>([]);
  const [forecastDays,setForecastDays]=useState(45);
  const [sort,setSort]=useState<{key:SortKey;direction:"asc"|"desc"}>({key:"date",direction:"desc"});
  const fileInput=useRef<HTMLInputElement>(null);
  const total=useMemo(()=>rows.reduce((s,r)=>s+(r.kind==="expense"?-1:1)*Number(r.amount||0),0),[rows]);
  const sortedRows=useMemo(()=>[...rows].sort((a,b)=>{const av=sort.key==="amount"?Number(a.amount):a[sort.key].toLocaleLowerCase();const bv=sort.key==="amount"?Number(b.amount):b[sort.key].toLocaleLowerCase();const result=av<bv?-1:av>bv?1:0;return sort.direction==="asc"?result:-result}),[rows,sort]);
  const forecast=useMemo(()=>{
    if(!zstate)return {currencies:[] as ForecastCurrency[],categories:[] as ForecastCategory[],markerCount:0,endDate:""};
    const start=localIsoDate(new Date());const end=new Date();end.setDate(end.getDate()+forecastDays);const endDate=localIsoDate(end);
    const currencyTitle=(instrument:number)=>zstate.instruments.find(i=>i.id===instrument)?.shortTitle||`#${instrument}`;
    const balance=new Map<number,number>();
    zstate.accounts.filter(a=>a.inBalance!==false).forEach(a=>balance.set(a.instrument,(balance.get(a.instrument)||0)+Number(a.balance||0)));
    const expenses=new Map<number,number>(),income=new Map<number,number>(),movement=new Map<number,number>(),categoryTotals=new Map<string,ForecastCategory>();
    const markers=zstate.markers.filter(m=>m.state==="planned"&&m.date>=start&&m.date<=endDate);
    markers.forEach(marker=>{
      const markerIncome=Number(marker.income||0),markerOutcome=Number(marker.outcome||0),isTransfer=markerIncome>0&&markerOutcome>0;
      if(markerOutcome>0)movement.set(marker.outcomeInstrument,(movement.get(marker.outcomeInstrument)||0)-markerOutcome);
      if(markerIncome>0)movement.set(marker.incomeInstrument,(movement.get(marker.incomeInstrument)||0)+markerIncome);
      if(markerOutcome>0&&!isTransfer){
        expenses.set(marker.outcomeInstrument,(expenses.get(marker.outcomeInstrument)||0)+markerOutcome);
        const title=zstate.tags.find(t=>t.id===marker.tag?.[0])?.title||"Без категории";const key=`${marker.outcomeInstrument}|${title}`;
        const current=categoryTotals.get(key)||{instrument:marker.outcomeInstrument,currency:currencyTitle(marker.outcomeInstrument),title,amount:0};current.amount+=markerOutcome;categoryTotals.set(key,current);
      }
      if(markerIncome>0&&!isTransfer)income.set(marker.incomeInstrument,(income.get(marker.incomeInstrument)||0)+markerIncome);
    });
    const instruments=new Set([...balance.keys(),...expenses.keys(),...income.keys(),...movement.keys()]);
    const currencies=[...instruments].map(instrument=>({instrument,currency:currencyTitle(instrument),balance:balance.get(instrument)||0,expenses:expenses.get(instrument)||0,income:income.get(instrument)||0,forecast:(balance.get(instrument)||0)+(movement.get(instrument)||0)})).sort((a,b)=>a.currency.localeCompare(b.currency));
    const categories=[...categoryTotals.values()].sort((a,b)=>b.amount-a.amount);
    return {currencies,categories,markerCount:markers.length,endDate};
  },[zstate,forecastDays]);
  const categoryGroups=useMemo(()=>{
    const groups=new Map<string,ForecastCategory[]>();
    forecast.categories.forEach(item=>groups.set(item.currency,[...(groups.get(item.currency)||[]),item]));
    return [...groups].map(([currency,items])=>({currency,items})).sort((a,b)=>a.currency.localeCompare(b.currency));
  },[forecast.categories]);
  useEffect(()=>{try{const remember=sessionStorage.getItem(SESSION_REMEMBER_KEY)==="1";setRememberToken(remember);if(remember)setToken(sessionStorage.getItem(SESSION_TOKEN_KEY)||"")}catch{/* Оставляем значения пустыми, если хранилище недоступно. */}},[]);
  function toggleSort(key:SortKey){setSort(current=>({key,direction:current.key===key&&current.direction==="asc"?"desc":"asc"}))}
  function sortMark(key:SortKey){return sort.key===key?(sort.direction==="asc"?" ↑":" ↓"):""}
  async function processFiles(files:FileList|File[]){
    const images=Array.from(files).filter(f=>f.type.startsWith("image/"));if(!images.length)return;
    setBusy(true);setProgress(0);setNotice("Подготавливаю распознавание…");
    const { createWorker } = await import("tesseract.js");
    const worker=await createWorker("eng",1,{logger:m=>{if(m.status==="recognizing text")setProgress(Math.round((m.progress??0)*100))}});const parsed:Tx[]=[];
    try{for(let i=0;i<images.length;i++){setNotice(`Распознаю ${i+1} из ${images.length}: ${images[i].name}`);const result=await worker.recognize(images[i]);parsed.push(...parseText(result.data.text,images[i].name));}}finally{await worker.terminate()}
    setRows(current=>{const seen=new Set<string>();return [...current,...parsed].filter(r=>{const k=fingerprint(r);if(seen.has(k))return false;seen.add(k);return true})});
    setNotice(parsed.length?`Найдено ${parsed.length} строк. Проверьте таблицу перед экспортом.`:"Операции не найдены. Используйте экран списка, как в присланных примерах.");setBusy(false);setProgress(100);
  }
  useEffect(()=>{
    function handlePaste(event:ClipboardEvent){
      const images=Array.from(event.clipboardData?.files??[]).filter(file=>file.type.startsWith("image/"));
      if(!images.length)return;
      event.preventDefault();
      void processFiles(images);
    }
    window.addEventListener("paste",handlePaste);
    return ()=>window.removeEventListener("paste",handlePaste);
  },[]);
  function update(id:string,field:keyof Tx,value:string){setRows(all=>all.map(r=>r.id===id?{...r,[field]:value}:r))}
  function exportCsv(){
    const header=["Дата","Категория","Плательщик","Комментарий","Счёт","Сумма (расход)","Пропустить","Счёт-получатель","Сумма (доход)","Пропустить","Пропустить","Пропустить"];
    const data=sortedRows.map(r=>[r.date.split("-").reverse().join("."),r.category,r.merchant,r.realised?`Дата проводки: ${r.realised.split("-").reverse().join(".")}; источник: mHB klik`:"Источник: mHB klik",account,r.kind==="expense"?r.amount:"","","",r.kind==="income"?r.amount:"","","",""]);
    const csv="\uFEFF"+[header,...data].map(line=>line.map(c=>escapeCsv(String(c))).join(";")).join("\r\n");const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=`hipotekarna-zenmoney-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);
  }
  async function zenRequest(payload:Record<string,unknown>,action:string){const safeRequest={...payload,transaction:Array.isArray(payload.transaction)?`[${payload.transaction.length} операций]`:payload.transaction};const apiUrl=typeof window!=="undefined"&&window.location.hostname.endsWith("github.io")?"https://mhb-zenmoney-converter.xeningem.chatgpt.site/api/zenmoney":"/api/zenmoney";try{const response=await fetch(apiUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token,payload})});const raw=await response.text();let data:unknown;try{data=JSON.parse(raw)}catch{data=raw||"Пустой ответ"}setApiLogs(old=>[{time:new Date().toLocaleTimeString(),action,status:response.status,request:safeRequest,response:data},...old]);if(!response.ok)throw data;return data as ZenData}catch(error){if(error instanceof TypeError)setApiLogs(old=>[{time:new Date().toLocaleTimeString(),action,status:"network",request:safeRequest,response:errorText(error)},...old]);throw error}}
  async function connectZenMoney(){
    if(!token.trim()){setApiStatus("Введите access token");return} setApiBusy(true);setApiStatus("Подключаюсь…");
    try{const now=Math.floor(Date.now()/1000);const data=await zenRequest({currentClientTimestamp:now,serverTimestamp:0,forceFetch:["account","instrument","tag","user","reminderMarker"]},"Загрузка финансов");const users=data.user||[];const accounts=(data.account||[]).filter((a:ZAccount)=>!a.archive);const markers=(data.reminderMarker||[]).filter((m:ZMarker)=>m.state==="planned");const state={accounts,tags:data.tag||[],markers,instruments:data.instrument||[],user:users[0]?.id||accounts[0]?.user,serverTimestamp:data.serverTimestamp||0};setZstate(state);setZAccount(accounts.find((a:ZAccount)=>/hipotekarna/i.test(a.title))?.id||accounts[0]?.id||"");setApiStatus(`Подключено. Счетов: ${accounts.length}, запланированных операций: ${markers.length}`)}catch(e){setApiStatus(`Ошибка: ${errorText(e)}`)}finally{setApiBusy(false)}
  }
  async function sendToZenMoney(){
    if(!zstate||!zAccount||!rows.length)return;const accountData=zstate.accounts.find(a=>a.id===zAccount);if(!accountData)return;setApiBusy(true);setApiStatus("Отправляю операции…");
    try{const now=Math.floor(Date.now()/1000);const transactions=await Promise.all(sortedRows.map(async r=>{const amount=Number(r.amount);const tag=zstate.tags.find(t=>t.title.toLowerCase()===r.category.toLowerCase());return {id:await stableUuid(`mhb|${zAccount}|${fingerprint(r)}`),user:accountData.user||zstate.user,changed:now,created:now,deleted:false,viewed:false,hold:false,incomeInstrument:accountData.instrument,outcomeInstrument:accountData.instrument,incomeAccount:zAccount,outcomeAccount:zAccount,income:r.kind==="income"?amount:0,outcome:r.kind==="expense"?amount:0,tag:tag?[tag.id]:[],merchant:null,reminderMarker:null,opIncome:null,opIncomeInstrument:null,opOutcome:null,opOutcomeInstrument:null,latitude:null,longitude:null,incomeBankID:null,outcomeBankID:null,qrCode:null,payee:r.merchant,originalPayee:r.merchant,comment:r.realised?`Дата проводки: ${r.realised}; импорт mHB klik`:"Импорт mHB klik",date:r.date,source:"mhb-screenshot-import"}}));await zenRequest({currentClientTimestamp:now,serverTimestamp:zstate.serverTimestamp,transaction:transactions},"Отправка операций");setApiStatus(`Готово: отправлено ${transactions.length} операций. Повторная отправка обновит их, а не создаст дубли.`)}catch(e){setApiStatus(`Ошибка: ${errorText(e)}`)}finally{setApiBusy(false)}
  }
  return <main>
    <header className="hero"><div className="brand"><span>mHB</span><i>→</i><strong>ZenMoney</strong></div><h1>Скриншоты операций<br/>превращаются в аккуратный CSV</h1><p>Всё распознавание происходит прямо в браузере. Снимки не загружаются и нигде не сохраняются.</p></header>
    <section className="workspace">
      <div className={`dropzone ${busy?"busy":""}`} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();processFiles(e.dataTransfer.files)}}><div className="uploadIcon">↑</div><h2>{busy?"Распознаю операции":"Добавьте скриншоты mHB klik"}</h2><div className="pasteHint"><kbd>⌘V</kbd><span>или</span><kbd>Ctrl+V</kbd><strong>Вставьте из буфера обмена</strong></div><p>{notice}</p>{busy&&<div className="progress"><span style={{width:`${progress}%`}}/></div>}<input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e=>e.target.files&&processFiles(e.target.files)}/><button className="primary" disabled={busy} onClick={()=>fileInput.current?.click()}>{busy?`${progress}%`:"Выбрать изображения"}</button><small>Также можно перетащить или выбрать сразу несколько скриншотов</small></div>
      <div className="settings"><label>Название счёта в ZenMoney<input value={account} onChange={e=>setAccount(e.target.value)}/></label><div><span>Операций</span><b>{rows.length}</b></div><div><span>Итог</span><b className={total<0?"negative":"positive"}>{total.toFixed(2)} EUR</b></div></div>
    </section>
    {rows.length>0&&<section className="results"><div className="resultsHead"><div><span>ПРОВЕРКА</span><h2>Распознанные операции</h2></div><button className="export" onClick={exportCsv}>Скачать CSV</button></div><div className="tableWrap"><table><thead><tr><th><button className="sortButton" onClick={()=>toggleSort("kind")}>Тип{sortMark("kind")}</button></th><th><button className="sortButton" onClick={()=>toggleSort("date")}>Дата{sortMark("date")}</button></th><th><button className="sortButton" onClick={()=>toggleSort("merchant")}>Описание{sortMark("merchant")}</button></th><th><button className="sortButton" onClick={()=>toggleSort("category")}>Категория{sortMark("category")}</button></th><th><button className="sortButton" onClick={()=>toggleSort("amount")}>Сумма, EUR{sortMark("amount")}</button></th><th/></tr></thead><tbody>{sortedRows.map(r=><tr key={r.id}><td><select value={r.kind} onChange={e=>update(r.id,"kind",e.target.value)}><option value="expense">Расход</option><option value="income">Доход</option></select></td><td><input type="date" value={r.date} onChange={e=>update(r.id,"date",e.target.value)}/></td><td><input value={r.merchant} onChange={e=>update(r.id,"merchant",e.target.value)}/></td><td><input value={r.category} onChange={e=>update(r.id,"category",e.target.value)}/></td><td><input className="amount" inputMode="decimal" value={r.amount} onChange={e=>update(r.id,"amount",e.target.value.replace(",","."))}/></td><td><button className="remove" aria-label="Удалить" onClick={()=>setRows(all=>all.filter(x=>x.id!==r.id))}>×</button></td></tr>)}</tbody></table></div><p className="hint">Дата операции берётся из Currency date. Realisation date сохраняется в комментарии. Совпадающие строки удаляются автоматически.</p></section>}
    <section className="apiCard"><div><span className="eyebrow">REST API</span><h2>Состояние ZenMoney</h2><p>Подключитесь, чтобы увидеть балансы и будущие расходы. Токен используется только для запросов к ZenMoney.</p></div><div className="apiForm"><label><span className="tokenLabel"><span>Access token</span><a href="https://zerro.app/token" target="_blank" rel="noopener noreferrer">Получить токен ↗</a></span><input type="password" autoComplete="off" value={token} onChange={e=>{const value=e.target.value;setToken(value);setZstate(null);if(rememberToken)saveSessionToken(value)}} placeholder="Вставьте токен ZenMoney"/></label><label className="rememberToken"><input type="checkbox" checked={rememberToken} onChange={e=>{const checked=e.target.checked;setRememberToken(checked);saveRememberToken(checked);saveSessionToken(checked?token:"")}}/><span><b>Сохранять до закрытия браузера</b><small>Токен переживёт обновление страницы, но останется только в этой вкладке.</small></span></label>{zstate&&rows.length>0&&<label>Счёт для импорта<select value={zAccount} onChange={e=>setZAccount(e.target.value)}>{zstate.accounts.map(a=><option key={a.id} value={a.id}>{a.title} · {zstate.instruments.find(i=>i.id===a.instrument)?.shortTitle||""}</option>)}</select></label>}<div className="apiActions"><button className="secondary" disabled={apiBusy} onClick={connectZenMoney}>{zstate?"Обновить данные":"Подключить"}</button>{rows.length>0&&<button className="primary" disabled={apiBusy||!zstate||!zAccount} onClick={sendToZenMoney}>Отправить {rows.length} операций</button>}</div>{apiStatus&&<p className="apiStatus">{apiStatus}</p>}{apiLogs.length>0&&<details className="apiLogs"><summary>Журнал API · {apiLogs.length}</summary><div className="logTools"><button onClick={()=>navigator.clipboard.writeText(JSON.stringify(apiLogs,null,2))}>Копировать</button><button onClick={()=>setApiLogs([])}>Очистить</button></div>{apiLogs.map((log,index)=><div className="logEntry" key={`${log.time}-${index}`}><b>{log.time} · {log.action} · HTTP {log.status}</b><span>Запрос</span><pre>{JSON.stringify(log.request,null,2)}</pre><span>Ответ</span><pre>{typeof log.response==="string"?log.response:JSON.stringify(log.response,null,2)}</pre></div>)}</details>}<small>{rows.length>0?"Перед отправкой проверьте таблицу. Категории сопоставляются по точному названию.":"Для просмотра достаточно подключиться — загружать скриншоты необязательно."}</small></div></section>
    {zstate&&<section className="financeCard">
      <div className="financeHead"><div><span className="eyebrow">ПРОГНОЗ</span><h2>Деньги на ближайшие {forecastDays} дней</h2><p>Учтено запланированных операций: {forecast.markerCount}. Период по {forecast.endDate.split("-").reverse().join(".")}.</p></div><label>Период<select value={forecastDays} onChange={e=>setForecastDays(Number(e.target.value))}><option value={30}>30 дней</option><option value={45}>45 дней</option><option value={60}>60 дней</option></select></label></div>
      <div className="forecastGrid">{forecast.currencies.map(item=><article key={item.instrument}><span>{item.currency}</span><dl><div><dt>Сейчас</dt><dd>{money(item.balance,item.currency)}</dd></div><div><dt>Запланировано трат</dt><dd className="negative">−{money(item.expenses,item.currency)}</dd></div><div><dt>Ожидается доходов</dt><dd className="positive">+{money(item.income,item.currency)}</dd></div><div className="forecastTotal"><dt>Останется</dt><dd className={item.forecast<0?"negative":"positive"}>{money(item.forecast,item.currency)}</dd></div></dl></article>)}</div>
      <div className="financeDetails"><div><h3>Счета</h3>{zstate.accounts.map(a=><div className="accountRow" key={a.id}><span>{a.title}</span><b>{money(Number(a.balance||0),zstate.instruments.find(i=>i.id===a.instrument)?.shortTitle||"")}</b></div>)}</div><div><h3>Плановые траты по категориям</h3>{categoryGroups.length?categoryGroups.map(group=><div className="categoryGroup" key={group.currency}><h4>{group.currency}</h4>{group.items.map(item=><div className="categoryRow" key={`${item.instrument}-${item.title}`}><span>{item.title}</span><b>{money(item.amount,item.currency)}</b></div>)}</div>):<p className="emptyForecast">На выбранный период плановых расходов нет.</p>}</div></div>
      <p className="forecastNote">В «Останется» учитываются также запланированные переводы между своими счетами. В расходы и доходы такие переводы не попадают.</p>
    </section>}
  </main>
}
