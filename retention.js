export const RECOVERY_WINDOW_MS=48*60*60*1000;
export function isRecoverable(clearedAt,now=Date.now()){
  if(clearedAt==null)return false;
  const time=typeof clearedAt==='number'?clearedAt:Date.parse(clearedAt);
  return Number.isFinite(time)&&now<time+RECOVERY_WINDOW_MS;
}
