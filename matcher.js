/* FreeRoom server-side matcher + email sender.
   Runs on a schedule (GitHub Actions) so offers are created/expired and emails go out even when
   nobody has the app open. It mirrors runMatcherTick() in the web app and shares its lock document,
   so open browser tabs and this script never act at the same time. */
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const TZ = 'Asia/Jerusalem';
const DRY = process.env.DRY_RUN === '1';
const TICKS = Number(process.env.TICKS || 1);
const TICK_GAP_MS = Number(process.env.TICK_GAP_SECONDS || 60) * 1000;

function initAdmin(){
  const projectId = process.env.FIREBASE_PROJECT_ID || 'freeroom-ced60';
  if(process.env.FIREBASE_SERVICE_ACCOUNT){
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)), projectId });
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
  }
  return admin.firestore();
}

/* ---------- time helpers (all clinic times are Israel local time) ---------- */
function tzOffsetMs(utcMs){
  const f = new Intl.DateTimeFormat('en-US', {timeZone:TZ, hourCycle:'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'});
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x=>[x.type, x.value]));
  return Date.UTC(+p.year, +p.month-1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
function ilToMs(date, time){ // 'YYYY-MM-DD','HH:MM' in Israel -> epoch ms
  const [y,m,d] = date.split('-').map(Number); const [hh,mm] = time.split(':').map(Number);
  let guess = Date.UTC(y,m-1,d,hh,mm,0);
  guess -= tzOffsetMs(guess);
  guess = Date.UTC(y,m-1,d,hh,mm,0) - tzOffsetMs(guess);
  return guess;
}
function ilDate(ms){ const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms)).map(x=>[x.type,x.value])); return p.year+'-'+p.month+'-'+p.day; }
function ilTime(ms){ const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(ms)).map(x=>[x.type,x.value])); return p.hour+':'+p.minute; }
function addDaysStr(dateStr, n){ const d = new Date(dateStr+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function fmtDateShort(dateStr){ if(!dateStr) return ''; const [y,m,d] = dateStr.split('-').map(Number); return d+'.'+m; }
function timeToMin(t){ const [h,m] = t.split(':').map(Number); return h*60+m; }
function hoursBetween(a,b){ return (timeToMin(b)-timeToMin(a))/60; }
function slotEndMs(date, end){ return ilToMs(date, end); }
function addActiveHours(fromMs, hours, startH=7, endH=21){
  let cursor = fromMs, remaining = hours*3600000;
  const pad = n=>String(n).padStart(2,'0');
  for(let i=0;i<30;i++){
    const day = ilDate(cursor);
    const ws = ilToMs(day, pad(startH)+':00'), we = ilToMs(day, pad(endH)+':00');
    if(cursor < ws) cursor = ws;
    if(cursor >= we){ cursor = ilToMs(addDaysStr(day,1), pad(startH)+':00'); continue; }
    const avail = we - cursor;
    if(remaining <= avail) return cursor + remaining;
    remaining -= avail; cursor = ilToMs(addDaysStr(day,1), pad(startH)+':00');
  }
  return fromMs + hours*3600000;
}

/* ---------- fairness (same rules as the app) ---------- */
function makeFairness(data){
  const weeklyHours = id => Math.max(data.schedule.filter(s=>s.staffId===id).reduce((a,s)=>a+hoursBetween(s.start,s.end),0), 1);
  const cutoff = addDaysStr(ilDate(Date.now()), -60);
  const recentScore = id => data.releases.filter(r=>r.releasedBy===id && r.date>=cutoff).reduce((a,r)=>a+(r.pointsAwarded||0),0);
  const daysSince = id => {
    let latest = null;
    data.allocations.forEach(a=>{ if(a.staffId===id){ const d=a.createdAt||a.dateFrom; if(!latest||d>latest) latest=d; } });
    if(!latest) return Infinity;
    return Math.floor((Date.now()-new Date(latest).getTime())/86400000);
  };
  return (a,b)=>{
    const wa = daysSince(a.staffId), wb = daysSince(b.staffId);
    if(wa!==wb) return wb-wa;
    const sa = recentScore(a.staffId)/weeklyHours(a.staffId), sb = recentScore(b.staffId)/weeklyHours(b.staffId);
    if(sb!==sa) return sb-sa;
    return new Date(a.createdAt)-new Date(b.createdAt);
  };
}

/* ---------- email ---------- */
let transporter = null;
function mailer(){
  if(transporter !== null) return transporter;
  if(process.env.SMTP_USER && process.env.SMTP_PASS){
    transporter = nodemailer.createTransport({ service:'gmail', auth:{ user:process.env.SMTP_USER, pass:process.env.SMTP_PASS } });
  } else transporter = false;
  return transporter;
}
const APP_URL = process.env.APP_URL || 'https://freeroom-ced60.web.app';
async function sendMail(to, subject, text){
  const t = mailer();
  if(!t){ console.log('  (email not configured — skipped)', to, subject); return false; }
  if(DRY){ console.log('  [dry-run] would email', to, subject); return true; }
  try{
    await t.sendMail({ from:'"FreeRoom" <'+process.env.SMTP_USER+'>', to, subject, text: text+'\n\nלפתיחת האפליקציה: '+APP_URL });
    return true;
  }catch(e){ console.warn('  email failed', to, e.message); return false; }
}
const EMAIL_TYPES = { 'offer':'נמצא עבורך חדר — נדרש אישור', 'offer-reminder':'תזכורת: ההצעה לחדר עומדת לפוג', 'co-release':'שאלה לגבי פינוי חדר משותף', 'manager-approval-needed':'בקשה הממתינה לאישור מנהל/ת' };

/* ---------- one clinic, one tick ---------- */
async function tickClinic(db, clinicId){
  const base = db.collection('clinics').doc(clinicId);
  const col = n => base.collection(n);
  const load = async n => (await col(n).get()).docs.map(d=>({id:d.id, ref:d.ref, ...d.data()}));
  const log = (action, details)=> DRY? null : col('auditLog').add({ ts:new Date().toISOString(), actorId:null, actorName:'שרת (אוטומטי)', action, details:details||{} });
  const notify = async (staffId, text, type)=>{
    if(DRY){ console.log('  [dry-run] notify', staffId, type, text); return; }
    await col('notifications').add({ forStaffId:staffId, text, type:type||'info', createdAt:new Date().toISOString(), read:false, emailed: !EMAIL_TYPES[type] });
  };
  const upd = async (ref, patch)=>{ if(DRY){ console.log('  [dry-run] update', ref.path, JSON.stringify(patch)); return; } await ref.update(patch); };

  // shared lock with the browser tabs
  const lockRef = base.collection('system').doc('matcherLock');
  if(!DRY){
    const got = await db.runTransaction(async tx=>{
      const s = await tx.get(lockRef); const d = s.exists? s.data() : null;
      const free = !d || !d.expiresAt || new Date(d.expiresAt).getTime() <= Date.now() || d.holder==='server';
      if(!free) return false;
      tx.set(lockRef, {holder:'server', expiresAt:new Date(Date.now()+30000).toISOString()}, {merge:true});
      return true;
    });
    if(!got){ console.log('['+clinicId+'] a browser tab holds the lock — skipping this tick'); return; }
  }

  const now = Date.now();
  // Reads are the scarce free-tier resource (this runs every few minutes), so everything beyond the
  // few small queries below is loaded lazily, only when there is actually something to do.
  const staffCache = {};
  const getStaff = async id=>{ if(!(id in staffCache)){ const d = await col('staff').doc(id).get(); staffCache[id] = d.exists? {id, ...d.data()} : null; } return staffCache[id]; };
  const offers = (await col('offers').where('status','==','OFFERED').get()).docs.map(d=>({id:d.id, ref:d.ref, ...d.data()}));

  // 1. expire / remind offers
  for(const o of offers){
    const exp = new Date(o.expiresAt).getTime();
    if(exp > now && !o.reminderSent && exp-now <= 3*3600000){
      await upd(o.ref, {reminderSent:true});
      await notify(o.staffId, 'תזכורת: ההצעה לחדר '+o.roomName+' בתאריך '+fmtDateShort(o.date)+' ('+o.start+'–'+o.end+') עדיין ממתינה לאישור שלך ועומדת לפוג בקרוב.', 'offer-reminder');
    }
    if(exp <= now){
      await upd(o.ref, {status:'EXPIRED'});
      // release back to AVAILABLE (excluding this requester) and request back to WAITING
      const relRef = col('releases').doc(o.releaseId); const relSnap = await relRef.get();
      if(relSnap.exists && relSnap.data().status==='OFFERED'){
        const ex = relSnap.data().excludedStaffIds||[];
        await upd(relRef, {status:'AVAILABLE', excludedStaffIds: o.staffId? [...ex, o.staffId] : ex});
      }
      const others = (await col('offers').where('requestId','==',o.requestId).where('status','==','OFFERED').get()).docs.filter(d=>d.id!==o.id);
      if(others.length===0){
        const rr = col('requests').doc(o.requestId); const rs = await rr.get();
        if(rs.exists && rs.data().status==='OFFERED') await upd(rr, {status:'WAITING'});
      }
      await notify(o.staffId, 'ההצעה עבור חדר '+o.roomName+' בתאריך '+fmtDateShort(o.date)+' פגה. החדר מוצע כעת למועמד הבא בתור.', 'expired');
      await log('offer_expired', {offerId:o.id, roomName:o.roomName, date:o.date});
    }
  }

  // 2. fresh state
  let fairnessCompare = null;
  const getFairness = async ()=>{
    if(!fairnessCompare) fairnessCompare = makeFairness({ schedule: await load('schedule'), releases: await load('releases'), allocations: await load('allocations') });
    return fairnessCompare;
  };
  let releases = (await col('releases').where('status','==','AVAILABLE').get()).docs.map(d=>({id:d.id, ref:d.ref, ...d.data()}));
  let waiting = (await col('requests').where('status','==','WAITING').get()).docs.map(d=>({id:d.id, ref:d.ref, ...d.data()}));

  // 2b. close anything already in the past
  for(const r of releases.filter(r=>slotEndMs(r.date,r.end) <= now)) await upd(r.ref, {status:'EXPIRED'});
  releases = releases.filter(r=>slotEndMs(r.date,r.end) > now);
  for(const r of waiting.filter(r=>slotEndMs(r.dateTo||r.dateFrom, r.end) <= now)){
    await upd(r.ref, {status:'EXPIRED'});
    await notify(r.staffId, 'הבקשה שלך לחדר ב-'+fmtDateShort(r.dateFrom)+' ('+r.start+'–'+r.end+') נסגרה כי המועד עבר ולא נמצא חדר.', 'expired');
  }
  waiting = waiting.filter(r=>slotEndMs(r.dateTo||r.dateFrom, r.end) > now);
  const requests = waiting.filter(r=>!r.needsManagerMatch);

  // 3. match
  for(const rel of releases){
    const excluded = rel.excludedStaffIds||[];
    const candidates = requests.filter(r=> r.status==='WAITING' && r.staffId!==rel.releasedBy && !excluded.includes(r.staffId) &&
      r.dateFrom===rel.date && r.dateTo===rel.date && timeToMin(r.start)>=timeToMin(rel.start) && timeToMin(r.end)<=timeToMin(rel.end));
    if(!candidates.length) continue;
    const active = await col('offers').where('releaseId','==',rel.id).where('status','==','OFFERED').get();
    if(!active.empty) continue;
    if(candidates.length>1) candidates.sort(await getFairness());
    const top = candidates[0];
    const expMs = Math.min(addActiveHours(Date.now(), 8), slotEndMs(rel.date, top.end));
    const expDay = ilDate(expMs)===ilDate(Date.now())? 'היום' : 'ב-'+fmtDateShort(ilDate(expMs));
    console.log('['+clinicId+'] offer:', rel.roomName, rel.date, top.start+'-'+top.end, '->', top.staffName);
    if(!DRY){
      await col('offers').add({ releaseId:rel.id, requestId:top.id, roomId:rel.roomId, roomName:rel.roomName, date:rel.date, start:top.start, end:top.end,
        staffId:top.staffId, staffName:((await getStaff(top.staffId))||{}).name||'', releasedBy:rel.releasedBy||null, releasedByName:rel.releasedByName||'',
        status:'OFFERED', expiresAt:new Date(expMs).toISOString(), createdAt:new Date().toISOString(), reminderSent:(expMs-Date.now())<=3*3600000 });
      await rel.ref.update({status:'OFFERED'}); await top.ref.update({status:'OFFERED'});
    }
    top.status = 'OFFERED';
    await notify(top.staffId, 'נמצא עבורך חדר '+rel.roomName+' בתאריך '+fmtDateShort(rel.date)+' בין '+top.start+'–'+top.end+'. יש לך עד '+expDay+' ב-'+ilTime(expMs)+' לאשר.', 'offer');
    await log('offer_created', {roomName:rel.roomName, date:rel.date, staffName:top.staffName});
  }

  // 4. email the action-needed notifications that haven't been emailed yet. The app and this script
  // both create them with emailed:false, so one cheap equality query finds exactly the pending ones.
  const pend = (await col('notifications').where('emailed','==',false).get()).docs.map(d=>({id:d.id, ref:d.ref, ...d.data()}));
  for(const n of pend){
    if(!EMAIL_TYPES[n.type]){ await upd(n.ref, {emailed:true}); continue; }
    if(Date.now()-new Date(n.createdAt).getTime() > 2*86400000){ await upd(n.ref, {emailed:true, emailSkipped:'too-old'}); continue; }
    const st = await getStaff(n.forStaffId);
    if(!st || !st.email) continue; // keep pending: sent as soon as the person saves an address (within 2 days)
    const ok = await sendMail(st.email, EMAIL_TYPES[n.type], n.text);
    if(ok) await upd(n.ref, {emailed:true});
  }
}

async function main(){
  const db = initAdmin();
  const clinics = process.env.CLINIC_IDS ? process.env.CLINIC_IDS.split(',') : (await db.collection('clinics').get()).docs.map(d=>d.id);
  for(let i=0;i<TICKS;i++){
    for(const c of clinics){ try{ await tickClinic(db, c); }catch(e){ console.error('['+c+'] tick failed:', e); } }
    if(i<TICKS-1) await new Promise(r=>setTimeout(r, TICK_GAP_MS));
  }
  console.log('done');
}
main().then(()=>process.exit(0)).catch(e=>{ console.error(e); process.exit(1); });
