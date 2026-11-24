import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {homedir} from 'node:os';
const exec=promisify(execFile);
export function parseProcesses(output){return output.split('\n').flatMap(line=>{const m=line.match(/^\s*(\d+)\s+(.{24})\s+(.+?)\s*$/);if(!m||basename(m[3])!=='codex')return [];return [{pid:Number(m[1]),started:Date.parse(m[2])||0}];});}
export async function processes(){const {stdout}=await exec('ps',['-axo','pid=,lstart=,comm='],{maxBuffer:8*1024*1024});return parseProcesses(stdout);}
async function openSession(pid){try{const {stdout}=await exec('lsof',['-a','-p',String(pid),'-Fn'],{timeout:3000,maxBuffer:2*1024*1024});const matches=stdout.split('\n').filter(x=>x.startsWith('n')&&/\/sessions\/.*\.jsonl$/.test(x));return matches.length===1?basename(matches[0].slice(1)):null;}catch{return null;}}
export function reconcile(previous, live, logs, now=Date.now()){
 const byId=new Map(logs.map(s=>[s.id,s]));const active=live.map(p=>{const id=`${p.pid}-${p.started}`,old=previous.active.find(x=>x.id===id);const log=byId.get(p.sessionId||old?.sessionId);const entry={id,pid:p.pid,started:p.started||old?.started||now,firstSeen:old?.firstSeen||now,updated:now,project:log?.project||old?.project||`Codex #${p.pid}`,sessionId:log?.id||old?.sessionId||null,status:log?.status||old?.status||'idle',task:log?.task||'',events:log?.events||old?.events||[],files:log?.files||old?.files||[]};return entry;});
 const ids=new Set(active.map(x=>x.id));const departed=previous.active.filter(x=>!ids.has(x.id)).map(x=>({...x,departed:now,lastSeen:x.updated}));return {active,history:[...departed,...previous.history].slice(0,500)};
}
export function createRoster(getLogs,{directory=join(homedir(),'.agentville','employee-history'),getProcesses=processes,getSession=openSession}={}){
 let state={active:[],history:[]},initialized=false,inFlight;
 async function update(){if(!initialized){try{state=JSON.parse(await readFile(join(directory,'roster.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}initialized=true;}const [live,logs]=await Promise.all([getProcesses(),getLogs()]);const linked=await Promise.all(live.map(async p=>({...p,sessionId:await getSession(p.pid)})));const next=reconcile(state,linked,logs);await mkdir(directory,{recursive:true,mode:0o700});const target=join(directory,'roster.json'),tmp=join(directory,'roster.tmp');await writeFile(tmp,JSON.stringify(next,null,2),{mode:0o600});await rename(tmp,target);state=next;return state;}
 return {refresh(){if(!inFlight)inFlight=update().finally(()=>{inFlight=null});return inFlight;},snapshot:()=>state};
}
