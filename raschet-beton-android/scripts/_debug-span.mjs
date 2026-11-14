import puppeteer from 'puppeteer-core';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const browser = await puppeteer.launch({executablePath:'/snap/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page = await browser.newPage();
await page.setViewport({width:390,height:844,deviceScaleFactor:2,hasTouch:true,isMobile:true});
page.on('pageerror', e=>console.log('ERR',e.message));
await page.goto('http://127.0.0.1:4173/',{waitUntil:'networkidle0'});
await page.evaluate(async()=>{localStorage.clear();const regs=(await navigator.serviceWorker?.getRegistrations?.())??[];await Promise.all(regs.map(r=>r.unregister()));const keys=await caches.keys();await Promise.all(keys.map(k=>caches.delete(k)));});
await page.reload({waitUntil:'networkidle0'});await sleep(400);
await page.click('.newcalc');await sleep(280);
const cards=await page.$$('.typecard');await cards[1].click();await sleep(450);
const box=await page.$eval('.plan-canvas',el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};});
const tap=async(x,y)=>{await page.mouse.click(x,y);await sleep(140);};
await tap(box.x+100,box.y+200);await tap(box.x+300,box.y+205);await tap(box.x+300,box.y+400);await tap(box.x+100,box.y+200);await sleep(450);
// enter first face 4000
const typeFace=async(value)=>{const cs=await page.evaluate(()=>[...document.querySelectorAll('.chip')].map((c,i)=>{const r=c.getBoundingClientRect();return{i,muted:c.classList.contains('chip--muted'),y:r.y+r.height/2};}));const b=await page.$eval('.plan-canvas',el=>{const r=el.getBoundingClientRect();return{y:r.y,h:r.height};});const cy=b.y+b.h/2;const pool=cs.filter(c=>!c.muted);const half=pool.filter(c=>c.y>cy);const pick=(half.length?half:pool).sort((a,b)=>b.y-a.y)[0];const chip=await page.$$('.chip');const bb=await chip[pick.i].boundingBox();await page.mouse.click(bb.x+bb.width/2,bb.y+bb.height/2);await sleep(200);await page.keyboard.type(String(value));await page.keyboard.press('Enter');await sleep(420);};
await typeFace(4000);
const out = await page.evaluate(()=>{
  const canvas=document.querySelector('.plan-canvas canvas');
  if(!canvas) return {err:'no canvas'};
  const ctx=canvas.getContext('2d');
  const img=ctx.getImageData(0,0,canvas.width,canvas.height);
  const rows=[];
  for(const frac of [0.25,0.4,0.5,0.6,0.75]){
    const y=Math.round(canvas.height*frac);
    let min=Infinity,max=-1;
    for(let x=0;x<canvas.width;x++){
      const i=(y*canvas.width+x)*4;
      const [r,g,b,a]=[img.data[i],img.data[i+1],img.data[i+2],img.data[i+3]];
      if(a>200 && r>230 && g>110 && g<170 && b>50 && b<110){if(x<min)min=x;if(x>max)max=x;}
    }
    rows.push({frac,min:Number.isFinite(min)?min:null,max:max>=0?max:null});
  }
  return {w:canvas.width,h:canvas.height,cw:canvas.clientWidth,rows};
});
console.log(JSON.stringify(out));
await browser.close();
