'use strict';
const crypto = require('crypto'); const fs = require('fs');
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJsonAtomic(file, value) { const tmp=`${file}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value,null,2),'utf8'); fs.renameSync(tmp,file); }
function valid(claim, now) { return Boolean(claim?.claim_id && claim?.lease_expires_at && new Date(claim.lease_expires_at).getTime()>now.getTime()); }
function lockPath(file){return `${file}.lock`;}
function acquirePlanMutationLock(file,now,leaseMs){const lock={lock_id:crypto.randomUUID(),acquired_at:now.toISOString(),lease_expires_at:new Date(now.getTime()+leaseMs).toISOString()},target=lockPath(file);for(let i=0;i<100;i++){try{fs.writeFileSync(target,JSON.stringify(lock),{flag:'wx'});return lock;}catch(e){if(e.code!=='EEXIST')throw e;try{const prior=readJson(target);if(valid(prior,now)){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);continue;}fs.unlinkSync(target);}catch{}}}return null;}
function releasePlanMutationLock(file,lock){try{if(readJson(lockPath(file)).lock_id===lock.lock_id)fs.unlinkSync(lockPath(file));}catch{}}
function mutatePlan(file,now,leaseMs,fn){const lock=acquirePlanMutationLock(file,now,leaseMs);if(!lock)return{locked:false};try{return{locked:true,value:fn(readJson(file))};}finally{releasePlanMutationLock(file,lock);}}
function claimCampaignSlot(file,id,{now,leaseMs,planLockLeaseMs,isEligible}){const r=mutatePlan(file,now,planLockLeaseMs,p=>{const s=p.slots?.find(x=>x?.slot_id===id);if(!s||!isEligible(s)||valid(s.claim,now))return null;const claim={claim_id:crypto.randomUUID(),claimed_at:now.toISOString(),lease_expires_at:new Date(now.getTime()+leaseMs).toISOString(),attempt_count:(s.attempt_count||0)+1};s.claim=claim;s.attempt_count=claim.attempt_count;writeJsonAtomic(file,p);return{slot:{...s,claim:{...claim}},claim};});return r.locked?r.value:null;}
function completeClaimedSlot(file,id,claimId,{now,planLockLeaseMs,onComplete}){const r=mutatePlan(file,now,planLockLeaseMs,p=>{const s=p.slots?.find(x=>x?.slot_id===id);if(!s||s.claim?.claim_id!==claimId)return false;onComplete(s);delete s.claim;writeJsonAtomic(file,p);return true;});return r.locked&&r.value===true;}
module.exports={acquirePlanMutationLock,releasePlanMutationLock,mutatePlan,claimCampaignSlot,completeClaimedSlot};
