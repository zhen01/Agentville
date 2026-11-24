import http from 'node:http';
import { readdir, stat, open, readFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {createRoster} from './roster.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export function summarize(rows, name, updated, now = Date.now(), showText = process.env.AGENTVILLE_SHOW_TASK_TEXT==='1') {
  let project = name.replace(/\.jsonl$/, '').slice(-12), status = 'idle', started = updated;
  const events = [], files = new Set();let task=''; const clip=v=>typeof v==='string'?v.replace(/\s+/g,' ').trim().slice(0,240):'';
  for (const row of rows) {
    const p = row.payload || {}, t = p.type || row.type;
    const time = Date.parse(row.timestamp) || updated;
    if (row.type === 'session_meta') { project = p.cwd ? basename(p.cwd) : project; started = Date.parse(p.timestamp) || time; }
    let label;
    if (['task_started','turn_started','user_message'].includes(t)) { status='working'; label='Started a task';if(t==='user_message'&&showText)task=clip(p.message); }
    else if (['task_complete','turn_complete'].includes(t)) { status='done'; label='Finished a task'; }
    else if (['turn_aborted','task_aborted'].includes(t)) { status='idle'; label='Task interrupted'; }
    else if (['function_call','custom_tool_call'].includes(t)) { status='working';const name=typeof p.name==='string'&&/^[\w.-]{1,90}$/.test(p.name)?p.name:'tool';label=({'exec_command':'Ran a terminal command','apply_patch':'Edited project files','read_file':'Read a file','list_files':'Listed project files','web_search':'Searched the web'})[name]||`Used ${name}`; }
    else if (t==='agent_message'&&showText&&p.message) {label=clip(p.message);}
    else if (['function_call_output','custom_tool_call_output'].includes(t)) { label='Received tool result'; }
    else if (['exec_approval_request','apply_patch_approval_request','approval_request'].includes(t)) { status='waiting'; label='Approval requested'; }
    else if (['agent_reasoning','reasoning'].includes(t)) { if(status!=='waiting') status='working'; label='Reasoning'; }
    else if (t==='patch_apply_end') { label='Applied file changes'; for(const f of Object.keys(p.changes||{})) files.add(basename(f)); }
    if(label) events.push({time,label});
  }
  if ((status==='working'||status==='waiting') && now-updated>180000) status='idle';
  return {id:name,project,status,started,updated,task,events:events.slice(-20).reverse(),files:[...files].slice(-12)};
}
async function discover(dir, depth=0) {
  if(depth>8) return [];
  const entries=await readdir(dir,{withFileTypes:true}).catch(()=>[]);
  const nested=await Promise.all(entries.filter(e=>e.isDirectory()).map(e=>discover(join(dir,e.name),depth+1)));
  return [...entries.filter(e=>e.isFile()&&e.name.endsWith('.jsonl')).map(e=>join(dir,e.name)),...nested.flat()];
}
function parse(text) { return text.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}); }
async function readSession(path, updated) {
  const f=await open(path,'r');
  try {
    const {size}=await f.stat(); const cap=512*1024;
    const head=Buffer.alloc(Math.min(8192,size)); await f.read(head,0,head.length,0);
    const tail=Buffer.alloc(Math.min(cap,size)); await f.read(tail,0,tail.length,Math.max(0,size-cap));
    const rows=parse(tail.toString('utf8'));
    if(size>cap) rows.unshift(...parse(head.toString('utf8')).filter(x=>x.type==='session_meta'));
    return summarize(rows,basename(path),updated);
  } finally {await f.close();}
}
export async function sessions(dir=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'sessions')) {
  const paths=await discover(dir); const entries=(await Promise.all(paths.map(async p=>({p,mtime:(await stat(p).catch(()=>null))?.mtimeMs||0})))).sort((a,b)=>b.mtime-a.mtime).slice(0,16);
  return (await Promise.all(entries.map(e=>readSession(e.p,e.mtime).catch(()=>null)))).filter(Boolean);
}
export function server() {
  const roster=createRoster(sessions);const scan=()=>roster.refresh().catch(()=>{});const timer=setInterval(scan,3000);timer.unref();
  const app=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method!=='GET') {res.writeHead(405);return res.end();}
    if(url.pathname==='/api/sessions') {try{const rosterData=await roster.refresh();res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({sessions:rosterData.active,history:rosterData.history,updated:Date.now()}));}catch{res.writeHead(500);return res.end('{}');}}
    const asset={'/':'index.html','/style.css':'style.css','/app.js':'app.js','/company.js':'company.js','/workspace.js':'workspace.js'}[url.pathname];
    if(!asset){res.writeHead(404);return res.end('Not found');}
    res.setHeader('Content-Type',asset.endsWith('.html')?'text/html; charset=utf-8':asset.endsWith('.css')?'text/css':'text/javascript');
    try{res.end(await readFile(join(root,'public',asset)));}catch{res.writeHead(500);res.end();}
  });app.on('close',()=>clearInterval(timer));return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {const port=Number(process.env.PORT||4317);server().listen(port,'127.0.0.1',()=>console.log(`Agentville: http://127.0.0.1:${port}`));}
