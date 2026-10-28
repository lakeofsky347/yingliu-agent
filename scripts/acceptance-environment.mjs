import {join} from 'node:path';
const PHASES=new Set(['package','native','models','film','editor']);
/** Every phase gets its own project registry; repeated launches within that phase retain the same directory. */
export function stageEnvironment(temporary,phase,base={}){
  if(!PHASES.has(phase))throw new Error('Unknown acceptance phase');
  return {...base,YINGLIU_PROJECTS:join(temporary,'projects',phase),YINGLIU_ACCEPTANCE_OUTPUT:join(temporary,'raw',phase)};
}
