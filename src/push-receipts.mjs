import crypto from 'node:crypto';
import {now} from './store.mjs';

const networkCodes=new Set(['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EPIPE','EHOSTUNREACH','ENETUNREACH','ABORT_ERR']);
const states=new Set(['accepted','rejected','expired','unconfirmed']);

// Never retain provider response bodies, headers, endpoints, or error messages.
export function pushOutcome(value, failed=false) {
 const status=value?.statusCode;
 const httpStatus=Number.isInteger(status)&&status>=100&&status<=599?status:null;
 const state=[404,410].includes(httpStatus)?'expired':httpStatus>=300?'rejected':!failed&&httpStatus>=200?'accepted':'unconfirmed';
 return {state,httpStatus,errorCode:state==='unconfirmed'?(networkCodes.has(value?.code)?value.code:failed?'PUSH_ERROR':'NO_STATUS'):null};
}

export function startPushReceipt(store, request, targeted) {
 const receipt={schema:1,id:crypto.randomUUID(),attentionVersion:request.userAttentionVersion||1,phase:'sending',startedAt:now(),completedAt:null,targeted,
  counts:{accepted:0,rejected:0,expired:0,unconfirmed:0},httpStatuses:{},errorCodes:{},cleanupFailures:0,deliveryConfirmed:false};
 const persist=(initial=false)=>{
  try {
   const current=store.get(request.id);
   if(!current||!initial&&current.webPushReceipt?.id!==receipt.id)return;
   current.webPushReceipt=receipt;store.put(current);
  } catch {
   console.error(JSON.stringify({event:'push_receipt_storage_failed',requestId:request.id,phase:receipt.phase}));
  }
 };
 persist(true);
 return results=>{
  for(const result of results) {
   const outcome=result.status==='fulfilled'&&states.has(result.value?.state)?result.value:{state:'unconfirmed',httpStatus:null,errorCode:'INTERNAL_FAILURE'};
   receipt.counts[outcome.state]++;
   if(outcome.httpStatus)receipt.httpStatuses[outcome.httpStatus]=(receipt.httpStatuses[outcome.httpStatus]||0)+1;
   if(outcome.errorCode)receipt.errorCodes[outcome.errorCode]=(receipt.errorCodes[outcome.errorCode]||0)+1;
   if(outcome.cleanupFailed)receipt.cleanupFailures++;
  }
  receipt.phase='completed';receipt.completedAt=now();persist();
  console.info(JSON.stringify({event:'push_receipt',requestId:request.id,...receipt}));
 };
}
