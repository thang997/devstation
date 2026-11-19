/**
 * File HTML độc lập (không cần mạng) để xem một sơ đồ SVG lớn: cuộn = zoom quanh con trỏ (đổi viewBox),
 * kéo = di chuyển, double-click chỗ trống = vừa khung, ô tìm node (↑/↓ Enter → nhảy tới), rê/bấm node
 * tô sáng các cạnh nối với nó. Dùng chung cho sơ đồ ER (DB) và sơ đồ phụ thuộc module (Git).
 *
 * Quy ước trong `svg`: node là `<g class="t" data-n="<tên>" data-b="x,y,w,h">` (toạ độ theo viewBox),
 * cạnh là `<path class="e" data-f="<từ>" data-t="<tới>">`; khung tiêu đề node có class `hd`.
 */
export interface ViewerPal { bg: string; box: string; head: string; line: string; fg: string; muted: string; primary: string }

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function viewerHtml(o: { title: string; heading: string; svg: string; pal: ViewerPal; find: string; fit: string; help: string }): string {
  const { pal } = o;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${x(o.title)}</title><style>
html,body{margin:0;height:100%;overflow:hidden;background:${pal.bg};color:${pal.fg};font:13px system-ui,sans-serif}
#v{position:fixed;inset:0;cursor:grab}#v.drag{cursor:grabbing}#v svg{display:block;user-select:none}
#bar{position:fixed;top:10px;left:10px;display:flex;gap:6px;align-items:center;background:${pal.box};border:1px solid ${pal.line};padding:6px 8px;z-index:2}
#bar input{background:${pal.bg};color:${pal.fg};border:1px solid ${pal.line};padding:3px 6px;width:200px}
#bar button{background:${pal.head};color:${pal.fg};border:1px solid ${pal.line};padding:3px 10px;cursor:pointer}
#bar span{color:${pal.muted};font-size:12px}#sug{position:absolute;top:100%;left:8px;background:${pal.box};border:1px solid ${pal.line};max-height:280px;overflow:auto;min-width:200px}
#sug div{padding:4px 8px;cursor:pointer;font-family:Consolas,monospace}#sug div:hover,#sug div.a{background:${pal.head}}
svg.hl .e{stroke-opacity:.12}svg.hl .e.on{stroke:${pal.primary};stroke-opacity:1;stroke-width:2}svg.hl .t{opacity:.35}svg.hl .t.on{opacity:1}
.t.sel .hd,.t.sel>rect:first-child{stroke:${pal.primary};stroke-width:2}.t{cursor:pointer}
</style></head><body><div id="v">${o.svg}</div>
<div id="bar"><b>${x(o.heading)}</b><input id="q" placeholder="${x(o.find)}" autocomplete="off"><button id="fit">${x(o.fit)}</button><button id="zi">＋</button><button id="zo">－</button><span id="z"></span><span>${x(o.help)}</span><div id="sug" hidden></div></div>
<script>
const box=document.getElementById('v'),svg=box.querySelector('svg'),vb=svg.viewBox.baseVal,full={x:vb.x,y:vb.y,w:vb.width,h:vb.height};
const zl=document.getElementById('z');
function show(){zl.textContent=Math.round(full.w/vb.width*100)+'%'}
function setVb(x,y,w,h){vb.x=x;vb.y=y;vb.width=w;vb.height=h;show()}
function fit(){setVb(full.x,full.y,full.w,full.h)}
function pt(cx,cy){const p=new DOMPoint(cx,cy).matrixTransform(svg.getScreenCTM().inverse());return p}
function zoomAt(cx,cy,f){const minW=full.w/80,maxW=full.w*3;const w=Math.min(maxW,Math.max(minW,vb.width*f));f=w/vb.width;const p=pt(cx,cy);setVb(p.x-(p.x-vb.x)*f,p.y-(p.y-vb.y)*f,vb.width*f,vb.height*f)}
box.addEventListener('wheel',e=>{e.preventDefault();zoomAt(e.clientX,e.clientY,Math.exp(e.deltaY*0.0015))},{passive:false});
let d=null;
box.addEventListener('mousedown',e=>{if(e.button!==0)return;d={sx:e.clientX,sy:e.clientY,x:vb.x,y:vb.y,k:svg.getScreenCTM().a,m:0};box.classList.add('drag')});
addEventListener('mousemove',e=>{if(!d)return;const dx=e.clientX-d.sx,dy=e.clientY-d.sy;d.m=Math.max(d.m,Math.abs(dx)+Math.abs(dy));setVb(d.x-dx/d.k,d.y-dy/d.k,vb.width,vb.height)});
addEventListener('mouseup',()=>{setTimeout(()=>{d=null},0);box.classList.remove('drag')});
box.addEventListener('dblclick',e=>{if(!e.target.closest('.t'))fit()});
document.getElementById('fit').onclick=fit;
document.getElementById('zi').onclick=()=>{const r=box.getBoundingClientRect();zoomAt(r.width/2,r.height/2,1/1.3)};
document.getElementById('zo').onclick=()=>{const r=box.getBoundingClientRect();zoomAt(r.width/2,r.height/2,1.3)};
const tables=[...svg.querySelectorAll('.t')],edges=[...svg.querySelectorAll('.e')];
let sel=null;
function light(n){svg.classList.toggle('hl',!!n);const rel=new Set(n?[n]:[]);for(const e of edges){const on=!!n&&(e.dataset.f===n||e.dataset.t===n);e.classList.toggle('on',on);if(on){rel.add(e.dataset.f);rel.add(e.dataset.t);e.parentNode.appendChild(e)}}for(const t of tables)t.classList.toggle('on',rel.has(t.dataset.n))}
for(const t of tables){t.addEventListener('mouseenter',()=>{if(!d)light(t.dataset.n)});t.addEventListener('mouseleave',()=>{if(!d)light(sel)});
t.addEventListener('click',()=>{if(d&&d.m>4)return;if(sel)tables.find(x=>x.dataset.n===sel)?.classList.remove('sel');sel=sel===t.dataset.n?null:t.dataset.n;if(sel)t.classList.add('sel');light(sel)})}
box.addEventListener('click',e=>{if(d&&d.m>4)return;if(!e.target.closest('.t')&&sel){tables.find(x=>x.dataset.n===sel)?.classList.remove('sel');sel=null;light(null)}});
function centerOn(n){const t=tables.find(x=>x.dataset.n===n);if(!t)return;const [bx,by,bw,bh]=t.dataset.b.split(",").map(Number);const cx=bx+bw/2,cy=by+bh/2;
const w=Math.max(Math.min(full.w,bw*5),Math.min(full.w,1000)),h=w*vb.height/vb.width;setVb(cx-w/2,cy-h/2,w,h);
if(sel)tables.find(x=>x.dataset.n===sel)?.classList.remove('sel');sel=n;t.classList.add('sel');light(n)}
const q=document.getElementById('q'),sug=document.getElementById('sug');let act=0,hits=[];
function render(){sug.innerHTML='';hits.forEach((n,i)=>{const el=document.createElement('div');el.textContent=n;if(i===act)el.className='a';el.onmousedown=ev=>{ev.preventDefault();pick(n)};sug.appendChild(el)});sug.hidden=!hits.length}
function pick(n){centerOn(n);q.value='';hits=[];render();q.blur()}
q.addEventListener('input',()=>{const s=q.value.trim().toLowerCase();act=0;hits=s?tables.map(t=>t.dataset.n).filter(n=>n.toLowerCase().includes(s)).slice(0,15):[];render()});
q.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){act=Math.min(act+1,hits.length-1);render();e.preventDefault()}else if(e.key==='ArrowUp'){act=Math.max(act-1,0);render();e.preventDefault()}else if(e.key==='Enter'&&hits[act])pick(hits[act]);else if(e.key==='Escape'){q.value='';hits=[];render()}});
q.addEventListener('mousedown',e=>e.stopPropagation());document.getElementById('bar').addEventListener('mousedown',e=>e.stopPropagation());
show();
</script></body></html>`;
}
