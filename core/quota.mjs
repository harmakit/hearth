import { createHash } from 'node:crypto';

export const quotaRuntimes = ['codex'];
export const quotaPollInterval = 60_000;

export function quotaThreshold(value) {
  if(value===undefined || value===null)return null;
  if(!Number.isInteger(value) || value<0 || value>100)throw new Error('Укажите порог недельного остатка от 0 до 100%.');
  return value;
}

export function codexWeeklyQuota(response) {
  const accountKey=typeof response?.accountId==='string' && response.accountId
    ? createHash('sha256').update(response.accountId).digest('hex') : undefined;
  const fallback=response?.rateLimits;
  const bucket=response?.rateLimitsByLimitId?.codex ??
    (!fallback?.limitId || fallback.limitId==='codex'?fallback:undefined);
  const windows=[bucket?.primary,bucket?.secondary].filter(window=>
    window?.windowDurationMins===7*24*60 && Number.isInteger(window.usedPercent) && window.usedPercent>=0);
  const window=windows.sort((left,right)=>right.usedPercent-left.usedPercent)[0];
  const identity=accountKey?{accountKey}:{};
  if(!window)return {status:'unknown',...identity};
  const seconds=window.resetsAt;
  const reset=Number.isSafeInteger(seconds)&&seconds>0&&seconds<8_640_000_000_000 ? new Date(seconds*1000).toISOString() : undefined;
  return {status:'known',remainingPercent:Math.max(0,100-window.usedPercent),...(reset?{resetAt:reset}:{}),...identity};
}

export function recordWeeklyQuota(runtime,previous,observed,now) {
  if(!quotaRuntimes.includes(runtime))return {status:'unsupported'};
  const checkedAt=now.toISOString();
  const accountKey=typeof observed?.accountKey==='string' && /^[a-f0-9]{64}$/.test(observed.accountKey) ? observed.accountKey : undefined;
  const differentAccount=accountKey && previous?.accountKey && accountKey!==previous.accountKey;
  const old=differentAccount?undefined:previous?.lastKnown;
  if(observed?.status==='known' && Number.isInteger(observed.remainingPercent) && observed.remainingPercent>=0 && observed.remainingPercent<=100){
    const resetAt=Number.isFinite(Date.parse(observed.resetAt))?new Date(observed.resetAt).toISOString():undefined;
    return {status:'known',accountKey:accountKey??previous?.accountKey,checkedAt,
      lastKnown:{remainingPercent:observed.remainingPercent,resetAt,observedAt:checkedAt}};
  }
  return {status:'unknown',accountKey:accountKey??previous?.accountKey,checkedAt,lastKnown:old};
}

export function quotaPause({threshold,runtimes,observations,scope,now}) {
  if(threshold==null)return undefined;
  for(const runtime of runtimes){
    const record=observations[runtime], known=record?.lastKnown;
    if(!known || known.remainingPercent>threshold)continue;
    return {scope,runtime,threshold,...known,stale:record.status!=='known' ||
      now.getTime()-Date.parse(known.observedAt)>2*quotaPollInterval};
  }
}

export function visibleWeeklyQuota(runtime,record,now) {
  if(!quotaRuntimes.includes(runtime))return {status:'unsupported'};
  if(!record)return {status:'unknown'};
  const {accountKey,...rest}=record;
  const stale=record.status==='known' && now.getTime()-Date.parse(record.checkedAt)>2*quotaPollInterval;
  return {...rest,status:stale?'unknown':record.status};
}
