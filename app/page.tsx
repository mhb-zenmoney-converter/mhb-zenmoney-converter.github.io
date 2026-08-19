"use client";

import { useMemo, useRef, useState } from "react";

type Kind = "expense" | "income";
type SortKey = "kind" | "date" | "merchant" | "category" | "amount";
type Tx = { id:string; kind:Kind; merchant:string; date:string; realised:string; amount:string; category:string; source:string };
type ZAccount = { id:string; title:string; instrument:number; user:number; archive?:boolean };
type ZTag = { id:string; title:string };
type ZState = { accounts:ZAccount[]; tags:ZTag[]; instruments:Array<{id:number;shortTitle:string}>; user:number; serverTimestamp:number };
type ApiLog = { time:string; action:string; status:number|string; request:unknown; response:unknown };
type ZenData = { user?:Array<{id:number}>; account?:ZAccount[]; tag?:ZTag[]; instruments?:Array<{id:number;shortTitle:string}>; instrument?:Array<{id:number;shortTitle:string}>; serverTimestamp?:number; [key:string]:unknown };

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
async function stableUuid(value:string){const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))).slice(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`}

export default function Home(){
  const [rows,setRows]=useState<Tx[]>([]),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0);
  const [account,setAccount]=useState("Hipotekarna EUR"),[notice,setNotice]=useState("Добавьте скриншоты списков Expense и Income");
  const [token,setToken]=useState(""),[zstate,setZstate]=useState<ZState|null>(null),[zAccount,setZAccount]=useState(""),[apiStatus,setApiStatus]=useState(""),[apiBusy,setApiBusy]=useState(false);
  const [apiLogs,setApiLogs]=useState<ApiLog[]>([]);
  const [sort,setSort]=useState<{key:SortKey;direction:"asc"|"desc"}>({key:"date",direction:"desc"});
  const fileInput=useRef<HTMLInputElement>(null);
  const total=useMemo(()=>rows.reduce((s,r)=>s+(r.kind==="expense"?-1:1)*Number(r.amount||0),0),[rows]);
  const sortedRows=useMemo(()=>[...rows].sort((a,b)=>{const av=sort.key==="amount"?Number(a.amount):a[sort.key].toLocaleLowerCase();const bv=sort.key==="amount"?Number(b.amount):b[sort.key].toLocaleLowerCase();const result=av<bv?-1:av>bv?1:0;return sort.direction==="asc"?result:-result}),[rows,sort]);
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
  function update(id:string,field:keyof Tx,value:string){setRows(all=>all.map(r=>r.id===id?{...r,[field]:value}:r))}
  function exportCsv(){
    const header=["Дата","Категория","Плательщик","Комментарий","Счёт","Сумма (расход)","Пропустить","Счёт-получатель","Сумма (доход)","Пропустить","Пропустить","Пропустить"];
    const data=sortedRows.map(r=>[r.date.split("-").reverse().join("."),r.category,r.merchant,r.realised?`Дата проводки: ${r.realised.split("-").reverse().join(".")}; источник: mHB klik`:"Источник: mHB klik",account,r.kind==="expense"?r.amount:"","","",r.kind==="income"?r.amount:"","","",""]);
    const csv="\uFEFF"+[header,...data].map(line=>line.map(c=>escapeCsv(String(c))).join(";")).join("\r\n");const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=`hipotekarna-zenmoney-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);
  }
  async function zenRequest(payload:Record<string,unknown>,action:string){const safeRequest={...payload,transaction:Array.isArray(payload.transaction)?`[${payload.transaction.length} операций]`:payload.transaction};const apiUrl=typeof window!=="undefined"&&window.location.hostname.endsWith("github.io")?"https://mhb-zenmoney-converter.xeningem.chatgpt.site/api/zenmoney":"/api/zenmoney";try{const response=await fetch(apiUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token,payload})});const raw=await response.text();let data:unknown;try{data=JSON.parse(raw)}catch{data=raw||"Пустой ответ"}setApiLogs(old=>[{time:new Date().toLocaleTimeString(),action,status:response.status,request:safeRequest,response:data},...old]);if(!response.ok)throw data;return data as ZenData}catch(error){if(error instanceof TypeError)setApiLogs(old=>[{time:new Date().toLocaleTimeString(),action,status:"network",request:safeRequest,response:errorText(error)},...old]);throw error}}
  async function connectZenMoney(){
    if(!token.trim()){setApiStatus("Введите access token");return} setApiBusy(true);setApiStatus("Подключаюсь…");
    try{const now=Math.floor(Date.now()/1000);const data=await zenRequest({currentClientTimestamp:now,serverTimestamp:0,forceFetch:["account","instrument","tag","user"]},"Загрузка счетов");const users=data.user||[];const accounts=(data.account||[]).filter((a:ZAccount)=>!a.archive);const state={accounts,tags:data.tag||[],instruments:data.instrument||[],user:users[0]?.id||accounts[0]?.user,serverTimestamp:data.serverTimestamp||0};setZstate(state);setZAccount(accounts.find((a:ZAccount)=>/hipotekarna/i.test(a.title))?.id||accounts[0]?.id||"");setApiStatus(`Подключено. Найдено счетов: ${accounts.length}`)}catch(e){setApiStatus(`Ошибка: ${errorText(e)}`)}finally{setApiBusy(false)}
  }
  async function sendToZenMoney(){
    if(!zstate||!zAccount||!rows.length)return;const accountData=zstate.accounts.find(a=>a.id===zAccount);if(!accountData)return;setApiBusy(true);setApiStatus("Отправляю операции…");
    try{const now=Math.floor(Date.now()/1000);const transactions=await Promise.all(sortedRows.map(async r=>{const amount=Number(r.amount);const tag=zstate.tags.find(t=>t.title.toLowerCase()===r.category.toLowerCase());return {id:await stableUuid(`mhb|${zAccount}|${fingerprint(r)}`),user:accountData.user||zstate.user,changed:now,created:now,deleted:false,viewed:false,hold:false,incomeInstrument:accountData.instrument,outcomeInstrument:accountData.instrument,incomeAccount:zAccount,outcomeAccount:zAccount,income:r.kind==="income"?amount:0,outcome:r.kind==="expense"?amount:0,tag:tag?[tag.id]:[],merchant:null,reminderMarker:null,opIncome:null,opIncomeInstrument:null,opOutcome:null,opOutcomeInstrument:null,latitude:null,longitude:null,incomeBankID:null,outcomeBankID:null,qrCode:null,payee:r.merchant,originalPayee:r.merchant,comment:r.realised?`Дата проводки: ${r.realised}; импорт mHB klik`:"Импорт mHB klik",date:r.date,source:"mhb-screenshot-import"}}));await zenRequest({currentClientTimestamp:now,serverTimestamp:zstate.serverTimestamp,transaction:transactions},"Отправка операций");setApiStatus(`Готово: отправлено ${transactions.length} операций. Повторная отправка обновит их, а не создаст дубли.`)}catch(e){setApiStatus(`Ошибка: ${errorText(e)}`)}finally{setApiBusy(false)}
  }
  return <main>
    <header className="hero"><div className="brand"><span>mHB</span><i>→</i><strong>ZenMoney</strong></div><h1>Скриншоты операций<br/>превращаются в аккуратный CSV</h1><p>Всё распознавание происходит прямо в браузере. Снимки не загружаются и нигде не сохраняются.</p></header>
    <section className="workspace">
      <div className={`dropzone ${busy?"busy":""}`} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();processFiles(e.dataTransfer.files)}}><div className="uploadIcon">↑</div><h2>{busy?"Распознаю операции":"Добавьте скриншоты mHB klik"}</h2><p>{notice}</p>{busy&&<div className="progress"><span style={{width:`${progress}%`}}/></div>}<input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={e=>e.target.files&&processFiles(e.target.files)}/><button className="primary" disabled={busy} onClick={()=>fileInput.current?.click()}>{busy?`${progress}%`:"Выбрать изображения"}</button><small>Можно выбрать сразу несколько перекрывающихся скриншотов</small></div>
      <div className="settings"><label>Название счёта в ZenMoney<input value={account} onChange={e=>setAccount(e.target.value)}/></label><div><span>Операций</span><b>{rows.length}</b></div><div><span>Итог</span><b className={total<0?"negative":"positive"}>{total.toFixed(2)} EUR</b></div></div>
    </section>
    {rows.length>0&&<><section className="results"><div className="resultsHead"><div><span>ПРОВЕРКА</span><h2>Распознанные операции</h2></div><button className="export" onClick={exportCsv}>Скачать CSV</button></div><div className="tableWrap"><table><thead><tr><th><button className="sortButton" onClick={()=>toggleSort("kind")}>Тип{sortMark("kind")}</button></th><th><button className="sortButton" onClick={()=>toggleSort("date")}>Дата{sortMark("date")}</button></th><th><button className="sortButton" onClick={()=>toggleSort("merchant")}>Описание{sortMark("merchant")}</button></th><th><button className="sortButton" onClick={()=>toggleSort("category")}>Категория{sortMark("category")}</button></th><th><button className="sortButton" onClick={()=>toggleSort("amount")}>Сумма, EUR{sortMark("amount")}</button></th><th/></tr></thead><tbody>{sortedRows.map(r=><tr key={r.id}><td><select value={r.kind} onChange={e=>update(r.id,"kind",e.target.value)}><option value="expense">Расход</option><option value="income">Доход</option></select></td><td><input type="date" value={r.date} onChange={e=>update(r.id,"date",e.target.value)}/></td><td><input value={r.merchant} onChange={e=>update(r.id,"merchant",e.target.value)}/></td><td><input value={r.category} onChange={e=>update(r.id,"category",e.target.value)}/></td><td><input className="amount" inputMode="decimal" value={r.amount} onChange={e=>update(r.id,"amount",e.target.value.replace(",","."))}/></td><td><button className="remove" aria-label="Удалить" onClick={()=>setRows(all=>all.filter(x=>x.id!==r.id))}>×</button></td></tr>)}</tbody></table></div><p className="hint">Дата операции берётся из Currency date. Realisation date сохраняется в комментарии. Совпадающие строки удаляются автоматически.</p></section>
    <section className="apiCard"><div><span className="eyebrow">REST API</span><h2>Отправить прямо в ZenMoney</h2><p>Токен используется только для текущего запроса и нигде не сохраняется.</p></div><div className="apiForm"><label><span className="tokenLabel"><span>Access token</span><a href="https://zerro.app/token" target="_blank" rel="noopener noreferrer">Получить токен ↗</a></span><input type="password" autoComplete="off" value={token} onChange={e=>{setToken(e.target.value);setZstate(null)}} placeholder="Вставьте токен ZenMoney"/></label>{zstate&&<label>Счёт<select value={zAccount} onChange={e=>setZAccount(e.target.value)}>{zstate.accounts.map(a=><option key={a.id} value={a.id}>{a.title} · {zstate.instruments.find(i=>i.id===a.instrument)?.shortTitle||""}</option>)}</select></label>}<div className="apiActions"><button className="secondary" disabled={apiBusy} onClick={connectZenMoney}>{zstate?"Обновить счета":"Подключить"}</button><button className="primary" disabled={apiBusy||!zstate||!zAccount} onClick={sendToZenMoney}>Отправить {rows.length} операций</button></div>{apiStatus&&<p className="apiStatus">{apiStatus}</p>}{apiLogs.length>0&&<details className="apiLogs" open><summary>Журнал API · {apiLogs.length}</summary><div className="logTools"><button onClick={()=>navigator.clipboard.writeText(JSON.stringify(apiLogs,null,2))}>Копировать</button><button onClick={()=>setApiLogs([])}>Очистить</button></div>{apiLogs.map((log,index)=><div className="logEntry" key={`${log.time}-${index}`}><b>{log.time} · {log.action} · HTTP {log.status}</b><span>Запрос</span><pre>{JSON.stringify(log.request,null,2)}</pre><span>Ответ</span><pre>{typeof log.response==="string"?log.response:JSON.stringify(log.response,null,2)}</pre></div>)}</details>}<small>Перед отправкой проверьте таблицу. Категории сопоставляются по точному названию; неизвестные операции попадут без категории.</small></div></section></>}
  </main>
}
